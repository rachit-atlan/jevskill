import type { Decision, ParsedTranscript, TrialResult } from "../types.ts";

export interface LatencyGrade {
  routeLatencyMs: number | null;      // jev round trip, from the hook
  firstAssistantEventMs: number | null; // wall time until the model first spoke (routing sits on this path)
  wallMs: number;
  claudeDurationMs: number | null;
  numTurns: number | null;
  toolCalls: number;
}

export function gradeLatency(t: ParsedTranscript, r: TrialResult, decisions: Decision[]): LatencyGrade {
  return {
    routeLatencyMs: decisions.length ? decisions[0].latencyMs : null,
    firstAssistantEventMs: r.firstAssistantEventMs,
    wallMs: r.wallMs,
    claudeDurationMs: t.durationMs,
    numTurns: t.numTurns,
    toolCalls: t.toolCalls.length,
  };
}
