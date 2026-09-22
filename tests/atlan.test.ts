import { test, expect } from "bun:test";
import { taskRecords, SCORERS, scoreRow } from "../src/atlan.ts";
import type { TrialGrade } from "../src/regrade.ts";
import type { Task } from "../src/types.ts";

const task: Task = { id: "t1", prompt: "do x", gold: ["a-x"], mode: "full", tags: ["x"], checks: [{ type: "file_exists", path: "f" }] };

test("taskRecords: stable name, input carries id, expected carries gold+checks", () => {
  const [r] = taskRecords([task]);
  expect(r.name).toBe("t1");
  expect((r.input as any).id).toBe("t1");
  expect((r.expected as any).gold).toEqual(["a-x"]);
  expect((r.expected as any).checks).toHaveLength(1);
});

const grade: TrialGrade = {
  task: "t1", arm: "jev", trial: 0, gold: ["a-x"], mode: "full", tags: [], observed: ["a-x"], observedNoise: 0, routerCalled: null, routerCalledFirst: null,
  routing: { category: "correct", top1Correct: 1, setExact: 1, jaccard: 1, falseDelegation: 0, missed: 0 },
  top3Hit: 1, goldProb: 0.97, confidence: 0.96, jevChoice: "a-x", injectMode: "body",
  adherence: { called: 1, callCount: 1, payloadValid: 1, payloadErrors: [], verdictAdhered: 1, errored: 0, errorHandled: 1 },
  cost: { claudeCostUsd: 0.09, jevCostUsd: 0.0002, totalCostUsd: 0.0902, jevInputTokens: 5000, injectedChars: 12000,
    tokens: { input: 10, cacheCreation: 5000, cacheRead: 23000, output: 300, contextProcessed: 28010, firstCallContext: 28010, modelCalls: 1 } },
  latency: { routeLatencyMs: 340, firstAssistantEventMs: 4000, wallMs: 9000, claudeDurationMs: 8500, numTurns: 3, toolCalls: 2 },
  outcome: { pass: 1, score: 0.8, checks: [], judgeCostUsd: 0 },
  transcriptError: false, outsideWrites: [],
};

test("scorers: every axis yields number/boolean/null and names are unique", () => {
  const names = SCORERS.map(s => s.name);
  expect(new Set(names).size).toBe(names.length);
  const row = scoreRow(grade);
  for (const [k, v] of Object.entries(row)) expect(v === null || typeof v === "number" || typeof v === "boolean", k).toBe(true);
  expect(row.routing_top1).toBe(1); expect(row.task_pass).toBe(1); expect(row.route_latency_ms).toBe(340); expect(row.cost_usd).toBeCloseTo(0.0902, 6);
});

test("scorers: native arm leaves jev-only axes null, routing-only leaves outcome axes null", () => {
  const native = { ...grade, arm: "native", adherence: null, confidence: null, top3Hit: null, outcome: null, latency: { ...grade.latency, routeLatencyMs: null } };
  const row = scoreRow(native);
  expect(row.route_latency_ms).toBeNull(); expect(row.hook_verdict_adhered).toBeNull(); expect(row.task_pass).toBeNull();
  expect(row.routing_top1).toBe(1);
});
