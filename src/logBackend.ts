import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type LogSource = "claude" | "codex" | "unknown";

export type TaskHit = {
  engineer: string;
  source: LogSource;
  text: string;
  timestampMs: number;
  sessionId?: string;
  project?: string;
  file: string;
  line: number;
  score: number;
};

export type QueryTaskOptions = {
  prompt: string;
  teamRoot?: string;
  teams?: string[];
  engineers?: string[];
  limit?: number;
};

type RawTaskHit = Omit<TaskHit, "score">;

type EngineerLog = {
  team?: string;
  engineer: string;
  logDir: string;
};

type QueryTaskResult = {
  teamRoot: string;
  query: string;
  scannedTeams: string[];
  scannedEngineers: string[];
  scannedFiles: number;
  extractedTasks: number;
  matches: TaskHit[];
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

function expandHome(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseTimestampToMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) {
      return value;
    }
    return value * 1000;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function inferSource(filePath: string, record: Record<string, unknown>): LogSource {
  if (
    filePath.includes(`${path.sep}.codex${path.sep}`) ||
    typeof record.ts === "number" ||
    typeof record.session_id === "string"
  ) {
    return "codex";
  }

  if (
    filePath.includes(`${path.sep}.claude${path.sep}`) ||
    typeof record.display === "string"
  ) {
    return "claude";
  }

  return "unknown";
}

function looksLikeActionableTask(text: string): boolean {
  const trimmed = normalizeText(text);
  if (!trimmed || trimmed.length < 4) {
    return false;
  }

  if (/^\/[a-z0-9_-]+$/i.test(trimmed)) {
    return false;
  }

  return true;
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function computeScore(
  item: RawTaskHit,
  queryLower: string,
  queryTokens: string[],
  nowMs: number
): number {
  const textLower = item.text.toLowerCase();
  let score = 0;

  if (!queryLower) {
    score += 10;
  } else {
    if (textLower.includes(queryLower)) {
      score += 80;
    }
    for (const token of queryTokens) {
      if (textLower.includes(token)) {
        score += 10;
      }
    }
  }

  if (item.source === "codex" || item.source === "claude") {
    score += 5;
  }

  if (item.timestampMs > 0) {
    const ageDays = Math.max(0, (nowMs - item.timestampMs) / 86_400_000);
    score += Math.max(0, 25 - ageDays / 2);
  }

  return score;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function listEngineerLogs(
  teamRoot: string,
  teams?: string[],
  engineers?: string[]
): Promise<EngineerLog[]> {
  const selectedTeams = teams && teams.length > 0 ? new Set(teams) : null;
  const selectedEngineers = engineers && engineers.length > 0 ? new Set(engineers) : null;
  const entries = await fs.readdir(teamRoot, { withFileTypes: true });
  const results: EngineerLog[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const entryPath = path.join(teamRoot, entry.name);
    const directLogDir = path.join(entryPath, "log");

    if (await pathExists(directLogDir)) {
      // Flat structure: <teamRoot>/<engineer>/log
      if (selectedEngineers && !selectedEngineers.has(entry.name)) continue;
      results.push({ engineer: entry.name, logDir: directLogDir });
    } else {
      // Nested structure: <teamRoot>/<team>/<engineer>/log
      if (selectedTeams && !selectedTeams.has(entry.name)) continue;

      const teamName = entry.name;
      const teamEntries = await fs.readdir(entryPath, { withFileTypes: true });

      for (const engineerEntry of teamEntries) {
        if (!engineerEntry.isDirectory()) continue;
        if (selectedEngineers && !selectedEngineers.has(engineerEntry.name)) continue;

        const logDir = path.join(entryPath, engineerEntry.name, "log");
        if (await pathExists(logDir)) {
          results.push({ team: teamName, engineer: engineerEntry.name, logDir });
        }
      }
    }
  }

  return results;
}

async function walkJsonlFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof (part as Record<string, unknown>).text === "string"
      ) {
        parts.push((part as Record<string, string>).text);
      }
    }
    return parts.join("\n");
  }

  return "";
}

function extractTaskFromRecord(
  filePath: string,
  line: number,
  engineer: string,
  record: Record<string, unknown>
): RawTaskHit[] {
  const source = inferSource(filePath, record);

  // Codex history format: {"session_id","ts","text"}
  if (typeof record.text === "string" && (typeof record.ts === "number" || typeof record.ts === "string")) {
    return [
      {
        engineer,
        source: source === "unknown" ? "codex" : source,
        text: normalizeText(record.text),
        timestampMs: parseTimestampToMs(record.ts),
        sessionId: typeof record.session_id === "string" ? record.session_id : undefined,
        file: filePath,
        line,
      },
    ];
  }

  // Claude history format: {"display","timestamp","sessionId","project"}
  if (
    typeof record.display === "string" &&
    (typeof record.timestamp === "number" || typeof record.timestamp === "string")
  ) {
    return [
      {
        engineer,
        source: source === "unknown" ? "claude" : source,
        text: normalizeText(record.display),
        timestampMs: parseTimestampToMs(record.timestamp),
        sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
        project: typeof record.project === "string" ? record.project : undefined,
        file: filePath,
        line,
      },
    ];
  }

  // Session traces that contain explicit user messages.
  if (record.type === "user") {
    let text = "";
    let sessionId: string | undefined;

    if (
      record.message &&
      typeof record.message === "object" &&
      "content" in (record.message as Record<string, unknown>)
    ) {
      text = extractTextFromContent(
        (record.message as Record<string, unknown>).content
      );
    } else if (typeof record.message === "string") {
      text = record.message;
    }

    if (typeof record.sessionId === "string") {
      sessionId = record.sessionId;
    } else if (typeof record.session_id === "string") {
      sessionId = record.session_id;
    }

    return [
      {
        engineer,
        source,
        text: normalizeText(text),
        timestampMs: parseTimestampToMs(record.timestamp),
        sessionId,
        file: filePath,
        line,
      },
    ];
  }

  return [];
}

async function extractTasksFromJsonl(
  filePath: string,
  engineer: string
): Promise<RawTaskHit[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split("\n");
  const hits: RawTaskHit[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    const extracted = extractTaskFromRecord(
      filePath,
      i + 1,
      engineer,
      parsed as Record<string, unknown>
    );
    for (const item of extracted) {
      if (looksLikeActionableTask(item.text)) {
        hits.push(item);
      }
    }
  }

  return hits;
}

export async function queryEngineerTasks(
  options: QueryTaskOptions
): Promise<QueryTaskResult> {
  const query = normalizeText(options.prompt);
  const teamRoot = expandHome(options.teamRoot ?? "~/team");
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const queryLower = query.toLowerCase();
  const queryTokens = tokenize(query);
  const nowMs = Date.now();

  if (!(await pathExists(teamRoot))) {
    return {
      teamRoot,
      query,
      scannedEngineers: [],
      scannedFiles: 0,
      extractedTasks: 0,
      matches: [],
    };
  }

  const engineerLogs = await listEngineerLogs(teamRoot, options.teams, options.engineers);
  const allTasks: RawTaskHit[] = [];
  let scannedFiles = 0;

  for (const engineerLog of engineerLogs) {
    const jsonlFiles = await walkJsonlFiles(engineerLog.logDir);
    scannedFiles += jsonlFiles.length;

    for (const filePath of jsonlFiles) {
      const entries = await extractTasksFromJsonl(filePath, engineerLog.engineer);
      allTasks.push(...entries);
    }
  }

  const scored = allTasks
    .map((item) => ({
      ...item,
      score: computeScore(item, queryLower, queryTokens, nowMs),
    }))
    .filter((item) => {
      if (!queryLower) return true;
      if (item.text.toLowerCase().includes(queryLower)) return true;
      return queryTokens.some((token) => item.text.toLowerCase().includes(token));
    })
    .sort((a, b) => b.score - a.score || b.timestampMs - a.timestampMs)
    .slice(0, limit);

  const seenTeams = new Set(engineerLogs.map((e) => e.team).filter(Boolean) as string[]);

  return {
    teamRoot,
    query,
    scannedTeams: [...seenTeams],
    scannedEngineers: [...new Set(engineerLogs.map((e) => e.engineer))],
    scannedFiles,
    extractedTasks: allTasks.length,
    matches: scored.map((item) => ({
      ...item,
      text: item.text.slice(0, 600),
    })),
  };
}
