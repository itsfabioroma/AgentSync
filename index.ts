import { MCPServer, object } from "mcp-use/server";
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

server.tool(
  {
    name: "query-context",
    description:
      "General-purpose search over all engineer task logs in ~/teams. Call this for any query — it searches across all teams and engineers by default.",
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
  },
  async ({ query, teamRoot, teams, engineers, limit }) => {
    const result = await queryEngineerTasks({
      prompt: query,
      teamRoot,
      teams,
      engineers,
      limit,
    });

    return object({ ...result });
  }
);

server.listen().then(() => {
  console.log(`Server running`);
});
