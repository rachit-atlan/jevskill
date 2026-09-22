import type { Decision, ParsedTranscript } from "../types.ts";

export interface CostGrade {
  claudeCostUsd: number | null;   // Claude Code's own cache-aware figure
  jevCostUsd: number;
  totalCostUsd: number | null;
  tokens: ParsedTranscript["usage"];
  jevInputTokens: number;
  injectedChars: number;
}

export function gradeCost(t: ParsedTranscript, decisions: Decision[], jevPricePerM: number): CostGrade {
  const jevTokens = decisions.reduce((s, d) => s + (d.jevInputTokens ?? 0), 0);
  const jevCostUsd = (jevTokens / 1_000_000) * jevPricePerM;
  return {
    claudeCostUsd: t.totalCostUsd,
    jevCostUsd,
    totalCostUsd: t.totalCostUsd === null ? null : t.totalCostUsd + jevCostUsd,
    tokens: t.usage,
    jevInputTokens: jevTokens,
    injectedChars: decisions.reduce((s, d) => s + d.injectedChars, 0),
  };
}
