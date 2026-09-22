/**
 * Atlan Registry adapter. The eval still runs here; Registry is the catalog, comparison and evidence plane:
 *   tasks.jsonl            -> one Registry dataset (one record per task)
 *   one arm × one run      -> one experiment, arm + thresholds + universe hash frozen in its config,
 *                             context manifest pinning eval.yml / universe / noise / tasks / Claude Code version
 *   our graders            -> Registry scorers (numbers only; policy stays in eval.yml)
 *   each trial             -> one trace with task + scorer spans, uploaded and verified by the SDK
 * Local report.md remains the verdict layer (Registry has no gates or run-over-run diff).
 */
import { readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { Eval, pushDataset, createContextManifest, AtlanClient } from "@atlanai/sdk";
import { loadConfig, REPO_ROOT } from "./config.ts";
import { loadTasks } from "./tasks.ts";
import { ensureRunSetup, runTrial, runDir } from "./run.ts";
import { gradeTrial, type TrialGrade } from "./regrade.ts";
import { universeHash } from "./skills.ts";
import type { Task, Universe } from "./types.ts";

export const DATASET_NAME_DEFAULT = "jev-skill-routing-tasks";

// ---------------------------------------------------------------------------
// Dataset

export interface CaseInput { id: string; prompt: string; mode: Task["mode"]; seed?: Record<string, string> }
export interface CaseExpected { gold: string[]; checks: NonNullable<Task["checks"]> }

/** One Registry record per task. `name` is the stable key, so re-pushing patches rows instead of duplicating. */
export function taskRecords(tasks: Task[]): Record<string, unknown>[] {
  return tasks.map(t => ({
    name: t.id,
    input: { id: t.id, prompt: t.prompt, mode: t.mode, ...(t.seed ? { seed: t.seed } : {}) } satisfies CaseInput,
    expected: { gold: t.gold, checks: t.checks ?? [] } satisfies CaseExpected,
    metadata: { mode: t.mode, tags: t.tags ?? [], gold_count: t.gold.length },
    tags: t.tags ?? [],
  }));
}

export function atlanClient(): AtlanClient {
  const apiKey = process.env.ATLAN_API_KEY, workspace = process.env.ATLAN_WORKSPACE_ID;
  if (!apiKey || !workspace) throw new Error("ATLAN_API_KEY and ATLAN_WORKSPACE_ID are required (see .env.example)");
  return new AtlanClient({ gatewayOrigin: process.env.ATLAN_BASE_URL ?? "https://api.atlan.com", bearerToken: apiKey, workspace });
}

export async function pushTasksDataset(name = DATASET_NAME_DEFAULT) {
  const tasks = loadTasks();
  return pushDataset(atlanClient(), name, taskRecords(tasks), {
    displayName: "jev skill-routing tasks",
    description: `Skill-routing eval tasks: ${tasks.length} cases, gold skill ids, outcome checks. Source: tasks/*.jsonl`,
  });
}

// ---------------------------------------------------------------------------
// Scorers: numbers only. Each maps a graded trial to one Registry score axis.

export interface ScorerDef {
  name: string;
  scorerKind: "code" | "llm_judge";
  description: string;
  scorer: (g: TrialGrade) => number | boolean | null;
}

export const SCORERS: ScorerDef[] = [
  { name: "routing_top1", scorerKind: "code", description: "1 if the observed skill (injected or invoked) matches gold; 1 for none/none", scorer: g => g.routing.top1Correct },
  { name: "false_delegation", scorerKind: "code", description: "1 if a skill was used where none applied, or the wrong skill was used", scorer: g => g.routing.falseDelegation },
  { name: "missed_delegation", scorerKind: "code", description: "1 if gold names a skill and none was used", scorer: g => g.routing.missed },
  { name: "noise_skill_picked", scorerKind: "code", description: "1 if a synthetic decoy skill was used", scorer: g => g.observedNoise },
  { name: "router_called", scorerKind: "code", description: "mcp arms: 1 if the agent chose to call route_skill; null elsewhere", scorer: g => g.routerCalled },
  { name: "escaped_workspace", scorerKind: "code", description: "1 if any Write/Edit targeted a path outside the trial workspace", scorer: g => (g.outsideWrites?.length ?? 0) > 0 ? 1 : 0 },
  { name: "task_pass", scorerKind: "code", description: "1 if every hard outcome check passed (workspace state, not self-report); null for routing-only tasks", scorer: g => g.outcome ? g.outcome.pass : null },
  { name: "task_score", scorerKind: "llm_judge", description: "mean over outcome checks incl. rubric judge; null for routing-only tasks", scorer: g => g.outcome ? g.outcome.score : null },
  { name: "first_call_context_tokens", scorerKind: "code", description: "input+cache tokens on the first model call (system prompt proxy)", scorer: g => g.cost.tokens.firstCallContext },
  { name: "cost_usd", scorerKind: "code", description: "Claude Code total_cost_usd plus jev input cost", scorer: g => g.cost.totalCostUsd },
  { name: "route_latency_ms", scorerKind: "code", description: "jev round trip inside the hook; null for native arms", scorer: g => g.latency.routeLatencyMs },
  { name: "hook_verdict_adhered", scorerKind: "code", description: "1 if the hook did what policy(eval.yml) says for jev's answer", scorer: g => g.adherence ? g.adherence.verdictAdhered : null },
];

export function scoreRow(g: TrialGrade): Record<string, number | boolean | null> {
  return Object.fromEntries(SCORERS.map(s => [s.name, s.scorer(g)]));
}

// ---------------------------------------------------------------------------
// Context manifest: what could have changed between two otherwise identical runs

function sha256File(p: string): string { return `sha256:${createHash("sha256").update(readFileSync(p)).digest("hex")}`; }
function gitSha(): string | null { try { return execSync("git rev-parse HEAD", { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } }
export function claudeVersion(): string { try { return execSync("claude --version", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\s+/)[0]; } catch { return "unknown"; } }

export async function buildContextManifest(runId: string, universe: Universe) {
  const sha = gitSha();
  const ver = (p: string) => sha ? `git:${sha}` : sha256File(p).slice(0, 23);
  const items = [
    { kind: "config", name: "eval.yml", version: ver(resolve(REPO_ROOT, "eval.yml")), digest: sha256File(join(runDir(runId), "config.snapshot.yml")) },
    { kind: "skill", name: "universe.json", version: universeHash(universe), digest: sha256File(join(runDir(runId), "universe.json")) },
    ...readdirSync(resolve(REPO_ROOT, "tasks")).filter(f => f.endsWith(".jsonl")).sort().map(f => ({ kind: "dataset", name: `tasks/${f}`, version: ver(resolve(REPO_ROOT, "tasks", f)), digest: sha256File(resolve(REPO_ROOT, "tasks", f)) })),
    { kind: "prompt", name: "route-hook.ts", version: ver(resolve(REPO_ROOT, "src/hook/route-hook.ts")), digest: sha256File(resolve(REPO_ROOT, "src/hook/route-hook.ts")) },
    { kind: "harness", name: "claude-code", version: claudeVersion(), digest: `sha256:${createHash("sha256").update(claudeVersion()).digest("hex")}` },
  ];
  const noise = resolve(REPO_ROOT, "noise/manifest.json");
  if (existsSync(noise)) items.push({ kind: "skill", name: "noise/manifest.json", version: ver(noise), digest: sha256File(noise) });
  return createContextManifest(items);
}

// ---------------------------------------------------------------------------
// One experiment per arm

export interface AtlanEvalOptions {
  runId: string; arm: string; trial?: number; judge?: boolean;
  dataset?: string;               // Registry dataset name/id; omit to use inline cases from tasks.jsonl
  taskFilter?: (t: Task) => boolean;
  baselineExperimentId?: string;  // e.g. the native experiment, so Registry can compare
  resumeExperimentId?: string;
  /** comparison_group_id for Registry; defaults to runId. Use a new value after graders or tasks change (new lineage). */
  group?: string;
  /** Skip the SDK trace read-back gate. Needed on a local gateway with no trace store; unsuitable for bench acceptance. */
  verifyTraces?: boolean;
}

export async function runAtlanEval(opts: AtlanEvalOptions) {
  const cfg = loadConfig();
  const armCfg = cfg.arms[opts.arm];
  if (!armCfg) throw new Error(`unknown arm ${opts.arm}`);
  const trial = opts.trial ?? 0;
  const { universePath } = ensureRunSetup(opts.runId, [opts.arm]);
  const universe = JSON.parse(readFileSync(universePath, "utf8")) as Universe;
  const tasks = loadTasks().filter(opts.taskFilter ?? (() => true));
  const byId = new Map(tasks.map(t => [t.id, t]));
  const contextManifest = await buildContextManifest(opts.runId, universe);
  const statePath = join(runDir(opts.runId), `atlan-${opts.arm}-t${trial}.json`);

  const evaluator = {
    ...(opts.dataset ? { dataset: opts.dataset } : { data: taskRecords(tasks).map(r => ({ id: r.name as string, input: r.input as CaseInput, expected: r.expected as CaseExpected, metadata: r.metadata as Record<string, unknown>, tags: r.tags as string[] })) }),
    experimentName: `${opts.group ?? opts.runId}/${opts.arm}/t${trial}`,
    description: armCfg.description,
    task: async (input: CaseInput, hooks: { span: { update(f: Record<string, unknown>): unknown } }): Promise<TrialGrade> => {
      const task = byId.get(input.id) ?? loadTasks().find(t => t.id === input.id);
      if (!task) throw new Error(`task ${input.id} not in tasks.jsonl`);
      const { result } = await runTrial(task, opts.arm, trial, opts.runId, universePath);
      const grade = await gradeTrial(result, task, { universe, cfg, judge: opts.judge ?? false });
      writeFileSync(join(result.transcriptPath, "..", "grade.json"), JSON.stringify(grade, null, 2));
      hooks.span.update({ metadata: {
        arm: opts.arm, observed: grade.observed, routing_category: grade.routing.category, jev_choice: grade.jevChoice,
        tokens: grade.cost.tokens, cost_usd: grade.cost.totalCostUsd, turns: grade.latency.numTurns, transcript: result.transcriptPath,
      } });
      return grade;
    },
    scores: SCORERS.map(s => ({
      name: s.name, scorerKind: s.scorerKind, scope: "result" as const,
      spec: { description: s.description, source: "jevskillroute/src/atlan.ts", policy_file: "eval.yml" },
      scorer: ({ output }: { output: TrialGrade }) => s.scorer(output),
    })),
  };

  const run = await Eval(`jev-skill-routing`, evaluator as any, {
    subjectKind: process.env.ATLAN_SUBJECT_ID ? ((process.env.ATLAN_SUBJECT_KIND as "harness" | "agent") ?? "harness") : undefined,
    subjectId: process.env.ATLAN_SUBJECT_ID,
    baselineExperimentId: opts.baselineExperimentId,
    resumeExperimentId: opts.resumeExperimentId,
    verifyTraces: opts.verifyTraces ?? true,
    contextManifest,
    config: {
      arm: opts.arm, arm_description: armCfg.description, arm_env: armCfg.env ?? {},
      comparison_group_id: opts.group ?? opts.runId, attempt_index: trial,
      model: cfg.claude.model, permission_mode: cfg.claude.permission_mode,
      max_turns_full: cfg.claude.max_turns_full, max_turns_routing_only: cfg.claude.max_turns_routing_only,
      jev_model: cfg.jev.model, policy: cfg.policy,
      universe_hash: universeHash(universe), universe_size: universe.skills.length, noise_count: universe.skills.filter(s => s.noise).length,
      judge_model: opts.judge ? cfg.judge.model : null, claude_code_version: claudeVersion(),
    },
    onStart: ({ experimentId }) => {
      writeFileSync(statePath, JSON.stringify({ experimentId, runId: opts.runId, arm: opts.arm, trial, startedAt: new Date().toISOString() }, null, 2));
      console.log(`experiment ${experimentId} (${opts.arm}) running; saved to ${statePath} for --resume`);
    },
  });
  writeFileSync(statePath, JSON.stringify({ experimentId: run.experimentId, runId: opts.runId, arm: opts.arm, trial, completedAt: new Date().toISOString(), summary: run.summary }, null, 2));
  return run;
}
