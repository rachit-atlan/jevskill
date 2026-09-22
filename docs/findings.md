# Findings: jev as a skill router for Claude Code

Run `k25`, 2026-09-22. Claude Code 2.1.278, model sonnet, jev-1.13.0. Universe: 31 installed skills (plugins + synced
document skills) + 30 synthetic noise skills, identical in every arm. Tasks: 30 authored from rules quoted out of the installed
SKILL.md files; 8 removed by the no-skill filter, 2 excluded as failing in every arm, **20 in the primary set**. Primary arms two
trials, robustness arms one. Spend: $5.6 filter + $43.1 main. Supersedes the `knowledge` run (12 tasks, 51 skills).

## Headline, on the 20 tasks that need a skill

| | native (as shipped) | jev pointer (hook) | jev MCP, nudged | native, full descriptions | jev body (hook) | jev MCP, unprompted |
|---|---:|---:|---:|---:|---:|---:|
| task pass rate | 72.5% | 82.5% | 65.0% | 60.0% | 75.0% | 20.0% |
| task score, mean | 0.899 | 0.950 | 0.873 | 0.866 | 0.934 | 0.576 |
| routed to the gold skill | 87.5% | 95.0% | 82.5% | 85.0% | 95.0% | 0.0% |
| missed the skill | 10.0% | 0.0% | 15.0% | 10.0% | 0.0% | 100.0% |
| wrong skill | 0.0% | 5.0% | 0.0% | 0.0% | 5.0% | 0.0% |
| first-call context tokens | 35.8K | 27.9K | 27.8K | 35.8K | 29.4K | 27.8K |
| cost per task | $0.250 | $0.212 | $0.242 | $0.224 | $0.202 | $0.212 |
| trials | 40 | 40 | 40 | 20 | 20 | 20 |

No skill at all: 36.7% pass on the primary set (two tasks pass their hard checks but score below 0.9).
Per task, jev pointer beat native on 5, lost on 2, tied on 13. jev MCP nudged: won 4, lost 7, tied 9.

## What the run showed

1. **Routing through the hook is the win; routing through the agent is not.** Pointer injection passed 82.5%
   against native's 72.5%, at 22% less context and 15% lower cost. Given the same jev as an MCP tool with no
   instruction, the agent called it on 0.0% of trials and passed 20.0%. One system-prompt line raised
   calls to 86.4% (first tool call 50.0%), but the nudged arm still trailed native. Claude Code defers MCP tool schemas, so
   the agent saw only the tool name until it searched. The agent does not know it needs a router; the harness has to decide.
2. **Native's failure mode is skipping, not confusing.** Native routed to the right skill 87.5% of the
   time and never picked a wrong or noise skill; it skipped the applicable skill on 10.0% of trials,
   concentrated on the CSS-transition tasks, and those trials failed. jev never skipped.
3. **Full descriptions did not help native.** With the listing budget raised so every description was visible, native passed
   60.0% (one trial) against 72.5% as shipped, with the same skip rate.
   Native's misses are propensity, not information. The listing cap (~15k chars, alphabetical truncation) remains a real
   finding about Claude Code but is not what separates the arms here.
4. **jev's errors are description bugs.** 5.0% wrong-skill routes, all on generation prompts
   sent to frontend-patterns because frontend-taste and web-interface-review describe themselves as review passes. A one-sentence
   description change flips them (offline probe); testable in both arms via `universe.description_overrides`.
5. **Pointer ≥ body.** One line naming the skill and its path scored as well as injecting the ~12k body, at the lowest context of
   any arm. Body injection: 75.0% (one trial).
6. **Document skills route trivially and native takes them.** Prompts naming .docx/.pptx/.xlsx routed at 1.00 in every arm and
   native invoked those skills every time. The separation comes from skills whose prompts lack a file-extension trigger.
7. **Injected guidance is not compliance.** In the previous run the model overrode an injected skill because its prerequisite
   (React canary) conflicted with the seeded repo. Seeds must not contradict the skill under test.
8. **The graders caught themselves again.** Five checks were stricter than the skill text (jq scoping, TOC field order, exact
   yellow, Latin-1 superscripts, grep -c on PDFs, render-vs-batch); all found by reading transcripts of tasks that failed in every
   arm, all corrected by regrade with no model spend. Two tasks remain uninformative (pdf-report, wir-signin).
9. **The one-trial necessity filter is noisy.** Both Bases tasks failed without a skill in the previous run and passed this
   time, so they were cut. Next run: two filter trials, cut only tasks that pass both.
10. **Hazards.** With permissions bypassed a no-skill trial once wrote into the author's real vault; writes outside the workspace
    are now a metric (0 on skill arms this run apart from /tmp scratch).

## Limits

- 20 tasks × 2 trials for primary arms; robustness arms one trial. The pointer-vs-native gap is 4 trials of 40.
- Prompts and gold labels authored inside the project; the two misroutes show they are not tuned to jev.
- Single model, single-turn prompts. The hook sees one prompt; native sees the conversation.
- Everything ran at 61 skills. The "100+ skills" claim is untested; native's failure mode here was propensity, not confusion.

## Registry

Local agent-gateway. Dataset `jev-skill-routing-tasks`. Comparison groups: `k25` (pre-fix grades) and `k25-v2` (this
report): none, native ×2, native-full, jev-pointer ×2 (baseline native t0), jev-mcp-nudged ×2, jev, jev-mcp.
Trace verification disabled: local dev has no trace store (`docs/sdk-gaps.md`).

## Next

1. Two-trial necessity filter. 2. Third trial on the primary arms. 3. Universe-size sweep 20/50/100/200 on `tasks/sweep`.
4. Multi-turn tasks with recent history as jev's state. 5. Top-k pointer injection when the second candidate is close.
