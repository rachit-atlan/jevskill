import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadConfig, REPO_ROOT } from "./config.ts";
import type { SkillInfo, Universe } from "./types.ts";

interface Frontmatter { name?: string; description?: string }

export function parseFrontmatter(md: string): { fm: Frontmatter; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: md };
  const fm: Record<string, string> = {};
  let key: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      let v = kv[2].trim();
      // block scalars: `description: >-` or `|`
      if (v === ">-" || v === ">" || v === "|" || v === "|-") v = "";
      fm[key] = v;
    } else if (key && /^\s+\S/.test(line)) {
      fm[key] = (fm[key] ? fm[key] + " " : "") + line.trim();
    }
  }
  for (const k of Object.keys(fm)) fm[k] = fm[k].replace(/^["']|["']$/g, "");
  return { fm: fm as Frontmatter, body: md.slice(m[0].length) };
}

/** Canonical id. Plugin skills are flattened ("atlan-frontend-tanstack") so the same id works as a personal-skill
 *  directory name in the controlled native arm and as a jev criteria key. */
export function skillId(plugin: string | null, name: string): string {
  return plugin ? `${plugin}-${name}` : name;
}

function skillFromFile(path: string, plugin: string | null, noise = false): SkillInfo | null {
  const md = readFileSync(path, "utf8");
  const { fm } = parseFrontmatter(md);
  const dirName = path.split("/").at(-2) ?? "";
  const name = fm.name ?? dirName;
  if (!fm.description) return null;
  return {
    id: skillId(plugin, name),
    plugin, name, description: fm.description, path,
    bodyBytes: Buffer.byteLength(md), noise,
  };
}

/** Discover the routable universe the way Claude Code exposes it: enabled plugin skills + personal skills. */
export function discoverUniverse(): Universe {
  const cfg = loadConfig();
  const dir = cfg.universe.claude_config_dir;
  const skills: SkillInfo[] = [];

  const installedPath = join(dir, "plugins", "installed_plugins.json");
  const settingsPath = join(dir, "settings.json");
  const enabled: Record<string, boolean> = existsSync(settingsPath)
    ? (JSON.parse(readFileSync(settingsPath, "utf8")).enabledPlugins ?? {})
    : {};
  if (existsSync(installedPath)) {
    const installed = JSON.parse(readFileSync(installedPath, "utf8")).plugins as Record<string, { installPath: string }[]>;
    for (const [key, insts] of Object.entries(installed)) {
      if (!enabled[key]) continue;
      const plugin = key.split("@")[0];
      const skillsDir = join(insts[0].installPath, "skills");
      if (!existsSync(skillsDir)) continue;
      for (const d of readdirSync(skillsDir)) {
        const f = join(skillsDir, d, "SKILL.md");
        if (existsSync(f)) { const s = skillFromFile(f, plugin); if (s) skills.push(s); }
      }
    }
  }
  if (cfg.universe.include_personal_skills) {
    const personal = join(dir, "skills");
    if (existsSync(personal)) {
      for (const d of readdirSync(personal)) {
        const f = join(personal, d, "SKILL.md");
        if (existsSync(f) && statSync(f).isFile()) { const s = skillFromFile(f, null); if (s) skills.push(s); }
      }
    }
  }
  if (cfg.universe.include_synced_skills) {
    const synced = join(dir, "skills", "synced");
    if (existsSync(synced)) {
      for (const bundle of readdirSync(synced)) {
        const bdir = join(synced, bundle);
        if (!statSync(bdir).isDirectory()) continue;
        for (const d of readdirSync(bdir)) {
          const f = join(bdir, d, "SKILL.md");
          if (existsSync(f)) { const sk = skillFromFile(f, null); if (sk) skills.push(sk); }
        }
      }
    }
  }
  if (cfg.universe.include_noise && cfg.universe.noise_dir) {
    const noiseDir = resolve(REPO_ROOT, cfg.universe.noise_dir);
    if (existsSync(noiseDir)) {
      for (const d of readdirSync(noiseDir)) {
        const f = join(noiseDir, d, "SKILL.md");
        if (existsSync(f)) { const s = skillFromFile(f, null, true); if (s) skills.push(s); }
      }
    }
  }
  const excluded = new Set(cfg.universe.exclude);
  const overrides = cfg.universe.description_overrides ?? {};
  for (const s of skills) {
    const o = overrides[s.id];
    if (!o) continue;
    if (o.replace !== undefined) s.description = o.replace;
    if (o.append) s.description = s.description + o.append;
    s.descriptionOverridden = true;
  }
  const filtered = skills.filter(s => !excluded.has(s.id)).sort((a, b) => a.id.localeCompare(b.id));
  return { createdAt: new Date().toISOString(), configDir: dir, skills: filtered };
}

export const UNIVERSE_PATH = resolve(REPO_ROOT, "universe.json");

export function saveUniverse(u: Universe, path = UNIVERSE_PATH): void {
  writeFileSync(path, JSON.stringify(u, null, 2));
}

export function loadUniverse(path = process.env.JEVROUTE_UNIVERSE ?? UNIVERSE_PATH): Universe {
  if (!existsSync(path)) throw new Error(`universe not found at ${path}; run \`npm run skills\` first`);
  return JSON.parse(readFileSync(path, "utf8")) as Universe;
}

export function universeHash(u: Universe): string {
  const h = createHash("sha256");
  for (const s of u.skills) h.update(`${s.id}\n${s.description}\n`);
  return h.digest("hex").slice(0, 12);
}

export function skillBody(s: SkillInfo): string {
  return readFileSync(s.path, "utf8");
}
