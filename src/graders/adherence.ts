/** Did the harness call jev properly and do what jev said? Pure checks over Decision records. */
import type { Decision, Universe } from "../types.ts";
import { NONE } from "../jev.ts";
import { applyPolicy } from "../hook/route-hook.ts";

export interface AdherenceGrade {
  called: number;            // 1 if at least one decision exists for the trial
  callCount: number;
  payloadValid: number;      // state == prompt, criteria == universe ∪ none, instructions == template
  payloadErrors: string[];
  verdictAdhered: number;    // hook action == policy(response)
  errored: number;           // jev call failed
  errorHandled: number;      // if errored, hook still returned (passthrough) rather than injecting garbage
}

export function gradeAdherence(
  decisions: Decision[],
  expectedPrompt: string,
  universe: Universe,
  template: { instructions: string; questionId: string; noneDescription: string },
): AdherenceGrade {
  const g: AdherenceGrade = { called: decisions.length ? 1 : 0, callCount: decisions.length, payloadValid: 0, payloadErrors: [], verdictAdhered: 0, errored: 0, errorHandled: 1 };
  if (!decisions.length) return g;
  const d = decisions[0];
  const errs: string[] = [];
  const req: any = d.request;
  const q = req?.questions?.[template.questionId];
  if (req?.state !== expectedPrompt) errs.push("state != prompt");
  if (!q) errs.push("question missing");
  else {
    if (q.type !== "choice") errs.push("type != choice");
    if (q.instructions !== template.instructions) errs.push("instructions drifted");
    const keys = new Set(Object.keys(q.criteria ?? {}));
    const want = new Set([...universe.skills.map(s => s.id), NONE]);
    for (const k of want) if (!keys.has(k)) errs.push(`criteria missing ${k}`);
    for (const k of keys) if (!want.has(k)) errs.push(`criteria extra ${k}`);
    if (q.criteria?.[NONE] !== template.noneDescription) errs.push("none description drifted");
  }
  g.payloadErrors = errs; g.payloadValid = errs.length ? 0 : 1;
  if (d.error) {
    g.errored = 1;
    g.errorHandled = d.action === "error_passthrough" && d.injected.length === 0 ? 1 : 0;
    g.verdictAdhered = g.errorHandled;
    return g;
  }
  if (d.response) {
    const expect = applyPolicy(d.response, d.policy, new Set(universe.skills.map(s => s.id)));
    g.verdictAdhered = expect.action === d.action && sameSet(expect.injected, d.injected) ? 1 : 0;
  }
  return g;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every(x => b.includes(x));
}
