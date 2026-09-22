/** Aggregate grades per arm, diff arms, apply gates from eval.yml. Writes report.json and report.md. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { runDir } from "./run.ts";
import { calibration } from "./graders/calibration.ts";
import type { TrialGrade } from "./regrade.ts";

type Num = number | null;
const mean = (xs: number[]): Num => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const pct = (xs: number[], q: number): Num => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const nn = (xs: Num[]): number[] => xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));

export interface ArmSummary {
  arm: string; n: number; nFull: number;
  routing_top1_accuracy: Num; routing_set_exact: Num; routing_jaccard: Num; top3_recall: Num;
  noise_pick_rate: Num; false_positive_rate: Num; wrong_skill_rate: Num; missed_rate: Num; fallback_rate: Num; false_delegation_rate: Num;
  categories: Record<string, number>;
  payload_validity: Num; verdict_adherence: Num; call_rate: Num; jev_error_rate: Num; router_call_rate: Num; router_called_first_rate: Num;
  task_pass_rate: Num; task_score_mean: Num; escaped_workspace_rate: Num;
  first_call_context_tokens_mean: Num; context_processed_tokens_mean: Num; cache_read_tokens_mean: Num; cache_creation_tokens_mean: Num; uncached_input_tokens_mean: Num; output_tokens_mean: Num;
  cost_usd_mean: Num; cost_usd_total: number; jev_cost_usd_total: number;
  route_latency_p50_ms: Num; route_latency_p95_ms: Num; first_assistant_ms_p50: Num; wall_ms_p50: Num; turns_mean: Num; tool_calls_mean: Num;
  calibration: ReturnType<typeof calibration> | null;
  confusion: Record<string, Record<string, number>>;
  per_skill: Record<string, { n: number; correct: number; missed: number; wrong: number }>;
}

export function summarizeArm(arm: string, gs: TrialGrade[], minN: number): ArmSummary {
  const g = gs.filter(x => x.arm === arm);
  const cats: Record<string, number> = {};
  for (const x of g) cats[x.routing.category] = (cats[x.routing.category] ?? 0) + 1;
  const rate = (c: string) => g.length ? (cats[c] ?? 0) / g.length : null;
  const goldNone = g.filter(x => x.gold.length === 0), goldSkill = g.filter(x => x.gold.length > 0);
  const full = g.filter(x => x.outcome);
  const confusion: Record<string, Record<string, number>> = {};
  const perSkill: ArmSummary["per_skill"] = {};
  for (const x of g) {
    const gold = x.gold[0] ?? "none", obs = x.observed[0] ?? (x.routing.category === "fallback" ? "fallback" : "none");
    confusion[gold] ??= {}; confusion[gold][obs] = (confusion[gold][obs] ?? 0) + 1;
    if (x.gold.length) {
      perSkill[gold] ??= { n: 0, correct: 0, missed: 0, wrong: 0 };
      perSkill[gold].n++;
      if (x.routing.category === "correct" || x.routing.category === "partial") perSkill[gold].correct++;
      if (x.routing.category === "missed") perSkill[gold].missed++;
      if (x.routing.category === "wrong_skill") perSkill[gold].wrong++;
    }
  }
  const adh = g.map(x => x.adherence).filter(Boolean) as NonNullable<TrialGrade["adherence"]>[];
  const pairs = g.filter(x => x.goldProb !== null).map(x => ({ p: x.goldProb as number, correct: x.routing.top1Correct }));
  return {
    arm, n: g.length, nFull: full.length,
    routing_top1_accuracy: mean(g.map(x => x.routing.top1Correct)),
    routing_set_exact: mean(g.map(x => x.routing.setExact)),
    routing_jaccard: mean(g.map(x => x.routing.jaccard)),
    top3_recall: mean(nn(g.map(x => x.top3Hit))),
    noise_pick_rate: mean(g.map(x => x.observedNoise ?? 0)),
    false_positive_rate: goldNone.length ? mean(goldNone.map(x => x.routing.category === "false_positive" ? 1 : 0)) : null,
    wrong_skill_rate: goldSkill.length ? mean(goldSkill.map(x => x.routing.category === "wrong_skill" ? 1 : 0)) : null,
    missed_rate: goldSkill.length ? mean(goldSkill.map(x => x.routing.missed)) : null,
    fallback_rate: rate("fallback"),
    false_delegation_rate: mean(g.map(x => x.routing.falseDelegation)),
    categories: cats,
    payload_validity: mean(adh.map(a => a.payloadValid)),
    verdict_adherence: mean(adh.map(a => a.verdictAdhered)),
    call_rate: mean(adh.map(a => a.called)),
    router_call_rate: mean(nn(g.map(x => x.routerCalled))),
    router_called_first_rate: mean(nn(g.map(x => x.routerCalledFirst))),
    jev_error_rate: mean(adh.map(a => a.errored)),
    escaped_workspace_rate: mean(g.map(x => (x.outsideWrites?.length ?? 0) > 0 ? 1 : 0)),
    task_pass_rate: mean(full.map(x => x.outcome!.pass)),
    task_score_mean: mean(full.map(x => x.outcome!.score)),
    first_call_context_tokens_mean: mean(g.map(x => x.cost.tokens.firstCallContext)),
    context_processed_tokens_mean: mean(g.map(x => x.cost.tokens.contextProcessed)),
    cache_read_tokens_mean: mean(g.map(x => x.cost.tokens.cacheRead)),
    cache_creation_tokens_mean: mean(g.map(x => x.cost.tokens.cacheCreation)),
    uncached_input_tokens_mean: mean(g.map(x => x.cost.tokens.input)),
    output_tokens_mean: mean(g.map(x => x.cost.tokens.output)),
    cost_usd_mean: mean(nn(g.map(x => x.cost.totalCostUsd))),
    cost_usd_total: nn(g.map(x => x.cost.totalCostUsd)).reduce((a, b) => a + b, 0),
    jev_cost_usd_total: g.reduce((a, x) => a + x.cost.jevCostUsd, 0),
    route_latency_p50_ms: pct(nn(g.map(x => x.latency.routeLatencyMs)), 0.5),
    route_latency_p95_ms: pct(nn(g.map(x => x.latency.routeLatencyMs)), 0.95),
    first_assistant_ms_p50: pct(nn(g.map(x => x.latency.firstAssistantEventMs)), 0.5),
    wall_ms_p50: pct(g.map(x => x.latency.wallMs), 0.5),
    turns_mean: mean(nn(g.map(x => x.latency.numTurns))),
    tool_calls_mean: mean(g.map(x => x.latency.toolCalls)),
    calibration: pairs.length ? calibration(pairs, minN) : null,
    confusion, per_skill: perSkill,
  };
}

export interface GateResult { key: string; value: Num; min?: number; max?: number; pass: boolean | null }

export function applyGates(summaries: Record<string, ArmSummary>, gates: Record<string, { min?: number; max?: number }>): GateResult[] {
  return Object.entries(gates).map(([key, g]) => {
    const [arm, metric] = key.split(".", 2);
    const value = (summaries[arm] as any)?.[metric] ?? null;
    const pass = value === null ? null : (g.min === undefined || value >= g.min) && (g.max === undefined || value <= g.max);
    return { key, value, min: g.min, max: g.max, pass };
  });
}

/** Tasks that pass without any skill (the `none` arm) cannot separate the arms; the primary comparison excludes them. */
export function necessityFilter(grades: TrialGrade[], passScore = 0.9): { nonSeparating: Set<string>; separating: Set<string>; hasNoneArm: boolean } {
  const none = grades.filter(g => g.arm === "none" && g.outcome);
  const byTask = new Map<string, TrialGrade[]>();
  for (const g of none) byTask.set(g.task, [...(byTask.get(g.task) ?? []), g]);
  const nonSeparating = new Set<string>(), separating = new Set<string>();
  for (const [task, gs] of byTask) {
    const allPass = gs.every(g => g.outcome!.pass === 1 && g.outcome!.score >= passScore);
    (allPass ? nonSeparating : separating).add(task);
  }
  return { nonSeparating, separating, hasNoneArm: none.length > 0 };
}

export function report(runId: string, grades: TrialGrade[]): { summaries: Record<string, ArmSummary>; gates: GateResult[]; md: string; primary?: Record<string, ArmSummary> } {
  const cfg = loadConfig();
  const arms = [...new Set(grades.map(g => g.arm))].sort();
  const summaries: Record<string, ArmSummary> = {};
  for (const a of arms) summaries[a] = summarizeArm(a, grades, cfg.calibration.min_n);
  const gates = applyGates(summaries, cfg.gates);
  const nf = necessityFilter(grades);
  // tasks that fail in every arm cannot separate arms either; list them so nobody mistakes them for signal
  const allFail = [...nf.separating].filter(t => grades.filter(g => g.task === t && g.arm !== "none" && g.outcome).every(g => g.outcome!.pass === 0));
  const allFailSet = new Set(allFail);
  let primary: Record<string, ArmSummary> | undefined;
  if (nf.hasNoneArm && nf.separating.size) {
    const sep = grades.filter(g => nf.separating.has(g.task) && !allFailSet.has(g.task) && g.arm !== "none");
    primary = {};
    for (const a of arms.filter(x => x !== "none")) primary[a] = summarizeArm(a, sep, cfg.calibration.min_n);
  }
  const md = renderMarkdown(runId, summaries, gates, grades, nf, primary, allFail);
  const root = runDir(runId);
  writeFileSync(join(root, "report.json"), JSON.stringify({ runId, summaries, gates, necessity: { nonSeparating: [...nf.nonSeparating], separating: [...nf.separating].filter(t => !allFailSet.has(t)), allFail }, primary }, null, 2));
  writeFileSync(join(root, "report.md"), md);
  return { summaries, gates, md, primary };
}

const f = (x: Num, d = 3): string => x === null ? "–" : Number.isInteger(x) ? String(x) : x.toFixed(d);
const pc = (x: Num): string => x === null ? "–" : `${(x * 100).toFixed(1)}%`;

function renderMarkdown(runId: string, s: Record<string, ArmSummary>, gates: GateResult[], grades: TrialGrade[], nf?: ReturnType<typeof necessityFilter>, primary?: Record<string, ArmSummary>, allFail: string[] = []): string {
  const arms = Object.keys(s);
  const row = (label: string, fn: (a: ArmSummary) => string) => `| ${label} | ${arms.map(a => fn(s[a])).join(" | ")} |`;
  const head = `| metric | ${arms.join(" | ")} |\n|---|${arms.map(() => "---:").join("|")}|`;
  const lines = [
    `# Skill routing eval: ${runId}`, ``,
    `Trials per arm: ${arms.map(a => `${a}=${s[a].n}`).join(", ")}. Full-outcome trials: ${arms.map(a => `${a}=${s[a].nFull}`).join(", ")}.`, ``,
  ];
  if (nf?.hasNoneArm) {
    lines.push(`## Necessity filter (tasks solved with no skill at all)`, ``,
      `Pass without any skill: ${[...nf.nonSeparating].sort().join(", ") || "none"}.`,
      `Need a skill (separating): ${[...nf.separating].filter(t => !allFail.includes(t)).sort().join(", ") || "none"}.`,
      `Fail in every arm (uninformative, excluded from primary): ${allFail.sort().join(", ") || "none"}.`, ``);
    if (primary) {
      const parms = Object.keys(primary);
      const phead = `| primary metric (separating tasks only) | ${parms.join(" | ")} |\n|---|${parms.map(() => "---:").join("|")}|`;
      const prow = (label: string, fn: (a: ArmSummary) => string) => `| ${label} | ${parms.map(a => fn(primary[a])).join(" | ")} |`;
      lines.push(`## Primary comparison on separating tasks`, phead,
        prow("task pass rate", a => pc(a.task_pass_rate)), prow("task score (mean)", a => f(a.task_score_mean)),
        prow("routing top-1", a => pc(a.routing_top1_accuracy)), prow("missed rate", a => pc(a.missed_rate)), prow("false delegation", a => pc(a.false_delegation_rate)),
        prow("first-call context tokens", a => f(a.first_call_context_tokens_mean, 0)), prow("cost per task USD", a => f(a.cost_usd_mean, 4)), prow("n", a => String(a.nFull)), ``);
    }
  }
  lines.push(
    `## Routing`, head,
    row("top-1 accuracy", a => pc(a.routing_top1_accuracy)),
    row("set exact match", a => pc(a.routing_set_exact)),
    row("top-3 recall (jev only)", a => pc(a.top3_recall)),
    row("noise skill picked", a => pc(a.noise_pick_rate)),
    row("false positive rate (gold=none)", a => pc(a.false_positive_rate)),
    row("wrong skill rate (gold=skill)", a => pc(a.wrong_skill_rate)),
    row("missed rate (gold=skill)", a => pc(a.missed_rate)),
    row("fallback rate", a => pc(a.fallback_rate)),
    row("false delegation rate (all)", a => pc(a.false_delegation_rate)),
    ``, `## Harness calls jev properly (jev arm)`, head,
    row("call rate (hook fired)", a => pc(a.call_rate)),
    row("agent called route_skill (mcp arms)", a => pc(a.router_call_rate)),
    row("route_skill was the first tool call", a => pc(a.router_called_first_rate)),
    row("payload validity", a => pc(a.payload_validity)),
    row("verdict adherence", a => pc(a.verdict_adherence)),
    row("jev error rate", a => pc(a.jev_error_rate)),
    ``, `## Task success (full-mode tasks)`, head,
    row("pass rate", a => pc(a.task_pass_rate)),
    row("mean score", a => f(a.task_score_mean)),
    row("wrote outside workspace", a => pc(a.escaped_workspace_rate)),
    row("turns (mean)", a => f(a.turns_mean, 1)),
    row("tool calls (mean)", a => f(a.tool_calls_mean, 1)),
    ``, `## Tokens and cost (cache-aware)`, head,
    row("first-call context tokens (system prompt proxy)", a => f(a.first_call_context_tokens_mean, 0)),
    row("context processed, all calls", a => f(a.context_processed_tokens_mean, 0)),
    row("cache read", a => f(a.cache_read_tokens_mean, 0)),
    row("cache creation", a => f(a.cache_creation_tokens_mean, 0)),
    row("uncached input", a => f(a.uncached_input_tokens_mean, 0)),
    row("output", a => f(a.output_tokens_mean, 0)),
    row("cost per trial USD (Claude + jev)", a => f(a.cost_usd_mean, 4)),
    row("total USD", a => f(a.cost_usd_total, 3)),
    row("of which jev USD", a => f(a.jev_cost_usd_total, 5)),
    ``, `## Latency`, head,
    row("route latency p50 ms", a => f(a.route_latency_p50_ms, 0)),
    row("route latency p95 ms", a => f(a.route_latency_p95_ms, 0)),
    row("first assistant event p50 ms", a => f(a.first_assistant_ms_p50, 0)),
    row("wall p50 ms", a => f(a.wall_ms_p50, 0)),
    ``, `## Calibration (jev arm)`,
  );
  const cal = s["jev"]?.calibration;
  if (!cal) lines.push(`No jev decisions with probabilities.`);
  else if (cal.brier === null) lines.push(`n=${cal.n} is below min_n; Brier and ECE withheld.`);
  else lines.push(`n=${cal.n}  Brier=${f(cal.brier)}  ECE=${f(cal.ece)}`, ``, `| bin | n | mean conf | accuracy |`, `|---|---:|---:|---:|`, ...cal.bins!.filter(b => b.n).map(b => `| ${b.lo.toFixed(1)}–${b.hi.toFixed(1)} | ${b.n} | ${f(b.meanConf)} | ${f(b.accuracy)} |`));
  lines.push(``, `## Gates`, `| gate | value | bound | verdict |`, `|---|---:|---|---|`);
  for (const g of gates) lines.push(`| ${g.key} | ${f(g.value)} | ${g.min !== undefined ? `≥ ${g.min}` : ""}${g.max !== undefined ? `≤ ${g.max}` : ""} | ${g.pass === null ? "n/a" : g.pass ? "PASS" : "FAIL"} |`);
  lines.push(``, `## Per-skill routing (gold skill → outcome)`);
  for (const a of arms) {
    lines.push(``, `### ${a}`, `| gold skill | n | correct | missed | wrong |`, `|---|---:|---:|---:|---:|`);
    for (const [k, v] of Object.entries(s[a].per_skill).sort()) lines.push(`| ${k} | ${v.n} | ${v.correct} | ${v.missed} | ${v.wrong} |`);
  }
  lines.push(``, `## Disagreements between arms (same task, different routing category)`);
  const byTask = new Map<string, TrialGrade[]>();
  for (const g of grades) { const k = `${g.task}#${g.trial}`; byTask.set(k, [...(byTask.get(k) ?? []), g]); }
  let any = false;
  for (const [k, gs] of byTask) {
    const cats = new Set(gs.map(g => g.routing.category));
    if (cats.size > 1) { any = true; lines.push(`- ${k}: ${gs.map(g => `${g.arm}=${g.routing.category}[${g.observed.join(",") || "none"}]`).join(", ")} (gold: ${gs[0].gold.join(",") || "none"})`); }
  }
  if (!any) lines.push(`none`);
  return lines.join("\n") + "\n";
}
