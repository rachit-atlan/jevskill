import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import YAML from "yaml";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface EvalConfig {
  jev: {
    model: string; endpoint: string; price_per_m_input_usd: number; timeout_ms: number;
    question_id: string; instructions: string; none_description: string; daemon_socket?: string;
  };
  policy: { confidence_threshold: number; fallback: "listing" | "none"; fallback_top_k: number; route_none_min_prob: number; inject_mode?: "body" | "pointer" };
  universe: { source: string; claude_config_dir: string; include_personal_skills: boolean; include_synced_skills?: boolean; exclude: string[]; noise_dir?: string; include_noise?: boolean; description_overrides?: Record<string, { append?: string; replace?: string }> };
  arms: Record<string, { base: "native" | "jev" | "bare" | "mcp" | "real"; description: string; env?: Record<string, string>; append_system_prompt?: string }>;
  claude: { model: string; max_turns_full: number; max_turns_routing_only: number; permission_mode: string };
  run: { trials: number; concurrency: number; budget_usd: number };
  judge: { model: string; max_turns: number };
  calibration: { min_n: number };
  gates: Record<string, { min?: number; max?: number }>;
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? resolve(homedir(), p.slice(2)) : p;
}

let cached: EvalConfig | null = null;
export function loadConfig(path = process.env.JEVROUTE_CONFIG ?? resolve(REPO_ROOT, "eval.yml")): EvalConfig {
  if (cached) return cached;
  loadDotEnv();
  const cfg = YAML.parse(readFileSync(path, "utf8")) as EvalConfig;
  cfg.universe.claude_config_dir = expandHome(cfg.universe.claude_config_dir);
  cached = cfg;
  return cfg;
}

export function loadDotEnv(): void {
  const p = resolve(REPO_ROOT, ".env");
  if (existsSync(p)) {
    try { process.loadEnvFile(p); } catch { /* already loaded or unsupported */ }
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  return v;
}
