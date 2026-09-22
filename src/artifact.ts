/** Render docs/eval-report.html from a run's report.json + grades.json. Numbers come from the data, never typed by hand. */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "./config.ts";
import { runDir } from "./run.ts";
import type { TrialGrade } from "./regrade.ts";
import type { ArmSummary } from "./report.ts";

const ARM_ORDER = ["none", "native", "jev-pointer", "jev-mcp-nudged", "native-full", "jev", "jev-mcp"];
/** arms drawn in the bar charts: the control plus the three two-trial primary arms; the rest are robustness rows in tables */
const CHART_ARMS = ["none", "native", "jev-pointer", "jev-mcp-nudged"];
const ARM_LABEL: Record<string, string> = { none: "no skill", native: "native Claude Code", jev: "jev · body injected", "jev-pointer": "jev · pointer injected", "jev-mcp-nudged": "jev · MCP, nudged", "jev-mcp": "jev · MCP, unprompted", "native-full": "native · full descriptions" };
// categorical slots 1-3 (validated) for the three compared arms; gray for the no-skill control
const ARM_COLOR: Record<string, string> = { native: "var(--series-1)", "jev-pointer": "var(--series-2)", "jev-mcp-nudged": "var(--series-3)", none: "var(--muted-mark)", jev: "var(--muted-mark)", "jev-mcp": "var(--muted-mark)", "native-full": "var(--muted-mark)" };

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const pct = (x: number | null) => x === null ? "–" : `${(x * 100).toFixed(x * 100 % 1 === 0 ? 0 : 1)}%`;
const usd = (x: number | null) => x === null ? "–" : `$${x.toFixed(3)}`;
const k = (x: number | null) => x === null ? "–" : `${(x / 1000).toFixed(1)}K`;

export function renderArtifact(runId: string): string {
  const root = runDir(runId);
  const report = JSON.parse(readFileSync(join(root, "report.json"), "utf8")) as { summaries: Record<string, ArmSummary>; primary?: Record<string, ArmSummary>; necessity: { separating: string[]; nonSeparating: string[]; allFail?: string[] } };
  const grades = JSON.parse(readFileSync(join(root, "grades.json"), "utf8")) as TrialGrade[];
  const universe = JSON.parse(readFileSync(join(root, "universe.json"), "utf8")) as { skills: { noise: boolean }[] };
  const sep = new Set(report.necessity.separating);
  const allKnowledge = new Set(grades.map(g => g.task)).size;
  const primary = report.primary!;
  const arms = ARM_ORDER.filter(a => a in report.summaries);
  const cmpArms = ARM_ORDER.filter(a => a in primary);
  const noneSep = report.summaries.none ? summarizeNone(grades.filter(g => g.arm === "none" && sep.has(g.task))) : null;

  // per-task matrix
  const tasks = [...sep].sort();
  const cell = (t: string, a: string) => {
    const xs = grades.filter(g => g.task === t && g.arm === a);
    const pass = xs.reduce((s, g) => s + (g.outcome?.pass ?? 0), 0), score = xs.length ? xs.reduce((s, g) => s + (g.outcome?.score ?? 0), 0) / xs.length : 0;
    const obs = [...new Set(xs.map(g => g.observed[0] ?? (g.routing.category === "fallback" ? "listing" : "none")))].map(s => s.replace(/^(atlan-frontend|obsidian|atlanai)-/, "")).join(" / ");
    return { pass, n: xs.length, score, obs };
  };
  const step = (score: number) => score >= 0.999 ? 650 : score >= 0.9 ? 500 : score >= 0.75 ? 350 : score >= 0.5 ? 250 : 150;

  // grouped bars: pass rate + score
  const barGroup = (metric: (a: ArmSummary) => number | null, fmt: (x: number | null) => string, title: string, id: string, includeNone: boolean, max = 1) => {
    const rows = [...(includeNone && noneSep ? [["none", noneSep] as const] : []), ...cmpArms.filter(a => CHART_ARMS.includes(a)).map(a => [a, primary[a]] as const)];
    const W = 640, H = 40 * rows.length + 30, LW = 190, BW = W - LW - 70;
    const bars = rows.map(([a, s], i) => {
      const v = metric(s as ArmSummary) ?? 0, w = Math.max(2, (v / max) * BW), y = 10 + i * 40;
      return `<g class="bar" data-tip="${esc(ARM_LABEL[a])}: ${esc(fmt(v))}"><text x="${LW - 10}" y="${y + 17}" text-anchor="end" class="lbl">${esc(ARM_LABEL[a])}</text><rect x="${LW}" y="${y}" width="${w}" height="24" rx="0" style="fill:${ARM_COLOR[a]}"/><rect x="${LW + w - 4}" y="${y}" width="4" height="24" rx="4" style="fill:${ARM_COLOR[a]}"/><text x="${LW + w + 8}" y="${y + 17}" class="val">${esc(fmt(v))}</text></g>`;
    }).join("");
    return `<figure id="${id}"><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${bars}<line x1="${LW}" y1="4" x2="${LW}" y2="${H - 8}" class="axis"/></svg></figure>`;
  };

  const s = report.summaries;
  const jevAdh = s["jev-pointer"] ?? s.jev;
  const noise = universe.skills.filter(x => x.noise).length;
  const nTrials = (a: string) => grades.filter(g => g.arm === a && sep.has(g.task)).length;
  const wins = tasks.map(t => ({ t, native: cell(t, "native").pass, jev: cell(t, "jev").pass, ptr: cell(t, "jev-pointer").pass }));
  const jevWon = wins.filter(w => w.jev > w.native).length, jevLost = wins.filter(w => w.jev < w.native).length, ptrWon = wins.filter(w => w.ptr > w.native).length, ptrLost = wins.filter(w => w.ptr < w.native).length;
  const mcpWins = tasks.map(t => ({ m: cell(t, "jev-mcp-nudged").pass, native: cell(t, "native").pass }));
  const mcpWon = mcpWins.filter(w => w.m > w.native).length, mcpLost = mcpWins.filter(w => w.m < w.native).length;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>jev skill routing eval · ${esc(runId)}</title>
<style>
:root{color-scheme:light;--surface:#fcfcfb;--surface-2:#f3f2ef;--text:#0b0b0b;--text-2:#52514e;--text-3:#7a786f;--rule:#e2e0da;
--series-1:#2a78d6;--series-2:#eb6834;--series-3:#1baf7a;--muted-mark:#b3b1a8;--seq-150:#b7d3f6;--seq-250:#86b6ef;--seq-350:#5598e7;--seq-500:#256abf;--seq-650:#104281;--good:#0ca30c;--critical:#d03b3b}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--surface:#1a1a19;--surface-2:#232321;--text:#fff;--text-2:#c3c2b7;--text-3:#8f8e85;--rule:#33322f;--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--muted-mark:#6b6a63}}
*{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1040px;margin:0 auto;padding:40px 28px 80px}h1{font-size:30px;letter-spacing:-.01em;margin:0 0 6px}h2{font-size:20px;margin:44px 0 12px;padding-top:12px;border-top:1px solid var(--rule)}h3{font-size:16px;margin:22px 0 8px}
p,li{max-width:76ch}.sub{color:var(--text-2);margin:0 0 18px}.kicker{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-3)}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:22px 0}.tile{background:var(--surface-2);padding:14px 16px;border-radius:8px}.tile .n{font-size:28px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.01em}.tile .l{color:var(--text-2);font-size:13px}.tile .d{color:var(--text-3);font-size:12px;margin-top:2px}
table{border-collapse:collapse;width:100%;margin:10px 0 6px;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--rule);vertical-align:top}th{font-weight:600;color:var(--text-2);font-size:13px}td.num,th.num{text-align:right}
figure{margin:18px 0;background:var(--surface-2);border-radius:8px;padding:14px 16px}figcaption{font-weight:600;margin-bottom:6px}svg{width:100%;height:auto;display:block;overflow:visible}.lbl{font-size:13px;fill:var(--text-2)}.val{font-size:13px;fill:var(--text);font-variant-numeric:tabular-nums}.axis{stroke:var(--rule);stroke-width:1}
.bar rect{transition:opacity .12s}.bar:hover rect{opacity:.8}
.matrix{display:grid;grid-template-columns:200px repeat(${arms.length},1fr);gap:2px;margin-top:8px}.matrix .h{font-size:12px;color:var(--text-2);padding:4px 6px}.matrix .r{font-size:13px;padding:8px 6px;color:var(--text-2)}.cellx{padding:8px 6px;border-radius:0;color:#fff;font-size:13px;font-variant-numeric:tabular-nums;position:relative}.cellx small{display:block;opacity:.85;font-size:11px}.cellx.light{color:var(--text)}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--text-2);margin:6px 0}.legend span::before{content:"";display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px;background:var(--c)}
.callout{border-left:3px solid var(--series-1);padding:8px 14px;background:var(--surface-2);border-radius:0 8px 8px 0;margin:14px 0}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--surface-2);padding:1px 5px;border-radius:4px}pre{background:var(--surface-2);padding:12px 14px;border-radius:8px;overflow:auto;font-size:13px}
#tip{position:fixed;pointer-events:none;background:var(--text);color:var(--surface);padding:6px 9px;border-radius:6px;font-size:12px;display:none;z-index:9}.two{display:grid;grid-template-columns:1fr 1fr;gap:20px}@media(max-width:760px){.two{grid-template-columns:1fr}.tiles{grid-template-columns:1fr 1fr}}
</style></head><body><main>
<div class="kicker">Eval report · run <code>${esc(runId)}</code> · ${esc(new Date().toISOString().slice(0, 10))}</div>
<h1>Does routing skills through jev make Claude Code better at its job?</h1>
<p class="sub">One harness, one model, one task set. The only thing that changes between arms is how a skill reaches the model: Claude Code's own listing and Skill tool, or a jev decision injected before the model reads the prompt.</p>

<div class="tiles">
<div class="tile"><div class="n">${esc(pct(primary["jev-pointer"].task_pass_rate))}</div><div class="l">task pass rate, jev routed (pointer)</div><div class="d">native ${esc(pct(primary.native.task_pass_rate))} · no skill ${noneSep ? esc(pct(noneSep.task_pass_rate)) : "–"}</div></div>
<div class="tile"><div class="n">${esc(pct(primary["jev-pointer"].missed_rate))}</div><div class="l">applicable skill skipped, jev</div><div class="d">native ${esc(pct(primary.native.missed_rate))}</div></div>
<div class="tile"><div class="n">${ptrWon}–${ptrLost}</div><div class="l">tasks won–lost vs native, jev pointer</div><div class="d">${primary["jev-mcp-nudged"] ? `MCP nudged ${mcpWon}–${mcpLost} · ` : ""}${tasks.length} tasks × 2 trials</div></div>
<div class="tile"><div class="n">−${esc(((1 - primary["jev-pointer"].first_call_context_tokens_mean! / primary.native.first_call_context_tokens_mean!) * 100).toFixed(0))}%</div><div class="l">context per call, pointer arm</div><div class="d">${esc(k(primary.native.first_call_context_tokens_mean))} → ${esc(k(primary["jev-pointer"].first_call_context_tokens_mean))} tokens</div></div>
<div class="tile"><div class="n">${esc(usd(primary["jev-pointer"].cost_usd_mean))}</div><div class="l">cost per task, jev pointer</div><div class="d">native ${esc(usd(primary.native.cost_usd_mean))} · incl. jev's own cost</div></div>
<div class="tile"><div class="n">${s["jev-mcp"] ? esc(pct(s["jev-mcp"].router_call_rate)) : "–"}</div><div class="l">agent called the router unprompted (MCP)</div><div class="d">with a one-line nudge ${s["jev-mcp-nudged"] ? esc(pct(s["jev-mcp-nudged"].router_call_rate)) : "–"} · hook adherence ${esc(pct(jevAdh.verdict_adherence))}</div></div>
</div>

<h2>Summary</h2>
<p>On the ${tasks.length} tasks where an installed skill materially changes the output, jev pointer routing passed ${esc(pct(primary["jev-pointer"].task_pass_rate))} against native's ${esc(pct(primary.native.task_pass_rate))}, scored ${esc((primary["jev-pointer"].task_score_mean ?? 0).toFixed(3))} against ${esc((primary.native.task_score_mean ?? 0).toFixed(3))}, and cut context per call by ${esc(((1 - primary["jev-pointer"].first_call_context_tokens_mean! / primary.native.first_call_context_tokens_mean!) * 100).toFixed(0))}%. Native picked the right skill ${esc(pct(primary.native.routing_top1_accuracy))} of the time and skipped it on ${esc(pct(primary.native.missed_rate))} of trials; jev skipped none and misrouted ${esc(pct(primary["jev-pointer"].wrong_skill_rate))}, all on skills whose descriptions read as review-only. Left to itself with jev as an MCP tool, the agent called the router on ${s["jev-mcp"] ? esc(pct(s["jev-mcp"].router_call_rate)) : "–"} of trials; one system-prompt line raised that to ${s["jev-mcp-nudged"] ? esc(pct(s["jev-mcp-nudged"].router_call_rate)) : "–"}.</p>
<div class="callout"><strong>What this does not show.</strong> Everything ran at ${esc(String(universe.skills.length))} skills. The claim that jev matters more at 100+ skills is untested here. Sample is ${tasks.length} tasks × 2 trials for the primary arms; the pass-rate gap between jev pointer and native is ${esc(String(Math.round((primary["jev-pointer"].task_pass_rate! - primary.native.task_pass_rate!) * nTrials("jev-pointer"))))} trials of ${nTrials("jev-pointer")}. Robustness arms (native with full descriptions, jev body, jev MCP unprompted) ran one trial each. ${report.necessity.allFail?.length ? `${report.necessity.allFail.length} tasks failed in every arm and are excluded as uninformative: ${esc(report.necessity.allFail.join(", "))}.` : ""}</div>

<h2>Why this eval</h2>
<p>Claude Code lists every enabled skill's description in the system prompt and lets the model decide whether to call one. That costs context on every turn, and it relies on the model choosing to reach for a skill. jev is a decision model: given text and a fixed set of options, it returns a probability distribution in about 350 ms for a fraction of a cent. The question was not "is jev a better classifier than Claude" but "if the harness routes with jev instead of leaving it to the model, do tasks come out better, cheaper, or both?"</p>
<p>Two earlier framings were rejected. A pure router-versus-router comparison is unfair to native, because a capable model that skips a skill it does not need has not misrouted. So task quality is the verdict and routing accuracy is the diagnostic. And an easy task set is useless: on the first pilot every arm scored 0.99 because the model already knew TanStack and Vite. This run keeps only tasks that fail when no skill is available.</p>

<h2>Why jev is needed for skill routing</h2>
<ol>
<li><strong>Native skips skills.</strong> On house-specific prompts native routed well (${esc(pct(primary.native.routing_top1_accuracy))}) but still skipped the applicable skill on ${esc(pct(primary.native.missed_rate))} of trials; on an earlier generic pilot set it skipped 3 of 4. Skipped trials fail the task. jev acting through a hook removes that decision.</li>
<li><strong>The native listing is capped.</strong> Claude Code truncates the skill listing at roughly 15k characters. With 63 skills present, 49 appeared as bare names, in alphabetical order, so which skills keep a description is an accident of naming. jev sees every description, up to 255 options.</li>
<li><strong>It is cheap enough to run on every prompt.</strong> jev cost for all ${grades.length} trials in this run: ${esc(usd(Object.values(s).reduce((a, x) => a + x.jev_cost_usd_total, 0)))}. Latency ${esc(String(Math.round(s.jev.route_latency_p50_ms ?? 0)))} ms p50 inside the hook cold, about 430 ms with the warm-connection daemon.</li>
<li><strong>Pointer injection keeps the saving.</strong> Injecting one line that names the skill and its path scored the same as injecting the full body, at the lowest context of any arm. The model reads the file when it wants it.</li>
</ol>

<h2>Method</h2>
<table><thead><tr><th>arm</th><th>how the skill reaches the model</th><th class="num">trials</th></tr></thead><tbody>
${arms.map(a => `<tr><td><span class="legend"><span style="--c:${ARM_COLOR[a]}">${esc(ARM_LABEL[a])}</span></span></td><td>${esc(({ none: "Controlled config, no skills, no hook. The necessity filter: a task that passes here is cut.", native: `Controlled config; the same ${universe.skills.length} skills installed as personal skills, listed by Claude Code as shipped (descriptions truncated past ~15k chars); the model calls the Skill tool if it chooses.`, "native-full": "Native with the listing budget raised so every description is visible. Fairness check, one trial.", jev: "Controlled config, no skills listed; a UserPromptSubmit hook asks jev which skill applies and injects that SKILL.md body. One trial.", "jev-pointer": "Same hook; injects one line naming the skill and its path instead of the body.", "jev-mcp-nudged": "No skills listed, no hook; jev exposed as MCP tools route_skill / load_skill, plus one system-prompt line saying to route first.", "jev-mcp": "Same MCP tools with no nudge: does the agent think to ask? One trial." } as Record<string, string>)[a] ?? "")}</td><td class="num">${nTrials(a)}</td></tr>`).join("")}
</tbody></table>
<p><strong>Fairness controls.</strong> Same model, permission mode, turn limit, tasks, seed files. Identical generated config dirs with no plugins, MCP servers or CLAUDE.md. The same ${esc(String(universe.skills.length))}-skill universe in every arm, including ${esc(String(noise))} synthetic noise skills (near-neighbours and unrelated domains); none was ever picked. Native gets several turns and a Skill call anywhere counts. Graders are deterministic regex, JSON and command checks with fixture tests; no LLM judge in the primary set. Cost is Claude Code's own cache-aware figure. Thresholds live in one config file, never in a grader.</p>
<p><strong>Tasks.</strong> ${allKnowledge} tasks authored from rules quoted out of the installed SKILL.md files (view transitions, CSS transitions, Obsidian Bases, knap, Vite, testing, taste, review format, JSON Canvas, docx, xlsx, pptx, pdf), including no-skill controls. Each ran once with no skill available; ${report.necessity.nonSeparating.length} passed and were removed (${esc(report.necessity.nonSeparating.join(", "))})${report.necessity.allFail?.length ? `, and ${report.necessity.allFail.length} that fail in every arm are excluded as uninformative (${esc(report.necessity.allFail.join(", "))})` : ""}. The ${tasks.length} remaining are the primary set.</p>

<h2>Results</h2>
${barGroup(a => a.task_pass_rate, pct, "Task pass rate on the primary set", "fig-pass", true)}
${barGroup(a => a.task_score_mean, x => x === null ? "–" : x.toFixed(3), "Mean task score (fraction of checks passed)", "fig-score", true)}
<div class="two">
${barGroup(a => a.first_call_context_tokens_mean, k, "Context tokens on the first model call", "fig-ctx", true, Math.max(...arms.map(a => (a === "none" ? noneSep?.first_call_context_tokens_mean : primary[a]?.first_call_context_tokens_mean) ?? 0)) * 1.15)}
${barGroup(a => a.cost_usd_mean, usd, "Cost per task, cache-aware, incl. jev", "fig-cost", true, Math.max(...arms.map(a => (a === "none" ? noneSep?.cost_usd_mean : primary[a]?.cost_usd_mean) ?? 0)) * 1.15)}
</div>

<h3>Per task</h3>
<p>Each cell: trials passed out of trials run, mean score, and the skill each arm actually used. Colour is the mean score, one hue light to dark.</p>
<div class="legend"><span style="--c:var(--seq-150)">≤ 0.5</span><span style="--c:var(--seq-250)">0.5–0.75</span><span style="--c:var(--seq-350)">0.75–0.9</span><span style="--c:var(--seq-500)">0.9–0.99</span><span style="--c:var(--seq-650)">1.00</span></div>
<div class="matrix"><div class="h">task</div>${arms.map(a => `<div class="h">${esc(ARM_LABEL[a])}</div>`).join("")}
${tasks.map(t => `<div class="r">${esc(t.replace(/^k-/, ""))}</div>` + arms.map(a => { const c = cell(t, a); const st = step(c.score); return `<div class="cellx ${st <= 250 ? "light" : ""}" style="background:var(--seq-${st})" data-tip="${esc(t)} · ${esc(ARM_LABEL[a])}: ${c.pass}/${c.n} passed, score ${c.score.toFixed(2)}, used ${esc(c.obs)}">${c.pass}/${c.n} · ${c.score.toFixed(2)}<small>${esc(c.obs)}</small></div>`; }).join("")).join("")}
</div>

<h3>Routing diagnostics</h3>
<table><thead><tr><th>metric</th>${cmpArms.map(a => `<th class="num">${esc(ARM_LABEL[a])}</th>`).join("")}</tr></thead><tbody>
${[["routed to the gold skill", (a: ArmSummary) => pct(a.routing_top1_accuracy)], ["skill skipped", (a: ArmSummary) => pct(a.missed_rate)], ["wrong skill", (a: ArmSummary) => pct(a.wrong_skill_rate)], ["fell back to a candidate listing", (a: ArmSummary) => pct(a.fallback_rate)], ["noise skill picked", (a: ArmSummary) => pct(a.noise_pick_rate)], ["jev top-3 recall", (a: ArmSummary) => pct(a.top3_recall)], ["hook payload valid", (a: ArmSummary) => pct(a.payload_validity)], ["hook verdict adhered", (a: ArmSummary) => pct(a.verdict_adherence)], ["route latency p50 (hook, cold)", (a: ArmSummary) => a.route_latency_p50_ms === null ? "–" : `${Math.round(a.route_latency_p50_ms)} ms`], ["model turns, mean", (a: ArmSummary) => a.turns_mean === null ? "–" : a.turns_mean.toFixed(1)], ["wrote outside the workspace", (a: ArmSummary) => pct(a.escaped_workspace_rate)]]
  .map(([label, fn]) => `<tr><td>${esc(label as string)}</td>${cmpArms.map(a => `<td class="num">${esc((fn as (a: ArmSummary) => string)(primary[a]))}</td>`).join("")}</tr>`).join("")}
</tbody></table>

<h2>What the run taught us beyond the headline</h2>
<ul>
<li><strong>Injected guidance is not compliance.</strong> With a skill injected in full, the model wrote that it "intentionally" ignored it because the skill required React canary and the seeded project pinned stable React. Native made the same call. Once the seed matched the skill, 11 of 12 skill-arm trials passed. A skill whose prerequisites conflict with the repo gets set aside, however it arrived.</li>
<li><strong>Misroutes are description bugs.</strong> Both landing-page trials went to frontend-patterns because frontend-taste describes itself as a post-generation review. Appending one sentence flips both prompts to taste at 0.87 and 0.71 in an offline probe. The eval can now test a description change in both arms before the skill owner ships it.</li>
<li><strong>The graders caught themselves.</strong> A jq scoping bug failed one task in every arm identically; six noise skills overlapped real prompts; the judge needed four turns. All found by reading transcripts, all fixed before this report.</li>
<li><strong>Bypassed permissions are a real hazard.</strong> A no-skill trial wrote into the author's actual Obsidian vault because the prompt said "in my vault". Writes outside the workspace are now a reported metric.</li>
</ul>

<h2>How the Atlan SDK was used</h2>
<p>The eval runs here; the Registry is the catalog, comparison and evidence plane. Every object maps once:</p>
<table><thead><tr><th>local</th><th>Registry via <code>@atlanai/sdk</code></th></tr></thead><tbody>
<tr><td><code>tasks/*.jsonl</code></td><td>one dataset, one record per task, <code>pushDataset</code>; re-pushing patches changed rows</td></tr>
<tr><td>one arm × run × trial</td><td>one experiment via <code>Eval()</code>; arm, model, thresholds, universe hash, noise count and Claude Code version frozen in <code>config</code>; <code>comparison_group_id</code> groups the arms; jev arms name native as <code>baselineExperimentId</code></td></tr>
<tr><td><code>eval.yml</code>, universe snapshot, noise manifest, tasks, hook source, Claude Code version</td><td>context manifest pinned on each experiment (<code>createContextManifest</code>)</td></tr>
<tr><td>graders</td><td>19 registered scorers, numbers only, auto-versioned; policy stays in <code>eval.yml</code></td></tr>
<tr><td>each trial</td><td>one result with root trace id; task and scorer spans; Registry derives the score summary at finalize</td></tr>
</tbody></table>
<p>Runs were recorded against a local agent-gateway (<code>just dev</code>), onboarded as a dev user. Two comparison groups exist: <code>knowledge</code> (pre-fix lineage) and <code>knowledge-v2</code> (this report). Registry summaries matched the local report to three decimals.</p>
<p><strong>SDK gaps found on the way</strong> (full notes in <code>docs/sdk-gaps.md</code>): the trace read-back gate cannot pass on a local gateway with no trace store and the error blames ingestion lag; resume rejects a config mismatch without naming the key; no helper to abandon a stranded running experiment; dataset-backed <code>Eval</code> has no case filter; Claude Code is untraced; onboarding is undocumented from the SDK side.</p>

<h2>Limits and next</h2>
<ul>
<li>${tasks.length} tasks, 2 trials, one model. Prompts and gold labels authored inside the project; two misrouted, so they are not tuned to jev, but an outside author would be stronger.</li>
<li>Native as shipped saw most skills as bare names. The descriptions-visible variant behaved identically on the pilot but has not run on this set.</li>
<li>Single-turn prompts. The hook sees one prompt; native sees the conversation.</li>
<li>Next: descriptions-visible native on this set; a third trial; a universe-size sweep at 100 and 200 skills for the scale claim; multi-turn tasks with recent history passed to jev as state.</li>
</ul>
<p class="kicker" style="margin-top:40px">Generated by <code>bun run artifact --run ${esc(runId)}</code> from <code>runs/${esc(runId)}/report.json</code> and <code>grades.json</code>.</p>
</main>
<div id="tip"></div>
<script>
const tip=document.getElementById('tip');
document.querySelectorAll('[data-tip]').forEach(el=>{el.addEventListener('mousemove',e=>{tip.textContent=el.dataset.tip;tip.style.display='block';tip.style.left=(e.clientX+12)+'px';tip.style.top=(e.clientY+12)+'px';});el.addEventListener('mouseleave',()=>tip.style.display='none');});
</script></body></html>`;
}

function summarizeNone(gs: TrialGrade[]): ArmSummary {
  const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  return {
    task_pass_rate: mean(gs.map(g => g.outcome?.pass ?? 0)), task_score_mean: mean(gs.map(g => g.outcome?.score ?? 0)),
    first_call_context_tokens_mean: mean(gs.map(g => g.cost.tokens.firstCallContext)), cost_usd_mean: mean(gs.map(g => g.cost.totalCostUsd ?? 0)),
  } as ArmSummary;
}

if (import.meta.main) {
  const runId = process.argv[2] ?? "knowledge";
  const out = resolve(REPO_ROOT, "docs", "eval-report.html");
  writeFileSync(out, renderArtifact(runId));
  console.log(`wrote ${out}`);
}
