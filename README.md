# jev skill-routing eval

Does pre-routing skills with [jev](https://docs.typesafe.ai) beat Claude Code's own skill routing on the same tasks, and at what cost?

Two arms, identical tasks, identical model:

| arm | how skills reach the model |
|---|---|
| `native` | stock Claude Code: every enabled skill's description sits in the system prompt, the model decides via the Skill tool |
| `jev` | clean `CLAUDE_CONFIG_DIR` with no skills; a `UserPromptSubmit` hook asks jev which skill applies and injects that one SKILL.md |

Only routing changes between arms. Same model, same permission mode, same reasoning settings.

## What is measured

- **Harness calls jev properly**: call rate, payload validity (state = prompt, criteria = universe + none, template unchanged), verdict adherence (hook did what policy says), error passthrough.
- **Routing accuracy**: top-1, exact set, Jaccard, top-3 recall, per-skill confusion, calibration (Brier/ECE, withheld under `calibration.min_n`).
- **False delegation**: false positives on no-skill prompts, wrong-skill routes, missed routes, fallback rate. Same taxonomy for both arms.
- **Task success**: outcome graders on the workspace (file exists, regex, command exit code), an LLM judge only where code cannot answer.
- **Latency**: jev round trip p50/p95, time to first assistant event, wall time, turns, tool calls.
- **Tokens and cost**: first-call context (system prompt proxy), total context processed, cache read / creation / uncached split, Claude Code's own `total_cost_usd` plus jev's input cost.

Graders return numbers. Every threshold, gate and price lives in `eval.yml`.

## Layout

```
eval.yml                 single source of truth: jev model, policy thresholds, arms, budget, gates
src/hook/route-hook.ts   the UserPromptSubmit hook (jev arm)
src/hook/route-daemon.ts optional warm-connection daemon on a Unix socket; the hook uses it when present
src/skills.ts            discovers the routable universe from ~/.claude enabled plugins
src/jev.ts               jev client, pinned model, one choice question with a "none" option
src/arms.ts              how each arm launches `claude -p`
src/run.ts               tasks × arms × trials → runs/<id>/…/transcript.jsonl (resumable, budget-capped)
src/regrade.ts           re-score saved transcripts: the free inner loop
src/report.ts            per-arm summary, arm diff, gates → report.md / report.json
src/graders/             routing, adherence, cost, latency, outcome, calibration
tasks/tasks.jsonl        tasks with gold skills; mode full (outcome graded) or routing_only (one turn)
fixtures/ + tests/       planted cases with hand-derived answers; run before trusting any number
```

## Run

```bash
bun install
cp .env.example .env            # add TYPESAFE_API_KEY
bun test                        # grader self-test
bun run skills                  # snapshot the routable universe → universe.json
bun run route                   # offline: jev decisions for every task, no Claude spend
bun run run --mode routing_only # cheap one-turn runs, both arms
bun run run --mode full         # full runs, outcome graded
bun run regrade --run <id> [--judge]
bun run daemon                  # optional: warm jev connection; hook drops from ~1.25 s to ~0.43 s (measured), falls back to direct when absent
bun run inspect --run <id> <task> <arm> [trial]
bun run artifact <run-id>        # self-contained HTML report → docs/eval-report.html, numbers read from report.json/grades.json
```

`runs/<id>/` holds `universe.json` and `config.snapshot.yml` so a run is bounded to exactly the skill set and thresholds it saw.

## Atlan Registry (atlanai SDK)

The eval runs here; the Registry is the catalog, comparison and evidence plane. Mapping:

| local | Registry |
|---|---|
| `tasks/tasks.jsonl` | one dataset, one record per task (`bun run dataset-push`) |
| one arm × one run × one trial | one experiment; arm, thresholds, universe hash and Claude Code version frozen in `config`; `comparison_group_id` = run id |
| `eval.yml`, `universe.json`, `noise/manifest.json`, `tasks.jsonl`, hook source, Claude Code version | context manifest pinned on the experiment |
| graders in `src/graders/` | scorers (numbers only, see `SCORERS` in `src/atlan.ts`); policy stays in `eval.yml` |
| each trial | one trace with task and scorer spans, uploaded and verified by the SDK |

```bash
# .env: ATLAN_API_KEY, ATLAN_WORKSPACE_ID, ATLAN_BASE_URL (optional ATLAN_SUBJECT_ID for a registered harness)
bun run dataset-push                                   # idempotent; re-push after editing tasks
bun run atlan-eval --run r1 --arm native  --mode full   # prints experiment id
bun run atlan-eval --run r1 --arm jev     --mode full --baseline <native experiment id>
bun run atlan-eval --run r1 --arm jev --resume <experiment id>   # continue an interrupted run
```

Local Registry instead of hosted: `just dev` in `~/dev/agent-gateway`, then `bun run atlan-onboard` (writes `ATLAN_WORKSPACE_ID`),
and add `--no-verify-traces` to `atlan-eval` because local dev has no trace store (see `docs/sdk-gaps.md`).

Transcripts, decisions and `grade.json` still land under `runs/<id>/`, so `regrade` and `report` work on the same run. Gates and the arm-over-arm diff stay local in `report.md`; the Registry has no threshold or diff primitive.

## Conventions

From the internal evals handbook: score vs policy split, fixtures before scores, reference solutions prove solvability, transcripts saved to disk, cache-aware cost, pinned jev version, tasks over trials.
