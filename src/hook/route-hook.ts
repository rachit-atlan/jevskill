/**
 * UserPromptSubmit hook for the jev arm.
 * stdin:  Claude Code hook JSON { session_id, prompt_id, prompt, cwd, ... }
 * stdout: { hookSpecificOutput: { hookEventName, additionalContext } }
 * side effect: writes one Decision JSON per call to $JEVROUTE_DECISION_DIR.
 * Graders return numbers; this file applies policy from eval.yml and nothing else.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { loadUniverse, universeHash, skillBody } from "../skills.ts";
import { buildRouteRequest, callJev, topK, NONE } from "../jev.ts";
import type { Decision, JevRouteResponse, SkillInfo } from "../types.ts";

export type Action = Decision["action"];

/** Pure policy: what to inject given a jev answer. Exported so fixtures can test it. */
export function applyPolicy(
  r: JevRouteResponse,
  policy: Decision["policy"],
  known: Set<string>,
): { action: Action; injected: string[] } {
  const pNone = r.probabilities[NONE] ?? (r.choice === NONE ? 1 : 0);
  if (r.choice === NONE || pNone >= policy.routeNoneMinProb) return { action: "inject_none", injected: [] };
  if (r.confidence >= policy.threshold && known.has(r.choice)) return { action: "inject_skill", injected: [r.choice] };
  if (policy.fallback === "none") return { action: "inject_none", injected: [] };
  const k = policy.fallbackTopK > 0 ? policy.fallbackTopK : known.size;
  const cands = topK(r.probabilities, k, [NONE]).filter(id => known.has(id));
  return { action: "inject_listing", injected: cands.length ? cands : [...known] };
}

export function renderSkillInjection(s: SkillInfo): string {
  return [
    `<routed-skill id="${s.id}" source="${s.path}">`,
    `The following skill was selected for this request. Follow it.`,
    ``,
    skillBody(s).trim(),
    `</routed-skill>`,
  ].join("\n");
}

export function renderPointer(s: SkillInfo): string {
  return `<routed-skill id="${s.id}" source="${s.path}">A specialised skill applies to this request: ${s.id}. Read ${s.path} before starting and follow it.</routed-skill>`;
}

export function renderListing(skills: SkillInfo[]): string {
  const rows = skills.map(s => `- ${s.id}: ${s.description}`);
  return [
    `<candidate-skills>`,
    `The router was unsure. These skills may apply; if one clearly fits, follow its guidance by reading its SKILL.md at the listed path.`,
    ...skills.map((s, i) => `${rows[i]}\n  path: ${s.path}`),
    `</candidate-skills>`,
  ].join("\n");
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const input = JSON.parse(await readStdin()) as { session_id?: string; prompt_id?: string; prompt?: string };
  const prompt = input.prompt ?? "";
  const universe = loadUniverse();
  const byId = new Map(universe.skills.map(s => [s.id, s]));
  const policy: Decision["policy"] = {
    threshold: cfg.policy.confidence_threshold, fallback: cfg.policy.fallback,
    fallbackTopK: cfg.policy.fallback_top_k, routeNoneMinProb: cfg.policy.route_none_min_prob,
  };
  const request = buildRouteRequest(prompt, universe.skills);
  const decision: Decision = {
    version: 1, arm: "jev", sessionId: input.session_id ?? null, promptId: input.prompt_id ?? null, prompt,
    universeHash: universeHash(universe), request, response: null, rawResponse: null, model: null,
    jevInputTokens: null, latencyMs: 0, error: null, policy, action: "error_passthrough", injected: [],
    injectedChars: 0, timestamp: new Date().toISOString(),
  };
  let context = "";
  try {
    const r = await callJev(request);
    decision.response = r.response; decision.rawResponse = r.raw; decision.model = r.model;
    decision.jevInputTokens = r.inputTokens; decision.latencyMs = Math.round(r.latencyMs); decision.via = r.via;
    const { action, injected } = applyPolicy(r.response, policy, new Set(byId.keys()));
    decision.action = action; decision.injected = injected;
    const mode = (process.env.JEVROUTE_INJECT_MODE ?? cfg.policy.inject_mode ?? "body") as "body" | "pointer";
    decision.injectMode = mode;
    if (action === "inject_skill") context = mode === "pointer" ? renderPointer(byId.get(injected[0])!) : renderSkillInjection(byId.get(injected[0])!);
    else if (action === "inject_listing") context = renderListing(injected.map(id => byId.get(id)!));
  } catch (err) {
    decision.error = err instanceof Error ? err.message : String(err);
    decision.action = "error_passthrough";
  }
  decision.injectedChars = context.length;
  const dir = process.env.JEVROUTE_DECISION_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${(input.prompt_id ?? "noid").slice(0, 8)}.json`;
    writeFileSync(join(dir, name), JSON.stringify(decision, null, 2));
  }
  const out = context
    ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }
    : {};
  process.stdout.write(JSON.stringify(out));
}

function readStdin(): Promise<string> {
  return new Promise((res, rej) => {
    let s = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => (s += c)); process.stdin.on("end", () => res(s)); process.stdin.on("error", rej);
  });
}

if (import.meta.main) {
  main().catch(err => { process.stderr.write(`route-hook failed: ${err?.stack ?? err}\n`); process.stdout.write("{}"); process.exit(0); });
}
