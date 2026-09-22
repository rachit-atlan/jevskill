/** Outcome graders: final workspace state, not the model's self-report. Code checks first; judge only where needed. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config.ts";
import type { OutcomeCheck, ParsedTranscript, Task } from "../types.ts";

export interface CheckResult { type: string; pass: boolean; hard: boolean; detail: string; score: number }
export interface OutcomeGrade { pass: number; score: number; checks: CheckResult[]; judgeCostUsd: number }

export async function gradeOutcome(task: Task, workspace: string, t: ParsedTranscript, opts: { useJudge: boolean }): Promise<OutcomeGrade> {
  const checks: CheckResult[] = [];
  let judgeCostUsd = 0;
  for (const c of task.checks ?? []) {
    const hard = c.hard ?? true;
    if (c.type === "judge") {
      if (!opts.useJudge) { checks.push({ type: c.type, pass: false, hard: false, detail: "judge skipped", score: 0 }); continue; }
      const j = await runJudge(task, workspace, t, c);
      judgeCostUsd += j.costUsd;
      checks.push({ type: c.type, pass: j.score >= 0.5, hard: c.hard ?? false, detail: j.reason, score: j.score });
      continue;
    }
    const r = runCodeCheck(c, workspace, t);
    checks.push({ ...r, hard, score: r.pass ? 1 : 0 });
  }
  const hardFail = checks.some(c => c.hard && !c.pass);
  const score = checks.length ? checks.reduce((s, c) => s + c.score, 0) / checks.length : (t.isError ? 0 : 1);
  return { pass: checks.length ? (hardFail ? 0 : 1) : (t.isError ? 0 : 1), score, checks, judgeCostUsd };
}

function resolveFiles(workspace: string, path: string): string[] {
  if (!/[*?{]/.test(path)) return existsSync(join(workspace, path)) ? [path] : [];
  return [...new Bun.Glob(path).scanSync({ cwd: workspace, dot: false, onlyFiles: true })].filter(f => !f.startsWith("node_modules/"));
}

export function runCodeCheck(c: OutcomeCheck, workspace: string, t: ParsedTranscript): { type: string; pass: boolean; detail: string } {
  switch (c.type) {
    case "file_exists": {
      const p = join(workspace, c.path!);
      return { type: c.type, pass: existsSync(p), detail: p };
    }
    case "file_matches": {
      const files = resolveFiles(workspace, c.path!);
      if (!files.length) return { type: c.type, pass: false, detail: `missing ${c.path}` };
      const re = new RegExp(c.regex!, "m");
      const hit = files.find(f => re.test(readFileSync(join(workspace, f), "utf8")));
      return { type: c.type, pass: Boolean(hit), detail: `/${c.regex}/ in ${hit ?? c.path}` };
    }
    case "file_not_matches": {
      const files = resolveFiles(workspace, c.path!);
      const re = new RegExp(c.regex!, "m");
      const hit = files.find(f => re.test(readFileSync(join(workspace, f), "utf8")));
      return { type: c.type, pass: !hit, detail: hit ? `banned /${c.regex}/ found in ${hit}` : `no /${c.regex}/ in ${c.path}` };
    }
    case "result_matches": {
      const ok = new RegExp(c.regex!, "ms").test(t.resultText ?? "");
      return { type: c.type, pass: ok, detail: `/${c.regex}/ in result` };
    }
    case "command": {
      const r = spawnSync("bash", ["-lc", c.cmd!], { cwd: workspace, encoding: "utf8", timeout: 120_000 });
      return { type: c.type, pass: r.status === 0, detail: `${c.cmd} -> exit ${r.status}: ${(r.stdout + r.stderr).slice(-300)}` };
    }
    default:
      return { type: c.type, pass: false, detail: `unknown check ${c.type}` };
  }
}

/** LLM judge via headless Claude Code with a JSON schema. Only used where code cannot answer. */
async function runJudge(task: Task, workspace: string, t: ParsedTranscript, c: OutcomeCheck): Promise<{ score: number; reason: string; costUsd: number }> {
  const cfg = loadConfig();
  const files = listFiles(workspace).slice(0, 20).map(f => `--- ${f}\n${readFileSync(join(workspace, f), "utf8").slice(0, 4000)}`).join("\n");
  const prompt = [
    `You are grading the output of a coding agent against a rubric. Be strict and literal.`,
    `TASK GIVEN TO THE AGENT:\n${task.prompt}`,
    `RUBRIC:\n${c.rubric}`,
    `AGENT FINAL MESSAGE:\n${(t.resultText ?? "").slice(0, 4000)}`,
    `WORKSPACE FILES:\n${files || "(none)"}`,
    `Return JSON with score in [0,1] (fraction of rubric satisfied) and a one-sentence reason.`,
  ].join("\n\n");
  const schema = JSON.stringify({ type: "object", properties: { score: { type: "number" }, reason: { type: "string" } }, required: ["score", "reason"] });
  const r = spawnSync("claude", ["-p", prompt, "--model", cfg.judge.model, "--output-format", "json", "--json-schema", schema, "--max-turns", String(cfg.judge.max_turns), "--permission-mode", "bypassPermissions", "--disallowedTools", "Bash", "Edit", "Write", "NotebookEdit", "Agent", "Skill"],
    { cwd: workspace, encoding: "utf8", timeout: 180_000, env: { ...process.env, CLAUDE_CONFIG_DIR: undefined } });
  try {
    const out = JSON.parse(r.stdout);
    if (out.subtype && out.subtype !== "success") return { score: 0, reason: `judge ended with ${out.subtype}`, costUsd: out.total_cost_usd ?? 0 };
    const parsed = out.structured_output ?? safeJson(out.result);
    return { score: clamp01(Number(parsed?.score)), reason: String(parsed?.reason ?? ""), costUsd: out.total_cost_usd ?? 0 };
  } catch {
    return { score: 0, reason: `judge failed: ${(r.stderr || r.stdout).slice(0, 300)}`, costUsd: 0 };
  }
}

function safeJson(s: unknown): any { try { return JSON.parse(String(s)); } catch { return null; } }
function clamp01(n: number): number { return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; }
function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base)); else out.push(p.slice(base.length + 1));
  }
  return out;
}
