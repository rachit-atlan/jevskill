/**
 * Optional warm-connection daemon for the hook. Each hook invocation is a fresh process, so it pays TCP+TLS setup
 * to jev (~500 ms measured). This daemon keeps one process alive with a pooled connection; the hook POSTs the jev
 * request to it over a Unix socket and falls back to calling jev directly if the daemon is absent.
 * Run: bun run daemon   (socket path from eval.yml jev.daemon_socket)
 */
import { unlinkSync, existsSync } from "node:fs";
import { loadConfig, requireEnv } from "../config.ts";

const cfg = loadConfig();
const sock = cfg.jev.daemon_socket ?? "/tmp/jevroute.sock";
if (existsSync(sock)) unlinkSync(sock);
const key = requireEnv("TYPESAFE_API_KEY");
let served = 0;

// warm the connection once so the first hook call is fast too
fetch(cfg.jev.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ model: cfg.jev.model, state: "warmup", questions: { q: { type: "noul", instructions: "warmup" } } }) }).catch(() => {});

Bun.serve({
  unix: sock,
  async fetch(req) {
    if (req.method !== "POST") return new Response(JSON.stringify({ ok: true, served, endpoint: cfg.jev.endpoint }), { headers: { "content-type": "application/json" } });
    const t0 = performance.now();
    const body = await req.text();
    const res = await fetch(cfg.jev.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body, signal: AbortSignal.timeout(cfg.jev.timeout_ms) });
    served++;
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { "content-type": "application/json", "x-jev-upstream-ms": String(Math.round(performance.now() - t0)) } });
  },
});
console.log(`jevroute daemon listening on ${sock} → ${cfg.jev.endpoint}`);
