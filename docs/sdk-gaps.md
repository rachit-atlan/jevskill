# Gaps found while running this eval through `@atlanai/sdk` 0.2.4 against a local agent-gateway

Recorded 2026-09-22. Gateway: `just dev` on agent-gateway main (e1f682bd). SDK: npm 0.2.4 (main is 0.3.0, unreleased).
Each item says what happened, why it matters for an eval author, and what would close it.

## 1. `Eval` cannot finalize against a local gateway, and the error hides why

Local dev ships no ClickHouse by design ("ingest is still accepted but reads are disabled", local-dev.md). The experiment
trace facade therefore answers `503 traces_unavailable`. `Eval` polls it for the full 30 s verification window and then fails with
"Registry did not expose complete trace evidence for 1 of 1 case traces", leaving the experiment `running`. The message points
at ingestion lag, not at a deployment with no trace store.

Close it: on `503 traces_unavailable` fail fast with "this gateway has no trace read path; pass `verifyTraces: false` for local
dev" — or auto-degrade with a warning. Document in evals-and-tracing.md that `just dev` cannot satisfy the trace gate.
Workaround used here: `--no-verify-traces` (maps to `verifyTraces: false`). Results and scores land; trace ids are minted but
dangle locally.

## 2. Resume refuses without naming the differing config key

"resume experiment uses a different config" cost a round trip to find that one extra key in `config` broke the match.
Close it: print the first differing key path and both values.

## 3. No way to abandon a stranded `running` experiment from the SDK

After gap 1 the experiment stayed `running` forever. The SDK has no `markFailed` / `abandon`; a raw
`PATCH /eval/v1/experiments/{id}` with `{"experiment_status":"failed"}` worked. Close it: expose that as a helper, and mention it in
the resume section of the docs.

## 4. Dataset-backed `Eval` has no case filter

With `dataset:` set, `Eval` runs every record in the snapshot. A one-case smoke test against a Registry dataset is impossible
without a full run. Inline `data:` works around it but loses the dataset snapshot linkage. Close it: `caseFilter`/`limit`/`sample`
option on `Evaluator` that still records the dataset pin.

## 5. Claude Code / Claude Agent SDK is "manual" for tracing

Documented in the integration table. Practical effect here: the trial's model calls are invisible to the trace; the task span
carries only metadata we attach (tokens, cost, routing decision, transcript path). Close it: a stream-json → spans importer for
Claude Code transcripts would make every model turn a child span with `gen_ai.*` usage, at zero cost to the harness.

## 6. Onboarding is undocumented from the SDK side

Every create returns 409 until `POST /registry/v1/users/onboard` has run for the bearer. Nothing in the SDK docs says so, and
the SDK has no `onboard()`. Close it: one line in getting-started plus a helper. Implemented locally as `bun run atlan-onboard`.

## What worked without friction

`pushDataset` (72 records, idempotent re-push), `createContextManifest`, experiment create with frozen `config`, per-case
result upload with all 18 scorer axes, scorer auto-registration and version pinning, `baselineExperimentId`, and the
finalize step returning the Registry-derived score summary — which matched the local `report.md` to three decimals.
