/** Brier and ECE with a small-n guard: below min_n these return null rather than a misleading number. */
export interface CalibrationReport { n: number; brier: number | null; ece: number | null; bins: { lo: number; hi: number; n: number; meanConf: number; accuracy: number }[] | null }

export function calibration(pairs: { p: number; correct: number }[], minN: number, bins = 10): CalibrationReport {
  const n = pairs.length;
  if (n < minN) return { n, brier: null, ece: null, bins: null };
  const brier = pairs.reduce((s, x) => s + (x.p - x.correct) ** 2, 0) / n;
  const buckets = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, sumP: 0, sumC: 0 }));
  for (const x of pairs) {
    const i = Math.min(bins - 1, Math.floor(x.p * bins));
    buckets[i].n++; buckets[i].sumP += x.p; buckets[i].sumC += x.correct;
  }
  let ece = 0;
  const out = buckets.map(b => {
    const meanConf = b.n ? b.sumP / b.n : 0, accuracy = b.n ? b.sumC / b.n : 0;
    ece += (b.n / n) * Math.abs(accuracy - meanConf);
    return { lo: b.lo, hi: b.hi, n: b.n, meanConf, accuracy };
  });
  return { n, brier, ece, bins: out };
}
