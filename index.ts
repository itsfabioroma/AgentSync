import { MCPServer, object, widget } from "mcp-use/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { queryEngineerTasks } from "./src/logBackend";

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

const RLM_ANIMATION_MS = 14_000;
const RLM_COMPLETION_GRACE_MS = 3_000;

type AnimationGate = {
  waitForCompletion: Promise<void>;
  resolve: () => void;
};

type SessionSelectionState = {
  nodeIds: string[];
  teams: string[];
  engineers: string[];
  updatedAt: number;
};

const pendingAnimationGates = new Map<string, AnimationGate[]>();
const sessionSelectionState = new Map<string, SessionSelectionState>();

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

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

const enqueueAnimationGate = (sessionId: string): AnimationGate => {
  let settled = false;
  let resolvePromise: () => void = () => {};

  const waitForCompletion = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  const gate: AnimationGate = {
    waitForCompletion,
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
  };

  const queue = pendingAnimationGates.get(sessionId) ?? [];
  queue.push(gate);
  pendingAnimationGates.set(sessionId, queue);
  return gate;
};

const resolveAnimationGate = (sessionId: string) => {
  const queue = pendingAnimationGates.get(sessionId);
  if (!queue || queue.length === 0) return false;

  const gate = queue.shift();
  gate?.resolve();

  if (queue.length === 0) pendingAnimationGates.delete(sessionId);
  return true;
};

const removeAnimationGate = (sessionId: string, gate: AnimationGate) => {
  const queue = pendingAnimationGates.get(sessionId);
  if (!queue || queue.length === 0) return;

  const next = queue.filter((entry) => entry !== gate);
  if (next.length === 0) pendingAnimationGates.delete(sessionId);
  else pendingAnimationGates.set(sessionId, next);
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
  sessionId,
}: {
  query: string;
  teamRoot?: string;
  teams?: string[];
  engineers?: string[];
  limit?: number;
  sessionId?: string;
}) => {
  const startedAt = Date.now();
  const animationGate = sessionId ? enqueueAnimationGate(sessionId) : null;
  const selectionState = sessionId ? sessionSelectionState.get(sessionId) : undefined;

  const explicitTeams = normalizeStringList(teams);
  const explicitEngineers = normalizeStringList(engineers);
  const selectedTeams = normalizeStringList(selectionState?.teams);
  const selectedEngineers = normalizeStringList(selectionState?.engineers);

  const resolvedTeams = explicitTeams.length > 0 ? explicitTeams : selectedTeams;
  const resolvedEngineers =
    explicitEngineers.length > 0 ? explicitEngineers : selectedEngineers;
  const isSelectionScoped =
    explicitTeams.length === 0 &&
    explicitEngineers.length === 0 &&
    (selectedTeams.length > 0 || selectedEngineers.length > 0);

  try {
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

    const mentionedEngineers = themes
      .flatMap((theme) => theme.engineers)
      .filter((name, idx, all) => all.indexOf(name) === idx)
      .filter((name) => query.toLowerCase().includes(name.toLowerCase()));

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
        fromNodeSelection: isSelectionScoped,
        teams: resolvedTeams,
        engineers: resolvedEngineers,
      },
    };

    const elapsedMs = Date.now() - startedAt;
    if (animationGate) {
      const fallbackWaitMs = Math.max(
        0,
        RLM_ANIMATION_MS + RLM_COMPLETION_GRACE_MS - elapsedMs
      );
      if (fallbackWaitMs > 0) {
        await Promise.race([animationGate.waitForCompletion, sleep(fallbackWaitMs)]);
      }
    } else if (elapsedMs < RLM_ANIMATION_MS) {
      await sleep(RLM_ANIMATION_MS - elapsedMs);
    }

    return openDashboardWidget(query, object(scopedResult), {
      query,
      themes,
      selectedNodeIds: selectionState?.nodeIds ?? [],
      scopeTeams: resolvedTeams,
      scopeEngineers: resolvedEngineers,
      focusEngineers,
    });
  } finally {
    if (sessionId && animationGate) removeAnimationGate(sessionId, animationGate);
  }
};

server.tool(
  {
    name: "dashboard-rlm-complete",
    description: "Internal callback from dashboard when recursive animation completes",
    schema: z.object({
      playheadMs: z.number().optional(),
    }),
    _meta: {
      ui: { visibility: ["app"] },
      "openai/widgetAccessible": true,
    },
  },
  async (_args, ctx) => {
    resolveAnimationGate(ctx.session.sessionId);
    return object({ ok: true });
  }
);

server.tool(
  {
    name: "dashboard-set-selection",
    description:
      "Internal callback from dashboard to persist selected nodes for scoping future queries",
    schema: z.object({
      nodeIds: z.array(z.string()).optional(),
      teams: z.array(z.string()).optional(),
      engineers: z.array(z.string()).optional(),
    }),
    _meta: {
      ui: { visibility: ["app"] },
      "openai/widgetAccessible": true,
    },
  },
  async ({ nodeIds, teams, engineers }, ctx) => {
    const normalizedNodeIds = normalizeStringList(nodeIds);
    const normalizedTeams = normalizeStringList(teams);
    const normalizedEngineers = normalizeStringList(engineers);

    if (
      normalizedNodeIds.length === 0 &&
      normalizedTeams.length === 0 &&
      normalizedEngineers.length === 0
    ) {
      sessionSelectionState.delete(ctx.session.sessionId);
      return object({ ok: true, cleared: true });
    }

    sessionSelectionState.set(ctx.session.sessionId, {
      nodeIds: normalizedNodeIds,
      teams: normalizedTeams,
      engineers: normalizedEngineers,
      updatedAt: Date.now(),
    });

    return object({
      ok: true,
      selection: {
        nodeIds: normalizedNodeIds,
        teams: normalizedTeams,
        engineers: normalizedEngineers,
      },
    });
  }
);

server.tool(
  {
    name: "query-context",
    description:
      "General-purpose search over engineer task logs in ~/teams. If teams/engineers are omitted, the most recent node selection from the dashboard is applied automatically.",
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
  async ({ query, teamRoot, teams, engineers, limit }, ctx) =>
    queryWithDashboard({
      query,
      teamRoot,
      teams,
      engineers,
      limit,
      sessionId: ctx.session.sessionId,
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
  async ({ query, focus, teamRoot, teams, engineers, limit }, ctx) =>
    queryWithDashboard({
      query: query ?? focus ?? "",
      teamRoot,
      teams,
      engineers,
      limit,
      sessionId: ctx.session.sessionId,
    })
);

server.listen().then(() => {
  console.log(`Server running`);
});
