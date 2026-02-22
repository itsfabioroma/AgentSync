import { MCPServer, object, widget } from "mcp-use/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { queryEngineerTasks } from "./src/logBackend";
import { pullFabioSessions } from "./src/pullFabioSessions";

const server = new MCPServer({
  name: "engineer-log-query",
  title: "Engineer Log Query",
  version: "1.0.0",
  description: "Query engineer task history from Claude and Codex logs",
  baseUrl: process.env.MCP_URL || "http://localhost:3000",
  favicon: "favicon.ico",
  websiteUrl: "https://mcp-use.com",
  icons: [
    {
      src: "icon.svg",
      mimeType: "image/svg+xml",
      sizes: ["512x512"],
    },
  ],
});

type ThemeNode = {
  name: string;
  engineers: string[];
};

const boolFromEnv = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const toInt = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const autoFabioSyncEnabled = boolFromEnv(process.env.AUTO_SYNC_FABIO_SESSIONS, true);
const autoFabioSyncOutDir = (process.env.AUTO_SYNC_FABIO_SESSIONS_OUT_DIR ?? "teams/demo/fabio/log").trim();
const autoFabioSyncEngineerId = (process.env.AUTO_SYNC_FABIO_SESSIONS_ENGINEER_ID ?? "engineer-01").trim();
const autoFabioSyncHost = (process.env.AUTO_SYNC_FABIO_SESSIONS_HOST ?? "").trim();
const autoFabioSyncLimit = Math.max(toInt(process.env.AUTO_SYNC_FABIO_SESSIONS_LIMIT, 120), 1);
const autoFabioSyncSource = ["codex", "claude"].includes(
  (process.env.AUTO_SYNC_FABIO_SESSIONS_SOURCE ?? "").trim().toLowerCase()
)
  ? ((process.env.AUTO_SYNC_FABIO_SESSIONS_SOURCE ?? "").trim().toLowerCase() as
      | "codex"
      | "claude")
  : ("all" as const);

let fabioSyncRunning = false;
let fabioSyncPending = false;

const runFabioSessionSync = async () => {
  try {
    const summary = await pullFabioSessions({
      outDir: autoFabioSyncOutDir,
      engineerId: autoFabioSyncEngineerId || undefined,
      host: autoFabioSyncHost || undefined,
      source: autoFabioSyncSource,
      limit: autoFabioSyncLimit,
    });
    if (!summary.dryRun) {
      console.log(
        `[fabio-sync] sessions=${summary.totalSessions} messages=${summary.totalUserMessages} outDir=${summary.outDir}`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[fabio-sync] failed: ${message}`);
  } finally {
    fabioSyncRunning = false;
    if (fabioSyncPending) {
      fabioSyncPending = false;
      fabioSyncRunning = true;
      void runFabioSessionSync();
    }
  }
};

const enqueueFabioSessionSync = () => {
  if (!autoFabioSyncEnabled) return;
  if (fabioSyncRunning) {
    fabioSyncPending = true;
    return;
  }
  fabioSyncRunning = true;
  void runFabioSessionSync();
};

const normalizeStringList = (items?: string[]) => {
  if (!items || items.length === 0) return [];
  const seen = new Set<string>();
  const values: string[] = [];

  for (const item of items) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(trimmed);
  }

  return values;
};

const normalizeForLookup = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isEngineerMentioned = (
  engineerName: string,
  queryLower: string,
  normalizedQuery: string,
  normalizedQueryTokens: Set<string>
) => {
  const normalizedEngineer = normalizeForLookup(engineerName);
  if (!normalizedEngineer) return false;

  // Exact name boundary match in raw text (handles punctuation like "@name," or "(name)").
  const rawPattern = new RegExp(
    `(^|[^a-z0-9])${escapeRegExp(engineerName.toLowerCase())}([^a-z0-9]|$)`,
    "i"
  );
  if (rawPattern.test(queryLower)) return true;

  // Phrase match in normalized text.
  const paddedQuery = ` ${normalizedQuery} `;
  const paddedEngineer = ` ${normalizedEngineer} `;
  if (paddedQuery.includes(paddedEngineer)) return true;

  // Token fallback for simple names.
  const engineerTokens = normalizedEngineer.split(" ").filter(Boolean);
  if (engineerTokens.length === 0) return false;
  if (engineerTokens.length === 1) return normalizedQueryTokens.has(engineerTokens[0]);
  return engineerTokens.every((token) => normalizedQueryTokens.has(token));
};

const pathExists = async (target: string) => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

const discoverThemeRoot = async (teamRoot?: string) => {
  if (teamRoot) {
    return path.resolve(teamRoot);
  }

  const candidates = [
    path.join(process.cwd(), "themes"),
    path.join(process.cwd(), "teams"),
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return candidates[1];
};

const loadThemes = async (teamRoot?: string): Promise<ThemeNode[]> => {
  const themeRoot = await discoverThemeRoot(teamRoot);
  if (!(await pathExists(themeRoot))) {
    return [];
  }

  const entries = await fs.readdir(themeRoot, { withFileTypes: true });
  const themes: ThemeNode[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const themePath = path.join(themeRoot, entry.name);
    const children = await fs.readdir(themePath, { withFileTypes: true });
    const engineers = children
      .filter((child) => child.isDirectory())
      .map((child) => child.name)
      .sort((a, b) => a.localeCompare(b));

    themes.push({
      name: entry.name,
      engineers,
    });
  }

  return themes.sort((a, b) => a.name.localeCompare(b.name));
};

const openDashboardWidget = (
  focus: string | undefined,
  output: ReturnType<typeof object>,
  extraProps: Record<string, unknown> = {}
) => {
  const subtitle = focus ? `Focus: ${focus}` : "Context infrastructure for AI agents";
  return widget({
    props: { title: "ultracontext", subtitle, ...extraProps },
    output,
  });
};

const queryWithDashboard = async ({
  query,
  teamRoot,
  teams,
  engineers,
  limit,
}: {
  query: string;
  teamRoot?: string;
  teams?: string[];
  engineers?: string[];
  limit?: number;
}) => {
  try {
    const explicitTeams = normalizeStringList(teams);
    const explicitEngineers = normalizeStringList(engineers);
    const resolvedTeams = explicitTeams;
    const resolvedEngineers = explicitEngineers;

    const [result, themes] = await Promise.all([
      queryEngineerTasks({
        prompt: query,
        teamRoot,
        teams: resolvedTeams.length > 0 ? resolvedTeams : undefined,
        engineers: resolvedEngineers.length > 0 ? resolvedEngineers : undefined,
        limit,
      }),
      loadThemes(teamRoot),
    ]);

    const queryLower = query.toLowerCase();
    const normalizedQuery = normalizeForLookup(query);
    const normalizedQueryTokens = new Set(
      normalizedQuery.split(" ").map((token) => token.trim()).filter(Boolean)
    );

    const mentionedEngineers = themes
      .flatMap((theme) => theme.engineers)
      .filter((name, idx, all) => all.indexOf(name) === idx)
      .filter((name) =>
        isEngineerMentioned(name, queryLower, normalizedQuery, normalizedQueryTokens)
      );

    const matchedEngineers = result.matches
      .map((match) => match.engineer)
      .filter((name, idx, all) => all.indexOf(name) === idx);

    const focusEngineers = normalizeStringList([
      ...resolvedEngineers,
      ...mentionedEngineers,
      ...matchedEngineers,
    ]).slice(0, 24);

    const scopedResult = {
      ...result,
      appliedScope: {
        teams: resolvedTeams,
        engineers: resolvedEngineers,
      },
    };

    return openDashboardWidget(query, object(scopedResult), {
      query,
      themes,
      focusEngineers,
    });
  } finally {
    enqueueFabioSessionSync();
  }
};

server.tool(
  {
    name: "query-context",
    description:
      "General-purpose search over engineer task logs in ~/teams.",
    schema: z.object({
      query: z.string().describe("Task query or prompt text (supports `claude -p` style queries)"),
      teamRoot: z
        .string()
        .optional()
        .describe("Team root dir (default: <repo>/teams)"),
      teams: z
        .array(z.string())
        .optional()
        .describe("Filter by team names, e.g. ['frontend', 'backend']"),
      engineers: z
        .array(z.string())
        .optional()
        .describe("Filter by engineer names"),
      limit: z.number().int().min(1).max(200).optional().default(20),
    }),
    widget: {
      name: "product-search-result",
      invoking: "Opening dashboard and querying context...",
      invoked: "Query complete",
    },
  },
  async ({ query, teamRoot, teams, engineers, limit }) =>
    queryWithDashboard({
      query,
      teamRoot,
      teams,
      engineers,
      limit,
    })
);

server.tool(
  {
    name: "search-tools",
    description: "Compatibility alias for query-context; opens dashboard and runs the query",
    schema: z.object({
      query: z.string().optional().describe("Legacy search query; mapped to query-context"),
      focus: z.string().optional().describe("Legacy fallback query text"),
      teamRoot: z
        .string()
        .optional()
        .describe("Team root dir (default: <repo>/teams)"),
      teams: z
        .array(z.string())
        .optional()
        .describe("Filter by team names, e.g. ['frontend', 'backend']"),
      engineers: z
        .array(z.string())
        .optional()
        .describe("Filter by engineer names"),
      limit: z.number().int().min(1).max(200).optional().default(20),
    }),
    widget: {
      name: "product-search-result",
      invoking: "Opening dashboard and querying context...",
      invoked: "Query complete",
    },
  },
  async ({ query, focus, teamRoot, teams, engineers, limit }) =>
    queryWithDashboard({
      query: query ?? focus ?? "",
      teamRoot,
      teams,
      engineers,
      limit,
    })
);

server.listen().then(() => {
  console.log(`Server running`);
});
