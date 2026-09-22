/** Onboard the .env bearer against the gateway (local or hosted) and write the resulting workspace id into .env. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadDotEnv, REPO_ROOT } from "./config.ts";

export async function onboard(): Promise<{ workspaceId: string; candidates: Record<string, string> }> {
  loadDotEnv();
  const base = (process.env.ATLAN_BASE_URL ?? "https://api.atlan.com").replace(/\/$/, "");
  const key = process.env.ATLAN_API_KEY;
  if (!key) throw new Error("ATLAN_API_KEY missing in .env");
  let last = "";
  for (const path of ["/registry/v1/users/onboard", "/users/onboard"]) {
    const res = await fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: "{}" });
    const text = await res.text();
    if (res.status === 404) { last = `${path}: 404`; continue; }
    if (!res.ok) throw new Error(`onboard ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text);
    const candidates: Record<string, string> = {};
    const walk = (v: unknown, trail: string) => {
      if (!v || typeof v !== "object") return;
      const o = v as Record<string, unknown>;
      if (typeof o.id === "string" && /^workspace_/.test(o.id)) candidates[trail || "root"] = o.id;
      for (const [k, x] of Object.entries(o)) if (typeof x === "object") walk(x, trail ? `${trail}.${k}` : k);
    };
    walk(body, "");
    // prefer the caller's own default workspace, else the org singleton, else anything
    const pick = Object.entries(candidates).find(([k]) => /user_default|user/.test(k)) ?? Object.entries(candidates).find(([k]) => /org/.test(k)) ?? Object.entries(candidates)[0];
    if (!pick) throw new Error(`onboard ok but no workspace_ id in response: ${text.slice(0, 400)}`);
    const envPath = resolve(REPO_ROOT, ".env");
    const env = readFileSync(envPath, "utf8").replace(/^ATLAN_WORKSPACE_ID=.*$/m, `ATLAN_WORKSPACE_ID=${pick[1]}`);
    writeFileSync(envPath, env);
    return { workspaceId: pick[1], candidates };
  }
  throw new Error(`no onboard route found (${last})`);
}

if (import.meta.main) {
  onboard().then(r => { console.log("workspaces:", r.candidates); console.log("ATLAN_WORKSPACE_ID set to", r.workspaceId); })
    .catch(e => { console.error(e.message); process.exit(1); });
}
