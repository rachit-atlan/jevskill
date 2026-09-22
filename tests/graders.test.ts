import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { gradeRouting, topKHit, goldProbability } from "../src/graders/routing.ts";
import { applyPolicy } from "../src/hook/route-hook.ts";
import { gradeAdherence } from "../src/graders/adherence.ts";
import { calibration } from "../src/graders/calibration.ts";
import { parseTranscript } from "../src/transcript.ts";
import { parseFrontmatter } from "../src/skills.ts";
import { extractChoice } from "../src/jev.ts";
import type { Decision, Universe } from "../src/types.ts";
import cases from "../fixtures/cases.json" with { type: "json" };

const FIX = resolve(import.meta.dir, "../fixtures");

test.each(cases as any[])("routing fixture: $name", (c) => {
  const g = gradeRouting(c.gold, c.observed, c.fallback);
  expect(g.category).toBe(c.expect.category);
  expect(g.top1Correct).toBe(c.expect.top1);
  expect(g.falseDelegation).toBe(c.expect.falseDelegation);
  expect(g.missed).toBe(c.expect.missed);
  expect(g.jaccard).toBeCloseTo(c.expect.jaccard, 6);
});

const policy = { threshold: 0.6, fallback: "listing", fallbackTopK: 3, routeNoneMinProb: 0.5 };
const known = new Set(["a:x", "a:y", "a:z", "b:w"]);

test("policy: confident skill → inject_skill", () => {
  const r = applyPolicy({ choice: "a:x", confidence: 0.9, probabilities: { "a:x": 0.9, "a:y": 0.05, none: 0.05 } }, policy, known);
  expect(r).toEqual({ action: "inject_skill", injected: ["a:x"] });
});
test("policy: none chosen → inject_none", () => {
  const r = applyPolicy({ choice: "none", confidence: 0.8, probabilities: { none: 0.8, "a:x": 0.2 } }, policy, known);
  expect(r).toEqual({ action: "inject_none", injected: [] });
});
test("policy: skill chosen but P(none) high → inject_none", () => {
  const r = applyPolicy({ choice: "a:x", confidence: 0.7, probabilities: { "a:x": 0.45, none: 0.55 } }, policy, known);
  expect(r.action).toBe("inject_none");
});
test("policy: low confidence → listing of top-3 excluding none, ranked", () => {
  const r = applyPolicy({ choice: "a:x", confidence: 0.3, probabilities: { "a:x": 0.35, "a:y": 0.3, none: 0.2, "b:w": 0.1, "a:z": 0.05 } }, policy, known);
  expect(r.action).toBe("inject_listing");
  expect(r.injected).toEqual(["a:x", "a:y", "b:w"]);
});
test("policy: unknown skill id is never injected", () => {
  const r = applyPolicy({ choice: "ghost", confidence: 0.99, probabilities: { ghost: 0.99, none: 0.01 } }, policy, known);
  expect(r.action).not.toBe("inject_skill");
});
test("policy: fallback=none injects nothing on low confidence", () => {
  const r = applyPolicy({ choice: "a:x", confidence: 0.3, probabilities: { "a:x": 0.35, "a:y": 0.3, none: 0.35 } }, { ...policy, fallback: "none" }, known);
  expect(r).toEqual({ action: "inject_none", injected: [] });
});

test("topKHit and goldProbability", () => {
  const p = { "a:x": 0.2, "a:y": 0.5, none: 0.3 };
  expect(topKHit(["a:x"], p, 1)).toBe(0);
  expect(topKHit(["a:x"], p, 2)).toBe(1);
  expect(topKHit([], p, 3)).toBe(0);
  expect(topKHit([], { none: 0.9, "a:x": 0.1 }, 3)).toBe(1);
  expect(goldProbability(["a:x"], p)).toBe(0.2);
  expect(goldProbability([], p)).toBe(0.3);
});

const universe: Universe = { createdAt: "", configDir: "", skills: [
  { id: "a:x", plugin: "a", name: "x", description: "X", path: "/x", bodyBytes: 1, noise: false },
  { id: "a:y", plugin: "a", name: "y", description: "Y", path: "/y", bodyBytes: 1, noise: false },
] };
const tmpl = { instructions: "Which skill?", questionId: "skill", noneDescription: "No skill." };
function decision(over: Partial<Decision>): Decision {
  return {
    version: 1, arm: "jev", sessionId: null, promptId: null, prompt: "hello", universeHash: "h",
    request: { model: "jev-1.13.0", state: "hello", questions: { skill: { type: "choice", instructions: tmpl.instructions, criteria: { "a:x": "X", "a:y": "Y", none: "No skill." } } } },
    response: { choice: "a:x", probabilities: { "a:x": 0.9, "a:y": 0.05, none: 0.05 }, confidence: 0.9 }, rawResponse: null, model: "jev-1.13.0",
    jevInputTokens: 100, latencyMs: 120, error: null, policy: { threshold: 0.6, fallback: "listing", fallbackTopK: 3, routeNoneMinProb: 0.5 },
    action: "inject_skill", injected: ["a:x"], injectedChars: 500, timestamp: "", ...over,
  };
}
test("adherence: well-formed call and honoured verdict", () => {
  const g = gradeAdherence([decision({})], "hello", universe, tmpl);
  expect(g).toMatchObject({ called: 1, callCount: 1, payloadValid: 1, verdictAdhered: 1, errored: 0 });
});
test("adherence: no call at all", () => {
  expect(gradeAdherence([], "hello", universe, tmpl).called).toBe(0);
});
test("adherence: state drifted from prompt", () => {
  const d = decision({}); (d.request as any).state = "different";
  const g = gradeAdherence([d], "hello", universe, tmpl);
  expect(g.payloadValid).toBe(0); expect(g.payloadErrors).toContain("state != prompt");
});
test("adherence: criteria missing a universe skill", () => {
  const d = decision({}); delete (d.request as any).questions.skill.criteria["a:y"];
  expect(gradeAdherence([d], "hello", universe, tmpl).payloadErrors).toContain("criteria missing a:y");
});
test("adherence: hook injected something jev did not pick", () => {
  const g = gradeAdherence([decision({ injected: ["a:y"] })], "hello", universe, tmpl);
  expect(g.verdictAdhered).toBe(0);
});
test("adherence: hook ignored a confident verdict", () => {
  const g = gradeAdherence([decision({ action: "inject_none", injected: [] })], "hello", universe, tmpl);
  expect(g.verdictAdhered).toBe(0);
});
test("adherence: jev error handled by passthrough", () => {
  const g = gradeAdherence([decision({ error: "timeout", response: null, action: "error_passthrough", injected: [] })], "hello", universe, tmpl);
  expect(g).toMatchObject({ errored: 1, errorHandled: 1, verdictAdhered: 1 });
});
test("adherence: jev error but hook still injected → not handled", () => {
  const g = gradeAdherence([decision({ error: "timeout", response: null, action: "inject_skill", injected: ["a:x"] })], "hello", universe, tmpl);
  expect(g.errorHandled).toBe(0);
});

test("calibration: n-guard withholds numbers", () => {
  const r = calibration([{ p: 0.9, correct: 1 }], 30);
  expect(r.brier).toBeNull(); expect(r.ece).toBeNull(); expect(r.n).toBe(1);
});
test("calibration: perfect and worst-case Brier", () => {
  const perfect = Array.from({ length: 40 }, () => ({ p: 1, correct: 1 }));
  expect(calibration(perfect, 30).brier).toBe(0);
  const worst = Array.from({ length: 40 }, () => ({ p: 1, correct: 0 }));
  expect(calibration(worst, 30).brier).toBe(1);
  expect(calibration(worst, 30).ece).toBeCloseTo(1, 6);
});

test("transcript: skill call, usage per message, result totals", () => {
  const t = parseTranscript(`${FIX}/transcript.native.jsonl`);
  expect(t.skillToolCalls).toEqual(["atlan-frontend-tanstack"]); // plugin:skill is normalised to the flattened id
  expect(t.usage.modelCalls).toBe(2);
  expect(t.usage.firstCallContext).toBe(12 + 7000 + 13000);
  expect(t.usage.contextProcessed).toBe(20012 + 23050);
  expect(t.totalCostUsd).toBeCloseTo(0.0421, 6);
  expect(t.numTurns).toBe(2); expect(t.isError).toBe(false);
});

test("frontmatter: quoted, plain and folded descriptions", () => {
  expect(parseFrontmatter(`---\nname: a\ndescription: "Hello: world"\n---\nbody`).fm.description).toBe("Hello: world");
  expect(parseFrontmatter(`---\nname: a\ndescription: >-\n  line one\n  line two\n---\n`).fm.description).toBe("line one line two");
  expect(parseFrontmatter(`no frontmatter`).fm.description).toBeUndefined();
});

test("jev: extractChoice tolerates envelope variants and rejects garbage", () => {
  expect(extractChoice({ answers: { skill: { choice: "a", probabilities: { a: 1 }, confidence: 0.9 } } }, "skill").choice).toBe("a");
  expect(extractChoice({ skill: { choice: "a", probabilities: { a: 1 }, confidence: 0.9 } }, "skill").choice).toBe("a");
  expect(() => extractChoice({ answers: {} }, "skill")).toThrow();
});

test("hook pointer render names the skill and its path, and stays tiny", async () => {
  const { renderPointer } = await import("../src/hook/route-hook.ts");
  const out = renderPointer({ id: "a-x", plugin: "a", name: "x", description: "X", path: "/skills/a-x/SKILL.md", bodyBytes: 9000, noise: false });
  expect(out).toContain("a-x"); expect(out).toContain("/skills/a-x/SKILL.md"); expect(out.length).toBeLessThan(300);
});

test("outcome checks: file_not_matches and glob paths", async () => {
  const { runCodeCheck } = await import("../src/graders/outcome.ts");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const ws = mkdtempSync("/tmp/jevroute-ws-");
  mkdirSync(join(ws, "src/a"), { recursive: true });
  writeFileSync(join(ws, "src/a/x.tsx"), "const a = 1; // transition-all here");
  writeFileSync(join(ws, "src/b.tsx"), "export const ok = true;");
  const t: any = { toolCalls: [], skillToolCalls: [], usage: {}, resultText: "" };
  expect(runCodeCheck({ type: "file_matches", path: "src/**/*.tsx", regex: "transition-all" }, ws, t).pass).toBe(true);
  expect(runCodeCheck({ type: "file_not_matches", path: "src/**/*.tsx", regex: "transition-all" }, ws, t).pass).toBe(false);
  expect(runCodeCheck({ type: "file_not_matches", path: "src/b.tsx", regex: "transition-all" }, ws, t).pass).toBe(true);
  expect(runCodeCheck({ type: "file_matches", path: "src/**/*.css", regex: "x" }, ws, t).pass).toBe(false); // no files → fail
  expect(runCodeCheck({ type: "file_not_matches", path: "src/**/*.css", regex: "x" }, ws, t).pass).toBe(true); // no files → nothing banned
});

test("description_overrides apply to the universe (append) and flag the skill", async () => {
  const { discoverUniverse } = await import("../src/skills.ts");
  const { loadConfig } = await import("../src/config.ts");
  const cfg = loadConfig();
  const saved = cfg.universe.description_overrides;
  cfg.universe.description_overrides = { "atlan-frontend-frontend-taste": { append: " ZZZ-MARK" } };
  try {
    const u = discoverUniverse();
    const t = u.skills.find(s => s.id === "atlan-frontend-frontend-taste")!;
    expect(t.description.endsWith("ZZZ-MARK")).toBe(true);
    expect(t.descriptionOverridden).toBe(true);
    expect(u.skills.find(s => s.id === "atlan-frontend-vite")!.descriptionOverridden).toBeUndefined();
  } finally { cfg.universe.description_overrides = saved; }
});
