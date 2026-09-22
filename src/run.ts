/** Runs tasks × arms × trials, saves transcripts to disk. Resumable: skips trials that already have result.json. */
import { mkdirSync, existsSync, writeFileSync, readdirSync, createWriteStream, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { loadConfig, REPO_ROOT } from "./config.ts";
import { buildSpawn, buildArmConfigDir, armBase } from "./arms.ts";
import { loadTasks } from "./tasks.ts";
import { discoverUniverse, saveUniverse } from "./skills.ts";
import type { Task, TrialResult } from "./types.ts";

export interface RunOptions { runId: string; arms: string[]; taskFilter?: (t: Task) => boolean; trials?: number; dryRun?: boolean }

export function runDir(runId: string): string { return resolve(REPO_ROOT, "runs", runId); }
export function trialDir(runId: string, task: string, arm: string, trial: number): string { return join(runDir(runId), task, arm, `t${trial}`); }

/** Snapshot the universe + config for a run and build the controlled arm config dirs. Idempotent. */
export function ensureRunSetup(runId: string, arms: string[]): { root: string; universePath: string } {
  const root = runDir(runId);
  mkdirSync(root, { recursive: true });
  // snapshot the universe for this run so the hook and the graders see the same set
  const universePath = join(root, "universe.json");
  if (!existsSync(universePath)) saveUniverse(discoverUniverse(), universePath);
  const universe = JSON.parse(readFileSync(universePath, "utf8"));
  for (const base of new Set(arms.map(armBase))) if (base !== "real") buildArmConfigDir(base, universe, runId);
  writeFileSync(join(root, "config.snapshot.yml"), readFileSync(process.env.JEVROUTE_CONFIG ?? resolve(REPO_ROOT, "eval.yml")));
  return { root, universePath };
}

export async function runAll(opts: RunOptions): Promise<void> {
  const cfg = loadConfig();
  const tasks = loadTasks().filter(opts.taskFilter ?? (() => true));
  const trials = opts.trials ?? cfg.run.trials;
  const { root, universePath } = ensureRunSetup(opts.runId, opts.arms);

  const jobs: { task: Task; arm: string; trial: number }[] = [];
  for (const task of tasks) for (const arm of opts.arms) for (let i = 0; i < trials; i++) jobs.push({ task, arm, trial: i });
  console.log(`run ${opts.runId}: ${tasks.length} tasks × ${opts.arms.length} arms × ${trials} trials = ${jobs.length} jobs; budget $${cfg.run.budget_usd}`);
  if (opts.dryRun) { for (const j of jobs) console.log(`  ${j.task.id} ${j.arm} t${j.trial}`); return; }

  let spent = spentSoFar(root);
  let active = 0, idx = 0;
  await new Promise<void>(done => {
    const next = () => {
      if (idx >= jobs.length && active === 0) return done();
      while (active < cfg.run.concurrency && idx < jobs.length) {
        if (spent >= cfg.run.budget_usd) { console.error(`budget ceiling $${cfg.run.budget_usd} reached at $${spent.toFixed(2)}; stopping`); idx = jobs.length; break; }
        const j = jobs[idx++]; active++;
        runTrial(j.task, j.arm, j.trial, opts.runId, universePath)
          .then(r => { spent += r.cost; })
          .catch(err => console.error(`  ${j.task.id}/${j.arm}/t${j.trial} failed: ${err?.message ?? err}`))
          .finally(() => { active--; next(); });
      }
      if (idx >= jobs.length && active === 0) done();
    };
    next();
  });
  console.log(`done. spent ≈ $${spent.toFixed(3)} on Claude. transcripts in ${root}`);
}

function spentSoFar(root: string): number {
  let s = 0;
  for (const p of walk(root, "transcript.jsonl")) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (line.includes('"type":"result"')) { try { s += JSON.parse(line).total_cost_usd ?? 0; } catch { /* ignore */ } }
    }
  }
  return s;
}

export function* walk(dir: string, filename: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) yield* walk(p, filename); else if (name.name === filename) yield p;
  }
}

/** Run one trial. Returns the saved result; a trial that already has result.json is returned with cost 0 and skipped=true. */
export async function runTrial(task: Task, arm: string, trial: number, runId: string, universePath: string): Promise<{ result: TrialResult; cost: number; skipped: boolean }> {
  const dir = trialDir(runId, task.id, arm, trial);
  const resultPath = join(dir, "result.json");
  if (existsSync(resultPath)) return { result: JSON.parse(readFileSync(resultPath, "utf8")), cost: 0, skipped: true };
  const ws = join(dir, "ws"), decisionDir = join(dir, "decisions");
  mkdirSync(ws, { recursive: true }); mkdirSync(decisionDir, { recursive: true });
  for (const [rel, content] of Object.entries(task.seed ?? {})) {
    mkdirSync(dirname(join(ws, rel)), { recursive: true }); writeFileSync(join(ws, rel), content);
  }
  for (const cmd of task.seed_commands ?? []) {
    const r = spawnSync("bash", ["-lc", cmd], { cwd: ws, encoding: "utf8", timeout: 120_000 });
    if (r.status !== 0) throw new Error(`seed command failed for ${task.id}: ${cmd}\n${(r.stdout + r.stderr).slice(-400)}`);
  }
  const spec = buildSpawn(arm, task, ws, decisionDir, universePath, runId);
  const transcriptPath = join(dir, "transcript.jsonl");
  const startedAt = new Date();
  const t0 = performance.now();
  let firstAssistantMs: number | null = null;
  console.log(`  ▶ ${task.id} ${arm} t${trial}`);
  const exitCode = await new Promise<number | null>(res => {
    const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"] });
    const out = createWriteStream(transcriptPath);
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      out.write(d);
      buf += d.toString();
      if (firstAssistantMs === null && buf.includes('"type":"assistant"')) firstAssistantMs = Math.round(performance.now() - t0);
      if (buf.length > 1_000_000) buf = buf.slice(-100_000);
    });
    let err = "";
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("close", code => { out.end(); if (err.trim()) writeFileSync(join(dir, "stderr.txt"), err); res(code); });
  });
  const result: TrialResult = {
    task: task.id, arm, trial, runId, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
    exitCode, wallMs: Math.round(performance.now() - t0), firstAssistantEventMs: firstAssistantMs,
    workspace: ws, transcriptPath, decisionPaths: existsSync(decisionDir) ? readdirSync(decisionDir).sort().map(f => join(decisionDir, f)) : [],
  };
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
  let cost = 0;
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) if (line.includes('"type":"result"')) { try { cost = JSON.parse(line).total_cost_usd ?? 0; } catch { /* ignore */ } }
  console.log(`  ✔ ${task.id} ${arm} t${trial}  $${cost.toFixed(3)}  ${result.wallMs}ms`);
  return { result, cost, skipped: false };
}
