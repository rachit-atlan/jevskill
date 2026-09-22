/**
 * Code-based routing graders. Pure functions over (gold, observed). No thresholds here.
 * The same taxonomy applies to both arms: for jev it is what the hook injected, for native
 * it is which skills the model invoked through the Skill tool.
 */
import { NONE } from "../jev.ts";

export type RoutingCategory =
  | "correct"        // gold has skills, observed set equals gold set
  | "partial"        // multi-skill gold, observed is a non-empty strict subset
  | "correct_none"   // gold empty, observed empty
  | "false_positive" // gold empty, observed non-empty       (false delegation)
  | "wrong_skill"    // gold non-empty, observed non-empty, disjoint from gold (false delegation)
  | "missed"         // gold non-empty, observed empty
  | "fallback";      // router injected a candidate listing instead of deciding

export interface RoutingGrade {
  category: RoutingCategory;
  top1Correct: number;      // 1 if primary observed skill is in gold (or both empty)
  setExact: number;         // 1 if observed set == gold set
  jaccard: number;          // |gold ∩ obs| / |gold ∪ obs|, 1 when both empty
  falseDelegation: number;  // 1 for false_positive or wrong_skill
  missed: number;
}

export function gradeRouting(gold: string[], observed: string[], isFallback = false): RoutingGrade {
  const g = new Set(gold), o = new Set(observed.filter(x => x !== NONE));
  const inter = [...g].filter(x => o.has(x)).length;
  const union = new Set([...g, ...o]).size;
  const jaccard = union === 0 ? 1 : inter / union;
  const setExact = jaccard === 1 ? 1 : 0;
  let category: RoutingCategory;
  if (isFallback) category = "fallback";
  else if (g.size === 0 && o.size === 0) category = "correct_none";
  else if (g.size === 0) category = "false_positive";
  else if (o.size === 0) category = "missed";
  else if (inter === 0) category = "wrong_skill";
  else if (setExact) category = "correct";
  else category = "partial";
  const primary = observed[0];
  const top1Correct = g.size === 0 ? (o.size === 0 ? 1 : 0) : (primary && g.has(primary) ? 1 : 0);
  return {
    category, top1Correct, setExact, jaccard,
    falseDelegation: category === "false_positive" || category === "wrong_skill" ? 1 : 0,
    missed: category === "missed" ? 1 : 0,
  };
}

/** Rank-based: is any gold skill within the top-k of jev's distribution (excluding none)? */
export function topKHit(gold: string[], probabilities: Record<string, number>, k: number): number {
  if (gold.length === 0) {
    const sorted = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] === NONE ? 1 : 0;
  }
  const ranked = Object.entries(probabilities).filter(([id]) => id !== NONE).sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => id);
  return gold.some(g => ranked.includes(g)) ? 1 : 0;
}

/** Probability jev assigned to the gold answer (P(none) when gold is empty); for calibration. */
export function goldProbability(gold: string[], probabilities: Record<string, number>): number {
  if (gold.length === 0) return probabilities[NONE] ?? 0;
  return Math.max(...gold.map(g => probabilities[g] ?? 0));
}
