import { existsSync } from "node:fs";
import { loadConfig, requireEnv } from "./config.ts";
import type { JevRouteResponse, SkillInfo } from "./types.ts";

export const NONE = "none";

export interface JevRequest {
  model: string;
  state: string;
  questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>;
}

export function buildRouteRequest(prompt: string, skills: SkillInfo[]): JevRequest {
  const cfg = loadConfig();
  const criteria: Record<string, string> = {};
  for (const s of skills) criteria[s.id] = s.description;
  criteria[NONE] = cfg.jev.none_description;
  return {
    model: cfg.jev.model,
    state: prompt,
    questions: { [cfg.jev.question_id]: { type: "choice", instructions: cfg.jev.instructions, criteria } },
  };
}

export interface JevCallResult {
  response: JevRouteResponse;
  raw: unknown;
  model: string | null;
  inputTokens: number | null;
  latencyMs: number;
}

/** Pull the choice answer out of the response regardless of minor envelope differences. */
export function extractChoice(raw: any, questionId: string): JevRouteResponse {
  const ans = raw?.answers?.[questionId] ?? raw?.[questionId] ?? raw?.results?.[questionId];
  if (!ans || typeof ans.choice !== "string") {
    throw new Error(`jev response missing choice for question "${questionId}": ${JSON.stringify(raw).slice(0, 300)}`);
  }
  return {
    choice: ans.choice,
    probabilities: ans.probabilities ?? {},
    confidence: typeof ans.confidence === "number" ? ans.confidence : NaN,
  };
}

/** Route through the warm-connection daemon when its socket exists; otherwise call jev directly. */
export async function callJev(req: JevRequest): Promise<JevCallResult & { via: "daemon" | "direct" }> {
  const cfg = loadConfig();
  const sock = cfg.jev.daemon_socket ?? "/tmp/jevroute.sock";
  if (existsSync(sock)) {
    try {
      const r = await callJevVia(req, (init) => fetch("http://jevroute.local/route", { ...init, unix: sock } as RequestInit));
      return { ...r, via: "daemon" };
    } catch (err) {
      if (process.env.JEVROUTE_DEBUG) console.error(`daemon call failed, falling back to direct: ${err}`);
    }
  }
  const key = requireEnv("TYPESAFE_API_KEY");
  const r = await callJevVia(req, (init) => fetch(cfg.jev.endpoint, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${key}` } }));
  return { ...r, via: "direct" };
}

async function callJevVia(req: JevRequest, doFetch: (init: RequestInit) => Promise<Response>): Promise<JevCallResult> {
  const cfg = loadConfig();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.jev.timeout_ms);
  const t0 = performance.now();
  try {
    const res = await doFetch({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal: ctrl.signal,
    });
    const latencyMs = performance.now() - t0;
    const text = await res.text();
    if (!res.ok) throw new Error(`jev HTTP ${res.status}: ${text.slice(0, 300)}`);
    const raw = JSON.parse(text);
    return {
      response: extractChoice(raw, cfg.jev.question_id),
      raw,
      model: raw?.model ?? null,
      inputTokens: raw?.usage?.input_tokens ?? raw?.usage?.prompt_tokens ?? null,
      latencyMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function topK(probabilities: Record<string, number>, k: number, exclude: string[] = []): string[] {
  const ex = new Set(exclude);
  return Object.entries(probabilities)
    .filter(([id]) => !ex.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id]) => id);
}
