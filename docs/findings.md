# Findings: jev as a skill router for Claude Code

Run `knowledge`, 2026-09-22. Claude Code 2.1.278, model sonnet, jev-1.13.0. Universe: 21 installed skills + 30 synthetic noise
skills, identical in every arm. Tasks: 17 authored from rules quoted out of the installed SKILL.md files; 5 removed by the
necessity filter (solved with no skill at all), 12 kept. Two trials per arm. Spend: $3.4 filter + $14.8 main + $2.5 rerun.

## Headline, on the 12 tasks that need a skill

| | none | native (as shipped) | jev, body injected | jev, pointer injected |
|---|---:|---:|---:|---:|
| task pass rate | 0 / 12 | 75.0% | **87.5%** | 83.3% |
| task score, mean | 0.52 | 0.914 | **0.949** | 0.948 |
| routed to the gold skill | – | 87.5% | 91.7% | 91.7% |
| missed the skill | – | 12.5% | 0% | 0% |
| wrong skill | – | 0% | 8.3% | 8.3% |
| first-call context tokens | 27.7K | 33.6K | 29.0K | **28.0K** |
| cost per task (cache-aware) | $0.17 | $0.180 | **$0.138** | $0.159 |
| hook payload valid / verdict adhered | – | – | 100% / 100% | 100% / 100% |

Per task, neither jev arm ever lost a task to native. jev won outright on the review-format task (2/2 vs 0/2) and the knap batch
task (2/2 vs 1/2); the pointer arm won the shake animation (2/2 vs 1/2). Both jev arms lost both landing-page trials to a
misroute (see 3).

## What the eval showed

1. **jev's value in this harness is uptake, not classification.** Native Claude Code routed well on these house-specific
   prompts (87.5%) but skipped the applicable skill on 3 of 24 trials, and each skip cost the task. jev never skipped.
   On the easier pilot set native skipped 3 of 4 skill tasks. Skill uptake is the variable jev controls.
2. **Native's skill listing is capped.** Claude Code truncates the listing at ~15k characters (`SLASH_COMMAND_TOOL_CHAR_BUDGET`);
   at 63 skills, 49 appeared as bare names. Descriptions-visible native behaved identically on the pilot; not yet run on this set.
3. **Misroutes trace to one description.** frontend-taste describes itself as a post-generation review pass. Both generation
   prompts routed to frontend-patterns at 0.77/0.92. Appending one sentence ("also use when generating a landing page, hero or
   dashboard") flips them to taste at 0.87/0.71 (offline probe). Recommend to the atlan-frontend owner; testable in both arms via
   `universe.description_overrides` before shipping.
4. **Injected guidance is not compliance.** With the view-transition skill injected in full, the model wrote that it "intentionally"
   used the raw browser API because the seeded project pinned stable React and the skill requires canary. Native made the same
   call. With canary seeded, 11/12 skill-arm trials pass. Skills whose prerequisites conflict with the repo get set aside.
5. **Pointer injection is as good as body injection and cheaper in context.** A one-line pointer (~400 chars) scored the same
   as the ~12k body; the model reads the file when it wants it.
6. **Cost and context.** Context per call down 14-17%. Cost per task down 12-23%. The listing is cached after turn one, so the
   token saving is bounded; the cost saving is mostly fewer wasted turns.
7. **Hook latency.** 1.25 s per prompt cold, of which ~500 ms is TCP+TLS setup and ~330 ms is jev. A warm-connection daemon
   (`bun run daemon`) brings the hook to ~0.43 s.
8. **Hazard.** With permissions bypassed, a no-skill trial wrote into the user's real Obsidian vault because the prompt said
   "in my vault". Prompts are now location-explicit and writes outside the workspace are a reported metric (0 in skill arms after
   the fix; 2 harmless /tmp scratch writes).

## Grader bugs the run caught (fixed)

- The canvas edge check evaluated `.fromNode` against the id array (jq scoping); failed every arm identically.
- Six noise skills overlapped no-skill prompts (shell-scripting etc.); replaced with domains no task touches.
- The LLM judge needed 4 turns (structured output arrives via a tool call); unused in the primary set.

## Limits

- n = 12 tasks × 2 trials. The pass-rate gap is 3 trials of 24; direction is consistent, magnitude is rough.
- Prompts and gold labels authored inside the project; two misrouted, so they are not tuned to jev, but an outside author would be stronger.
- Descriptions-visible native not run on this set. Single model. Single-turn prompts only; the hook sees one prompt.
- Everything ran at 51 skills. The "50-100+ skills" differentiator is untested; native's failure mode here was propensity, not confusion.

## Registry

Local agent-gateway, workspace onboarded as alice. Dataset `jev-skill-routing-tasks` (72 records). Experiments in comparison
group `knowledge-v2`: none, native ×2, jev ×2 (baseline native t0), jev-pointer ×2. Earlier group `knowledge` holds the
pre-fix lineage. Trace verification disabled because local dev has no trace store (`docs/sdk-gaps.md`).

## Next

1. Descriptions-visible native on this set (~$4.5). 2. Third trial (~$5). 3. Universe-size sweep 20/50/100/200 on routing-only
tasks with generated noise. 4. Multi-turn tasks, passing recent history to jev as state.
