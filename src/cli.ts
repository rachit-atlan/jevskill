import { parseArgs } from "node:util";
import { discoverUniverse, saveUniverse, universeHash } from "./skills.ts";
import { buildRouteRequest, callJev } from "./jev.ts";
import { loadConfig } from "./config.ts";
import { runAll } from "./run.ts";
import { regrade } from "./regrade.ts";
import { report } from "./report.ts";
import { loadTasks } from "./tasks.ts";
import { applyPolicy } from "./hook/route-hook.ts";
import { parseTranscript } from "./transcript.ts";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { trialDir } from "./run.ts";
import { pushTasksDataset, runAtlanEval, DATASET_NAME_DEFAULT } from "./atlan.ts";

const [cmd, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest, allowPositionals: true,
  options: {
    run: { type: "string", short: "r" }, arms: { type: "string", default: "native,jev" }, tasks: { type: "string" },
    tag: { type: "string" }, mode: { type: "string" }, trials: { type: "string" }, judge: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false }, all: { type: "boolean", default: false },
    arm: { type: "string" }, dataset: { type: "string" }, "no-verify-traces": { type: "boolean", default: false }, group: { type: "string" }, baseline: { type: "string" }, resume: { type: "string" }, name: { type: "string" }, trial: { type: "string" },
  },
});

async function main(): Promise<void> {
  const cfg = loadConfig();
  switch (cmd) {
    case "skills": {
      const u = discoverUniverse(); saveUniverse(u);
      console.log(`${u.skills.length} routable skills (hash ${universeHash(u)}) from ${u.configDir}`);
      for (const s of u.skills) console.log(`  ${s.id.padEnd(40)} desc=${String(s.description.length).padStart(4)}ch body=${String(s.bodyBytes).padStart(6)}B`);
      console.log(`total description chars: ${u.skills.reduce((a, s) => a + s.description.length, 0)}`);
      return;
    }
    case "route": {
      // offline routing check: call jev for tasks (or an ad-hoc prompt) and print the decision; no Claude run
      const u = discoverUniverse();
      const known = new Set(u.skills.map(s => s.id));
      const policy = { threshold: cfg.policy.confidence_threshold, fallback: cfg.policy.fallback, fallbackTopK: cfg.policy.fallback_top_k, routeNoneMinProb: cfg.policy.route_none_min_prob };
      const items = positionals.length ? positionals.map((p, i) => ({ id: `adhoc-${i}`, prompt: p, gold: [] as string[] })) : loadTasks().filter(filterTask);
      let correct = 0, n = 0;
      for (const t of items) {
        const r = await callJev(buildRouteRequest(t.prompt, u.skills));
        const { action, injected } = applyPolicy(r.response, policy, known);
        const top = Object.entries(r.response.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ");
        const ok = positionals.length ? "" : (injected[0] === (t.gold[0] ?? undefined) || (injected.length === 0 && t.gold.length === 0) ? "✔" : "✘");
        if (ok === "✔") correct++; if (!positionals.length) n++;
        console.log(`${ok} ${t.id.padEnd(28)} ${action.padEnd(14)} conf=${r.response.confidence.toFixed(2)} ${Math.round(r.latencyMs)}ms  gold=${t.gold.join(",") || "none"}  top: ${top}`);
      }
      if (n) console.log(`offline top-1 (policy applied): ${correct}/${n} = ${(100 * correct / n).toFixed(1)}%`);
      return;
    }
    case "run": {
      const runId = values.run ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      await runAll({ runId, arms: values.arms!.split(","), taskFilter: filterTask, trials: values.trials ? Number(values.trials) : undefined, dryRun: values["dry-run"] });
      return;
    }
    case "regrade": {
      const runId = need(values.run, "--run");
      const grades = await regrade(runId, { judge: values.judge! });
      console.log(`graded ${grades.length} trials → runs/${runId}/grades.json`);
      const { md } = report(runId, grades);
      console.log(md);
      return;
    }
    case "report": {
      const runId = need(values.run, "--run");
      const p = join(process.cwd(), "runs", runId, "grades.json");
      if (!existsSync(p)) throw new Error(`no grades.json; run \`bun run regrade --run ${runId}\` first`);
      const { md } = report(runId, JSON.parse(readFileSync(p, "utf8")));
      console.log(md);
      return;
    }
    case "inspect": {
      // read one trial's transcript and grades: the "read the transcripts" step
      const runId = need(values.run, "--run");
      const [task, arm, trial = "0"] = positionals;
      const dir = trialDir(runId, task, arm, Number(trial));
      const t = parseTranscript(join(dir, "transcript.jsonl"));
      console.log(`tool calls: ${t.toolCalls.map(c => c.name + (c.name === "Skill" ? `(${JSON.stringify(c.input)})` : "")).join(" → ") || "none"}`);
      console.log(`skill calls: ${t.skillToolCalls.join(", ") || "none"} | turns ${t.numTurns} | cost $${t.totalCostUsd} | ctx first ${t.usage.firstCallContext} total ${t.usage.contextProcessed}`);
      const decDir = join(dir, "decisions");
      const first = existsSync(decDir) ? require_first(decDir) : "";
      if (first) console.log(`\n== decision\n${readFileSync(join(decDir, first), "utf8").slice(0, 3000)}`);
      for (const f of ["grade.json", "stderr.txt"]) { const p = join(dir, f); if (existsSync(p)) console.log(`\n== ${f}\n${readFileSync(p, "utf8").slice(0, 3000)}`); }
      console.log(`\n== result\n${t.resultText?.slice(0, 2000)}`);
      return;
    }
    case "dataset-push": {
      const r = await pushTasksDataset(values.name ?? DATASET_NAME_DEFAULT);
      const counts = r.records.reduce((a, x) => ({ ...a, [x.action]: (a[x.action] ?? 0) + 1 }), {} as Record<string, number>);
      console.log(`dataset ${r.id} (${r.created ? "created" : "existing"}): ${JSON.stringify(counts)}`);
      return;
    }
    case "atlan-eval": {
      // one Registry experiment for one arm; run per arm, pass --baseline <native experiment id> for the jev arm
      const runId = need(values.run, "--run"), arm = need(values.arm, "--arm");
      const r = await runAtlanEval({ runId, arm, trial: values.trial ? Number(values.trial) : 0, judge: values.judge!, dataset: values.dataset, baselineExperimentId: values.baseline, resumeExperimentId: values.resume, verifyTraces: !values["no-verify-traces"], group: values.group, taskFilter: filterTask });
      console.log(`experiment ${r.experimentId} completed: ${r.results.length} cases`);
      console.log(JSON.stringify(r.summary, null, 2));
      return;
    }
    default:
      console.log(`usage: bun run <skills|route|run|regrade|report|inspect|dataset-push|atlan-eval> [--run ID] [--arms native,jev] [--arm jev] [--tasks id1,id2] [--tag x] [--mode full|routing_only] [--trials N] [--judge] [--dry-run] [--dataset NAME] [--baseline EXP_ID] [--resume EXP_ID]`);
  }
}

function require_first(dir: string): string { return readdirSync(dir).sort()[0] ?? ""; }
function need(v: string | undefined, flag: string): string { if (!v) throw new Error(`${flag} is required`); return v; }
function filterTask(t: { id: string; tags?: string[]; mode?: string }): boolean {
  if (values.tasks && !values.tasks.split(",").includes(t.id)) return false;
  if (values.tag && !(t.tags ?? []).includes(values.tag)) return false;
  if (values.mode && t.mode !== values.mode) return false;
  return true;
}

main().catch(err => { console.error(err?.stack ?? err); process.exit(1); });
