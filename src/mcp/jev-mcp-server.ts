/**
 * MCP server (stdio) that exposes jev skill routing as tools the agent may choose to call.
 * Unlike the hook, nothing forces the call: this arm measures whether the agent knows it needs a router.
 *   route_skill(prompt)  → jev's best skill, confidence, top-3, and the SKILL.md path; logs a Decision like the hook
 *   load_skill(id)       → the SKILL.md body (the analogue of Claude Code's Skill tool)
 * Env: JEVROUTE_UNIVERSE, JEVROUTE_DECISION_DIR, JEVROUTE_CONFIG (same as the hook).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { loadUniverse, universeHash, skillBody } from "../skills.ts";
import { buildRouteRequest, callJev, topK, NONE } from "../jev.ts";
import { applyPolicy } from "../hook/route-hook.ts";
import type { Decision } from "../types.ts";

const cfg = loadConfig();
const universe = loadUniverse();
const byId = new Map(universe.skills.map(s => [s.id, s]));
const policy: Decision["policy"] = { threshold: cfg.policy.confidence_threshold, fallback: cfg.policy.fallback, fallbackTopK: cfg.policy.fallback_top_k, routeNoneMinProb: cfg.policy.route_none_min_prob };
let calls = 0;

function logDecision(d: Decision): void {
  const dir = process.env.JEVROUTE_DECISION_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${Date.now()}-mcp-${String(calls).padStart(2, "0")}.json`), JSON.stringify(d, null, 2));
}

const server = new McpServer({ name: "jevroute", version: "0.1.0" });

server.registerTool("route_skill", {
  title: "Find the specialised skill for a task",
  description: `This environment has ${universe.skills.length} specialised skills (house conventions, tool-specific workflows, file-format rules) that are NOT listed in your context. Given the user's request, this tool asks a fast decision model which skill applies and returns its id, confidence, top-3 candidates and the path to its SKILL.md. Call load_skill(id) or read the path to get the guidance. Returns "none" when no skill applies.`,
  inputSchema: { prompt: z.string().describe("The user's request, verbatim or summarised") },
}, async ({ prompt }) => {
  calls++;
  const request = buildRouteRequest(prompt, universe.skills);
  const decision: Decision = {
    version: 1, arm: "jev", sessionId: null, promptId: null, prompt, universeHash: universeHash(universe), request, response: null, rawResponse: null,
    model: null, jevInputTokens: null, latencyMs: 0, error: null, policy, action: "error_passthrough", injected: [], injectedChars: 0,
    timestamp: new Date().toISOString(), via: "direct", injectMode: "pointer",
  };
  try {
    const r = await callJev(request);
    decision.response = r.response; decision.rawResponse = r.raw; decision.model = r.model; decision.jevInputTokens = r.inputTokens;
    decision.latencyMs = Math.round(r.latencyMs); decision.via = r.via;
    const { action, injected } = applyPolicy(r.response, policy, new Set(byId.keys()));
    decision.action = action; decision.injected = injected;
    logDecision(decision);
    const top3 = topK(r.response.probabilities, 3, [NONE]).map(id => ({ id, p: Number((r.response.probabilities[id] ?? 0).toFixed(3)), path: byId.get(id)?.path }));
    const best = action === "inject_skill" ? injected[0] : null;
    const text = best
      ? `skill: ${best}\nconfidence: ${r.response.confidence.toFixed(2)}\npath: ${byId.get(best)!.path}\ndescription: ${byId.get(best)!.description}\ntop3: ${JSON.stringify(top3)}`
      : action === "inject_none" ? `skill: none (no specialised skill applies; P(none)=${(r.response.probabilities[NONE] ?? 0).toFixed(2)})`
      : `skill: uncertain (confidence ${r.response.confidence.toFixed(2)}); candidates: ${JSON.stringify(top3)}`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    decision.error = err instanceof Error ? err.message : String(err); logDecision(decision);
    return { content: [{ type: "text", text: `routing unavailable: ${decision.error}` }], isError: true };
  }
});

server.registerTool("load_skill", {
  title: "Load a skill's instructions",
  description: "Return the full SKILL.md for a skill id returned by route_skill. Follow it for the current task.",
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  const s = byId.get(id);
  if (!s) return { content: [{ type: "text", text: `unknown skill id ${id}. Known: ${[...byId.keys()].join(", ")}` }], isError: true };
  return { content: [{ type: "text", text: `<skill id="${s.id}" source="${s.path}">\n${skillBody(s)}\n</skill>` }] };
});

await server.connect(new StdioServerTransport());
