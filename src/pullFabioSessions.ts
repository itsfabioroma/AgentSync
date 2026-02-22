import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export type SourceFilter = "all" | "codex" | "claude";

type CliOptions = {
  outDir: string;
  dbPath: string;
  engineerId?: string;
  host?: string;
  source: SourceFilter;
  limit: number;
  baseUrl: string;
  apiKey?: string;
  skipRaw: boolean;
  dryRun: boolean;
};

export type PullFabioSessionsOptions = Partial<CliOptions>;

export type PullFabioSessionsSummary = {
  outDir: string;
  totalSessions: number;
  totalUserMessages: number;
  dryRun: boolean;
};

type SessionCacheRow = {
  cacheKey: string;
  contextId: string;
  updatedAtUnix: number;
  source: "codex" | "claude" | "openclaw" | "unknown";
  host: string;
  engineerId: string;
  sessionId: string;
};

type DumpResult = {
  source: string;
  host: string;
  engineerId: string;
  sessionId: string;
  contextId: string;
  updatedAtUnix: number;
  userMessages: number;
  file: string;
  rawFile?: string;
};

const DEFAULT_DB = "~/.ultracontext/daemon.db";
const DEFAULT_OUT_DIR = "teams/demo/fabio/log";
const DEFAULT_BASE_URL = "https://api.ultracontext.ai";
const SQLITE_SEPARATOR = "\u001f";

function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function parseIntSafe(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseSource(value: string | undefined): SourceFilter {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "codex" || raw === "claude") return raw;
  return "all";
}

function buildDefaultOptions(): CliOptions {
  return {
    outDir: path.resolve(process.cwd(), DEFAULT_OUT_DIR),
    dbPath: path.resolve(expandHome(DEFAULT_DB)),
    source: "all",
    limit: 120,
    baseUrl: (process.env.ULTRACONTEXT_BASE_URL ?? DEFAULT_BASE_URL).trim(),
    apiKey: process.env.ULTRACONTEXT_API_KEY?.trim(),
    skipRaw: false,
    dryRun: false,
  };
}

function normalizeOptions(input: PullFabioSessionsOptions = {}): CliOptions {
  const defaults = buildDefaultOptions();
  const source =
    input.source === "codex" || input.source === "claude" || input.source === "all"
      ? input.source
      : defaults.source;
  const limit = Number.isFinite(Number(input.limit))
    ? Math.max(1, Number.parseInt(String(input.limit), 10))
    : defaults.limit;

  return {
    ...defaults,
    ...input,
    outDir: input.outDir
      ? path.resolve(process.cwd(), expandHome(input.outDir))
      : defaults.outDir,
    dbPath: input.dbPath ? path.resolve(expandHome(input.dbPath)) : defaults.dbPath,
    source,
    limit,
    baseUrl: String(input.baseUrl ?? defaults.baseUrl).trim().replace(/\/+$/, ""),
    apiKey: input.apiKey?.trim() || defaults.apiKey,
  };
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = buildDefaultOptions();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--out-dir" && next) {
      opts.outDir = path.resolve(process.cwd(), expandHome(next));
      i += 1;
      continue;
    }
    if (arg === "--db-path" && next) {
      opts.dbPath = path.resolve(expandHome(next));
      i += 1;
      continue;
    }
    if (arg === "--engineer-id" && next) {
      opts.engineerId = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--host" && next) {
      opts.host = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--source" && next) {
      opts.source = parseSource(next);
      i += 1;
      continue;
    }
    if (arg === "--limit" && next) {
      opts.limit = parseIntSafe(next, opts.limit);
      i += 1;
      continue;
    }
    if (arg === "--base-url" && next) {
      opts.baseUrl = next.trim().replace(/\/+$/, "");
      i += 1;
      continue;
    }
    if (arg === "--api-key" && next) {
      opts.apiKey = next.trim();
      i += 1;
      continue;
    }
    if (arg === "--skip-raw") {
      opts.skipRaw = true;
      continue;
    }
    if (arg === "--dry-run") {
      opts.dryRun = true;
    }
  }

  return opts;
}

async function readApiKeyFromConfigToml(filePath: string): Promise<string> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const match = raw.match(/^\s*api_key\s*=\s*["']([^"']+)["']/m);
    return match?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

async function runSqliteQuery(dbPath: string, sql: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("sqlite3", ["-separator", SQLITE_SEPARATOR, dbPath, sql], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`sqlite3 exited with code ${code}: ${stderr || "unknown error"}`));
        return;
      }
      resolve(
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      );
    });
  });
}

function parseSessionCacheKey(cacheKey: string): Omit<SessionCacheRow, "contextId" | "updatedAtUnix"> | null {
  const parts = cacheKey.split(":");
  if (parts.length < 6) return null;
  if (parts[0] !== "ctx" || parts[1] !== "session") return null;

  const sourceRaw = parts[2]?.trim().toLowerCase() ?? "";
  const source =
    sourceRaw === "codex" || sourceRaw === "claude" || sourceRaw === "openclaw"
      ? sourceRaw
      : "unknown";

  const host = parts[3] ?? "";
  const engineerId = parts[4] ?? "";
  const sessionId = parts.slice(5).join(":");
  if (!sessionId) return null;

  return {
    cacheKey,
    source,
    host,
    engineerId,
    sessionId,
  };
}

async function loadSessionCacheRows(dbPath: string): Promise<SessionCacheRow[]> {
  const sql = `
SELECT cache_key, context_id, updated_at
FROM context_cache
WHERE cache_key LIKE 'ctx:session:%'
ORDER BY updated_at DESC;
`.trim();

  const lines = await runSqliteQuery(dbPath, sql);
  const rows: SessionCacheRow[] = [];

  for (const line of lines) {
    const [cacheKey, contextId, updatedAtRaw] = line.split(SQLITE_SEPARATOR);
    if (!cacheKey || !contextId) continue;
    const parsed = parseSessionCacheKey(cacheKey);
    if (!parsed) continue;
    rows.push({
      ...parsed,
      contextId,
      updatedAtUnix: Number.parseInt(String(updatedAtRaw ?? "0"), 10) || 0,
    });
  }

  return rows;
}

function filterAndDedupeRows(rows: SessionCacheRow[], options: CliOptions): SessionCacheRow[] {
  const filtered = rows.filter((row) => {
    if (options.engineerId && row.engineerId !== options.engineerId) return false;
    if (options.host && row.host !== options.host) return false;
    if (options.source !== "all" && row.source !== options.source) return false;
    return true;
  });

  const bySession = new Map<string, SessionCacheRow>();
  for (const row of filtered) {
    const key = `${row.source}:${row.host}:${row.engineerId}:${row.sessionId}`;
    const current = bySession.get(key);
    if (!current || row.updatedAtUnix > current.updatedAtUnix) {
      bySession.set(key, row);
    }
  }

  return [...bySession.values()]
    .sort((a, b) => b.updatedAtUnix - a.updatedAtUnix)
    .slice(0, options.limit);
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function parseTimestampToIso(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string") {
    const ts = Date.parse(value);
    if (!Number.isNaN(ts)) return new Date(ts).toISOString();
  }
  return new Date(0).toISOString();
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";

  const record = value as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;

  if (Array.isArray(record.content)) {
    const parts = record.content
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (!entry || typeof entry !== "object") return "";
        const e = entry as Record<string, unknown>;
        if (typeof e.text === "string") return e.text;
        return "";
      })
      .filter(Boolean);
    return parts.join("\n");
  }

  return "";
}

function isUserMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const item = message as Record<string, unknown>;
  if (item.role === "user") return true;
  const raw = item.content as Record<string, unknown> | undefined;
  if (raw && typeof raw === "object") {
    if (raw.role === "user") return true;
    const nestedRaw = raw.raw as Record<string, unknown> | undefined;
    if (nestedRaw?.type === "user") return true;
  }
  return false;
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const item = message as Record<string, unknown>;
  const content = item.content;
  const direct = extractTextContent(content);
  if (direct) return direct;

  if (content && typeof content === "object") {
    const nested = content as Record<string, unknown>;
    const raw = nested.raw;
    const fromRaw = extractTextContent(raw);
    if (fromRaw) return fromRaw;
    if (raw && typeof raw === "object") {
      const rawObj = raw as Record<string, unknown>;
      const rawMsg = rawObj.message;
      const fromRawMsg = extractTextContent(rawMsg);
      if (fromRawMsg) return fromRawMsg;
    }
  }
  return "";
}

function extractMessageTimestamp(message: unknown, fallbackIso: string): string {
  if (!message || typeof message !== "object") return fallbackIso;
  const item = message as Record<string, unknown>;
  const content = item.content as Record<string, unknown> | undefined;
  const metadata = item.metadata as Record<string, unknown> | undefined;

  const candidates: unknown[] = [
    content?.timestamp,
    metadata?.timestamp,
    item.timestamp,
    content?.created_at,
  ];

  for (const candidate of candidates) {
    const parsed = parseTimestampToIso(candidate);
    if (parsed !== new Date(0).toISOString()) return parsed;
  }

  return fallbackIso;
}

async function fetchContext(baseUrl: string, apiKey: string, contextId: string): Promise<Record<string, unknown>> {
  const url = `${baseUrl.replace(/\/+$/, "")}/contexts/${encodeURIComponent(contextId)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status} ${url}: ${body.slice(0, 400)}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;

  async function runWorker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await worker(items[index]);
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => runWorker());
  await Promise.all(workers);
  return out;
}

async function dumpSession(
  row: SessionCacheRow,
  options: CliOptions,
  apiKey: string,
  outDir: string,
  rawDir: string
): Promise<DumpResult> {
  const detail = await fetchContext(options.baseUrl, apiKey, row.contextId);
  const messages = Array.isArray(detail.data) ? detail.data : [];
  const contextCreatedAt = parseTimestampToIso(detail.created_at);

  const lines: string[] = [];
  let userMessages = 0;
  for (const message of messages) {
    if (!isUserMessage(message)) continue;
    const text = extractMessageText(message).replace(/\s+/g, " ").trim();
    if (!text) continue;

    const timestamp = extractMessageTimestamp(message, contextCreatedAt);
    lines.push(
      JSON.stringify({
        type: "user",
        source: row.source,
        timestamp,
        sessionId: row.sessionId,
        contextId: row.contextId,
        message: { content: text },
      })
    );
    userMessages += 1;
  }

  const baseName = sanitizeFileName(`${row.source}-${row.sessionId}`);
  const outFile = path.join(outDir, `${baseName}.jsonl`);
  await fs.writeFile(outFile, `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`, "utf8");

  let rawFile: string | undefined;
  if (!options.skipRaw) {
    rawFile = path.join(rawDir, `${baseName}.json`);
    const rawPayload = {
      pulledAt: new Date().toISOString(),
      cache: {
        cacheKey: row.cacheKey,
        contextId: row.contextId,
        source: row.source,
        host: row.host,
        engineerId: row.engineerId,
        sessionId: row.sessionId,
        updatedAtUnix: row.updatedAtUnix,
      },
      detail,
    };
    await fs.writeFile(rawFile, `${JSON.stringify(rawPayload, null, 2)}\n`, "utf8");
  }

  return {
    source: row.source,
    host: row.host,
    engineerId: row.engineerId,
    sessionId: row.sessionId,
    contextId: row.contextId,
    updatedAtUnix: row.updatedAtUnix,
    userMessages,
    file: outFile,
    rawFile,
  };
}

export async function pullFabioSessions(
  input: PullFabioSessionsOptions = {}
): Promise<PullFabioSessionsSummary> {
  const options = normalizeOptions(input);
  const configApiKey = await readApiKeyFromConfigToml(path.resolve(expandHome("~/.ultracontext/config.toml")));
  const apiKey = options.apiKey || configApiKey;
  if (!apiKey) {
    throw new Error(
      "Missing API key. Set ULTRACONTEXT_API_KEY, pass --api-key, or configure ~/.ultracontext/config.toml."
    );
  }

  const rows = await loadSessionCacheRows(options.dbPath);
  const selectedRows = filterAndDedupeRows(rows, options);
  if (selectedRows.length === 0) {
    throw new Error("No matching session contexts found in daemon cache.");
  }

  console.log(
    `Found ${selectedRows.length} sessions in daemon cache (source=${options.source}, engineer=${options.engineerId ?? "all"}, host=${options.host ?? "all"}).`
  );

  if (options.dryRun) {
    for (const row of selectedRows.slice(0, 12)) {
      const updatedIso = row.updatedAtUnix ? new Date(row.updatedAtUnix * 1000).toISOString() : "-";
      console.log(
        `${row.source} | ${row.engineerId} | ${row.host} | ${row.sessionId} | ${row.contextId} | ${updatedIso}`
      );
    }
    console.log("Dry run complete.");
    return {
      outDir: options.outDir,
      totalSessions: selectedRows.length,
      totalUserMessages: 0,
      dryRun: true,
    };
  }

  const outDir = options.outDir;
  const rawDir = path.join(outDir, "_raw");
  await fs.mkdir(outDir, { recursive: true });
  if (!options.skipRaw) {
    await fs.mkdir(rawDir, { recursive: true });
  }

  const results = await mapWithConcurrency(selectedRows, 6, (row) =>
    dumpSession(row, options, apiKey, outDir, rawDir)
  );

  const totalUserMessages = results.reduce((acc, item) => acc + item.userMessages, 0);
  const indexPath = path.join(outDir, "index.json");
  await fs.writeFile(
    indexPath,
    `${JSON.stringify(
      {
        dumpedAt: new Date().toISOString(),
        sourceFilter: options.source,
        engineerIdFilter: options.engineerId ?? null,
        hostFilter: options.host ?? null,
        totalSessions: results.length,
        totalUserMessages,
        sessions: results.map((item) => ({
          source: item.source,
          host: item.host,
          engineerId: item.engineerId,
          sessionId: item.sessionId,
          contextId: item.contextId,
          updatedAt: item.updatedAtUnix
            ? new Date(item.updatedAtUnix * 1000).toISOString()
            : null,
          userMessages: item.userMessages,
          file: path.relative(outDir, item.file),
          rawFile: item.rawFile ? path.relative(outDir, item.rawFile) : null,
        })),
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  console.log(`Dumped ${results.length} sessions to ${outDir}`);
  console.log(`Total user messages: ${totalUserMessages}`);
  console.log(`Index file: ${indexPath}`);
  return {
    outDir,
    totalSessions: results.length,
    totalUserMessages,
    dryRun: false,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await pullFabioSessions(options);
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  main().catch((error) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Failed to pull Fabio sessions: ${msg}`);
    process.exit(1);
  });
}
