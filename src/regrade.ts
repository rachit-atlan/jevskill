/** The inner loop: re-score saved transcripts. Free except for optional judge checks. */
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { armBase } from "./arms.ts";
import { loadTasks } from "./tasks.ts";
import { parseTranscript } from "./transcript.ts";
import { runDir, walk } from "./run.ts";
import { gradeRouting, topKHit, goldProbability, type RoutingGrade } from "./graders/routing.ts";
import { gradeAdherence, type AdherenceGrade } from "./graders/adherence.ts";
import { gradeCost, type CostGrade } from "./graders/cost.ts";
import { gradeLatency, type LatencyGrade } from "./graders/latency.ts";
import { gradeOutcome, type OutcomeGrade } from "./graders/outcome.ts";
import type { Decision, Task, TrialResult, Universe } from "./types.ts";

export interface TrialGrade {
  task: string; arm: string; trial: number; gold: string[]; mode: string; tags: string[];
  observed: string[];                 // injected (jev) or invoked via Skill tool (native)
  observedNoise: number;              // 1 if any observed skill is a noise decoy
  routerCalled: number | null;        // mcp arms: 1 if the agent called route_skill at all; null elsewhere
  routerCalledFirst: number | null;   // mcp arms: 1 if route_skill was the first tool call
  routing: RoutingGrade;
  top3Hit: number | null; goldProb: number | null; confidence: number | null; jevChoice: string | null; injectMode: string | null;
  adherence: AdherenceGrade | null;   // jev arm only
  cost: CostGrade; latency: LatencyGrade; outcome: OutcomeGrade | null;
  transcriptError: boolean;
  /** Write/Edit targets outside the trial workspace: the model acted on the real machine */
  outsideWrites: string[];
}

export interface GradeContext { universe: Universe; cfg: ReturnType<typeof loadConfig>; judge: boolean }

/** Grade one saved trial. Pure over files on disk plus the optional judge call. */
export async function gradeTrial(r: TrialResult, task: Task, ctx: GradeContext): Promise<TrialGrade> {
  const { universe, cfg } = ctx;
  const noiseIds = new Set(universe.skills.filter(s => s.noise).map(s => s.id));
  const t = parseTranscript(r.transcriptPath);
  const decisions: Decision[] = r.decisionPaths.filter(existsSync).map(p => JSON.parse(readFileSync(p, "utf8")));
  const d = decisions[0];
  const base = armBase(r.arm);
  const isJev = base === "jev";
  const isMcp = base === "mcp";
  const pathToId = new Map(universe.skills.map(s => [s.path, s.id]));
  const mcpLoaded = isMcp ? uniq([
    ...t.toolCalls.filter(c => /load_skill$/.test(c.name)).map(c => String((c.input as any)?.id ?? "")),
    ...t.toolCalls.filter(c => c.name === "Read").map(c => pathToId.get(String((c.input as any)?.file_path ?? "")) ?? "").filter(Boolean),
  ].filter(Boolean)) : [];
  const observed = isJev ? (d?.injected ?? []) : isMcp ? mcpLoaded : uniq(t.skillToolCalls);
  const isFallback = isJev && d?.action === "inject_listing";
  const outcome = task.mode === "full" ? await gradeOutcome(task, r.workspace, t, { useJudge: ctx.judge }) : null;
  return {
    task: task.id, arm: r.arm, trial: r.trial, gold: task.gold, mode: task.mode, tags: task.tags ?? [],
    observed,
    observedNoise: observed.some(o => noiseIds.has(o)) ? 1 : 0,
    routerCalled: isMcp ? (t.toolCalls.some(c => /route_skill$/.test(c.name)) ? 1 : 0) : null,
    routerCalledFirst: isMcp ? (/route_skill$/.test(t.toolCalls.find(c => c.name !== "ToolSearch")?.name ?? "") ? 1 : 0) : null, // MCP schemas are deferred; ToolSearch precedes the real call
    routing: gradeRouting(task.gold, observed, isFallback),
    top3Hit: d?.response ? topKHit(task.gold, d.response.probabilities, 3) : null,
    goldProb: d?.response ? goldProbability(task.gold, d.response.probabilities) : null,
    confidence: d?.response?.confidence ?? null,
    jevChoice: d?.response?.choice ?? null,
    injectMode: d?.injectMode ?? null,
    adherence: (isJev || (isMcp && decisions.length)) ? gradeAdherence(decisions, task.prompt, universe, { instructions: cfg.jev.instructions, questionId: cfg.jev.question_id, noneDescription: cfg.jev.none_description }) : null,
    cost: gradeCost(t, decisions, cfg.jev.price_per_m_input_usd),
    latency: gradeLatency(t, r, decisions),
    outcome,
    transcriptError: t.isError,
    outsideWrites: outsideWorkspace(t.filesWritten, r.workspace),
  };
}

function outsideWorkspace(paths: string[], workspace: string): string[] {
  const ws = safeReal(workspace);
  return [...new Set(paths.filter(p => !safeReal(p).startsWith(ws + "/") && safeReal(p) !== ws))];
}
function safeReal(p: string): string { try { return realpathSync(p); } catch { return resolve(p); } }

export async function regrade(runId: string, opts: { judge: boolean }): Promise<TrialGrade[]> {
  const cfg = loadConfig();
  const root = runDir(runId);
  const universe = JSON.parse(readFileSync(join(root, "universe.json"), "utf8")) as Universe;
  const tasks = new Map(loadTasks().map(t => [t.id, t]));
  const grades: TrialGrade[] = [];
  for (const resultPath of walk(root, "result.json")) {
    const r = JSON.parse(readFileSync(resultPath, "utf8")) as TrialResult;
    const task = tasks.get(r.task);
    if (!task) { console.error(`skip ${r.task}: not in tasks.jsonl`); continue; }
    const g = await gradeTrial(r, task, { universe, cfg, judge: opts.judge });
    writeFileSync(join(resultPath, "..", "grade.json"), JSON.stringify(g, null, 2));
    grades.push(g);
  }
  writeFileSync(join(root, "grades.json"), JSON.stringify(grades, null, 2));
  return grades;
}

function uniq<T>(xs: T[]): T[] { return [...new Set(xs)]; }
