import { readFileSync } from "node:fs";
import type { ParsedTranscript, UsageTotals } from "./types.ts";

/** Parse a `claude -p --output-format stream-json --verbose` transcript. */
export function parseTranscript(path: string): ParsedTranscript {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const usage: UsageTotals = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0, contextProcessed: 0, firstCallContext: 0, modelCalls: 0 };
  const out: ParsedTranscript = {
    skillToolCalls: [], filesWritten: [], toolCalls: [], usage, totalCostUsd: null, durationMs: null, numTurns: null,
    resultText: null, isError: false, sessionId: null,
  };
  const seenMessageIds = new Set<string>();
  for (const line of lines) {
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.session_id && !out.sessionId) out.sessionId = e.session_id;
    if (e.type === "assistant" && e.message) {
      const msg = e.message;
      for (const c of msg.content ?? []) {
        if (c?.type === "tool_use") {
          out.toolCalls.push({ name: c.name, input: c.input });
          if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(c.name)) {
            const fp = c.input?.file_path ?? c.input?.notebook_path;
            if (typeof fp === "string") out.filesWritten.push(fp);
          }
          if (c.name === "Skill") {
            const id = c.input?.skill ?? c.input?.command ?? c.input?.name;
            if (typeof id === "string") out.skillToolCalls.push(normalizeSkillId(id));
          }
        }
      }
      // stream-json may emit several assistant events per message (one per content block); count usage once per message id
      const mid = msg.id ?? JSON.stringify(msg.usage);
      if (msg.usage && !seenMessageIds.has(mid)) {
        seenMessageIds.add(mid);
        const u = msg.usage;
        const inp = u.input_tokens ?? 0, cc = u.cache_creation_input_tokens ?? 0, cr = u.cache_read_input_tokens ?? 0;
        usage.input += inp; usage.cacheCreation += cc; usage.cacheRead += cr; usage.output += u.output_tokens ?? 0;
        usage.contextProcessed += inp + cc + cr;
        if (usage.modelCalls === 0) usage.firstCallContext = inp + cc + cr;
        usage.modelCalls += 1;
      }
    } else if (e.type === "result") {
      out.totalCostUsd = e.total_cost_usd ?? null;
      out.durationMs = e.duration_ms ?? null;
      out.numTurns = e.num_turns ?? null;
      out.resultText = typeof e.result === "string" ? e.result : null;
      out.isError = Boolean(e.is_error) || e.subtype !== "success";
      // prefer the authoritative totals when present
      if (e.usage && usage.modelCalls === 0) {
        const u = e.usage;
        usage.input = u.input_tokens ?? 0; usage.cacheCreation = u.cache_creation_input_tokens ?? 0;
        usage.cacheRead = u.cache_read_input_tokens ?? 0; usage.output = u.output_tokens ?? 0;
        usage.contextProcessed = usage.input + usage.cacheCreation + usage.cacheRead;
        usage.firstCallContext = usage.contextProcessed; usage.modelCalls = 1;
      }
    }
  }
  return out;
}

/** Claude Code may name skills "plugin:skill" or "/plugin:skill"; strip a leading slash. */
export function normalizeSkillId(id: string): string {
  return id.replace(/^\//, "").trim().replace(":", "-");
}
