export interface SkillInfo {
  /** Canonical id, e.g. "atlan-frontend:tanstack" or "find-skills" for personal skills. */
  id: string;
  plugin: string | null;
  name: string;
  description: string;
  path: string;
  bodyBytes: number;
  /** synthetic decoy: present in both arms, never a gold answer */
  noise: boolean;
  /** description text was changed by universe.description_overrides (both arms see the change) */
  descriptionOverridden?: boolean;
}

export interface Universe {
  createdAt: string;
  configDir: string;
  skills: SkillInfo[];
}

export type TaskMode = "full" | "routing_only";

export interface OutcomeCheck {
  type: "file_exists" | "file_matches" | "file_not_matches" | "result_matches" | "command" | "judge";
  // path may be a glob such as "src/<star><star>/<star>.tsx": matches = any file matches; not_matches = no file matches
  path?: string;
  regex?: string;
  cmd?: string;
  rubric?: string;
  /** hard checks must pass for the task to pass; soft checks only contribute to score */
  hard?: boolean;
}

export interface Task {
  id: string;
  prompt: string;
  /** gold skill ids; empty array means "no skill should be used" */
  gold: string[];
  mode: TaskMode;
  /** free-form grouping: skill family, none, distractor, paraphrase group */
  tags?: string[];
  /** files to seed into the workspace before the run: relative path -> content */
  seed?: Record<string, string>;
  /** shell commands run in the workspace after seeding (e.g. generate a binary fixture); failures abort the trial */
  seed_commands?: string[];
  checks?: OutcomeCheck[];
}

export interface JevRouteResponse {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface Decision {
  version: 1;
  arm: "jev";
  sessionId: string | null;
  promptId: string | null;
  prompt: string;
  universeHash: string;
  request: unknown;
  response: JevRouteResponse | null;
  rawResponse: unknown;
  model: string | null;
  jevInputTokens: number | null;
  latencyMs: number;
  error: string | null;
  policy: { threshold: number; fallback: string; fallbackTopK: number; routeNoneMinProb: number };
  /** what the hook actually did */
  action: "inject_skill" | "inject_listing" | "inject_none" | "error_passthrough";
  injectMode?: "body" | "pointer";
  via?: "daemon" | "direct";
  injected: string[];
  injectedChars: number;
  timestamp: string;
}

export interface UsageTotals {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
  /** input + cacheCreation + cacheRead summed over every model call */
  contextProcessed: number;
  /** context tokens on the first model call: the system-prompt-size proxy */
  firstCallContext: number;
  modelCalls: number;
}

export interface ParsedTranscript {
  skillToolCalls: string[];
  /** absolute paths passed to Write/Edit/MultiEdit/NotebookEdit */
  filesWritten: string[];
  toolCalls: { name: string; input: unknown }[];
  usage: UsageTotals;
  totalCostUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  resultText: string | null;
  isError: boolean;
  sessionId: string | null;
}

export interface TrialResult {
  task: string;
  arm: string;
  trial: number;
  runId: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  wallMs: number;
  firstAssistantEventMs: number | null;
  workspace: string;
  transcriptPath: string;
  decisionPaths: string[];
}
