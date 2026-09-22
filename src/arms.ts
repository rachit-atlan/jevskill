import { mkdirSync, writeFileSync, rmSync, existsSync, cpSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { loadConfig, REPO_ROOT } from "./config.ts";
import { parseFrontmatter } from "./skills.ts";
import type { Task, Universe } from "./types.ts";

export interface SpawnSpec { cmd: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }

export const ARMS_DIR = resolve(REPO_ROOT, ".arms");

/**
 * Build a controlled CLAUDE_CONFIG_DIR for an arm. Both controlled arms get the same empty settings
 * (no plugins, no MCP, no CLAUDE.md). The native arm additionally gets every universe skill installed
 * as a personal skill under <dir>/skills/<id>/, with the frontmatter name rewritten to the canonical id so
 * the Skill tool reports the same id the graders use. The jev arm gets the routing hook instead.
 * Built once per run from the run's universe snapshot so the arms are bounded to what the run saw;
 * a later re-grade or Registry upload of the same run reuses the dirs as they were.
 */
export function buildArmConfigDir(arm: "native" | "jev" | "bare" | "mcp", universe: Universe, runId: string): { configDir: string; settingsPath: string } {
  const configDir = join(ARMS_DIR, runId, arm);
  const settingsPath = join(configDir, "settings.json");
  if (existsSync(settingsPath)) return { configDir, settingsPath };
  rmSync(configDir, { recursive: true, force: true });
  mkdirSync(configDir, { recursive: true });
  const settings: Record<string, unknown> = { enabledPlugins: {} };
  if (arm === "native") {
    for (const s of universe.skills) {
      const dst = join(configDir, "skills", s.id);
      if (!existsSync(s.path)) { console.warn(`  ! skill source missing, skipped in arm dir: ${s.id} (${s.path})`); continue; }
      cpSync(dirname(s.path), dst, { recursive: true, dereference: true });
      const md = readFileSync(join(dst, "SKILL.md"), "utf8");
      const { fm, body } = parseFrontmatter(md);
      const desc = JSON.stringify(s.descriptionOverridden ? s.description : (fm.description ?? s.description));
      writeFileSync(join(dst, "SKILL.md"), `---\nname: ${s.id}\ndescription: ${desc}\n---\n${body}`);
    }
  } else if (arm === "jev") {
    const hook = resolve(REPO_ROOT, "src/hook/route-hook.ts");
    settings.hooks = { UserPromptSubmit: [{ hooks: [{ type: "command", command: `${process.execPath} ${hook}`, timeout: 30 }] }] };
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { configDir, settingsPath };
}

export function armBase(arm: string): "native" | "jev" | "bare" | "mcp" | "real" {
  const a = loadConfig().arms[arm];
  if (!a) throw new Error(`unknown arm: ${arm} (define it in eval.yml)`);
  return a.base;
}

export function buildSpawn(arm: string, task: Task, workspace: string, decisionDir: string, universePath: string, runId: string): SpawnSpec {
  const cfg = loadConfig();
  const armCfg = cfg.arms[arm];
  if (!armCfg) throw new Error(`unknown arm: ${arm} (define it in eval.yml)`);
  const maxTurns = task.mode === "full" ? cfg.claude.max_turns_full : cfg.claude.max_turns_routing_only;
  const args = [
    "-p", task.prompt,
    "--model", cfg.claude.model,
    "--output-format", "stream-json", "--verbose",
    "--permission-mode", cfg.claude.permission_mode,
    "--max-turns", String(maxTurns),
  ];
  const env: NodeJS.ProcessEnv = { ...process.env, ...(armCfg.env ?? {}) };
  if (armCfg.base !== "real") {
    const configDir = join(ARMS_DIR, runId, armCfg.base);
    if (!existsSync(join(configDir, "settings.json"))) throw new Error(`arm config missing: ${configDir}; runAll builds it`);
    env.CLAUDE_CONFIG_DIR = configDir;
    args.push("--settings", join(configDir, "settings.json"));
    if (armCfg.base === "jev" || armCfg.base === "mcp") {
      env.JEVROUTE_DECISION_DIR = decisionDir;
      env.JEVROUTE_UNIVERSE = universePath;
      env.JEVROUTE_CONFIG = process.env.JEVROUTE_CONFIG ?? resolve(REPO_ROOT, "eval.yml");
    }
    if (armCfg.base === "mcp") {
      // MCP server inherits the decision dir + universe through its own env block; strict so no other servers leak in
      const mcpConfig = { mcpServers: { jevroute: { command: process.execPath, args: [resolve(REPO_ROOT, "src/mcp/jev-mcp-server.ts")], env: { JEVROUTE_DECISION_DIR: decisionDir, JEVROUTE_UNIVERSE: universePath, JEVROUTE_CONFIG: env.JEVROUTE_CONFIG!, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY ?? "", PATH: process.env.PATH ?? "" } } } };
      const mcpPath = join(workspace, "..", "mcp.json");
      writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2));
      args.push("--mcp-config", mcpPath, "--strict-mcp-config");
    }
    if (armCfg.append_system_prompt) args.push("--append-system-prompt", armCfg.append_system_prompt);
  }
  return { cmd: "claude", args, env, cwd: workspace };
}
