import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { REPO_ROOT } from "./config.ts";
import type { Task } from "./types.ts";

/** All top-level tasks/*.jsonl files, sorted by name. Subfolders (tasks/sweep/) are opt-in via JEVROUTE_TASKS_DIR. */
export function loadTasks(dir = process.env.JEVROUTE_TASKS_DIR ?? resolve(REPO_ROOT, "tasks")): Task[] {
  const files = readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort();
  const tasks = files.flatMap(f => readFileSync(join(dir, f), "utf8").split("\n").filter(l => l.trim() && !l.startsWith("#")).map(l => JSON.parse(l) as Task));
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) throw new Error(`duplicate task id ${t.id}`);
    ids.add(t.id);
    if (!Array.isArray(t.gold)) throw new Error(`task ${t.id}: gold must be an array`);
    if (t.mode !== "full" && t.mode !== "routing_only") throw new Error(`task ${t.id}: bad mode`);
  }
  return tasks;
}
