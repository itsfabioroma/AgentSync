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
    name: "query-engineer-tasks",
    description:
      "Query Claude/Codex task logs from ~/team/<engineer>/log directories",
    schema: z.object({
      query: z.string().describe("Task query text"),
      teamRoot: z
        .string()
        .optional()
        .describe("Team root dir (default: ~/team)"),
      engineers: z
        .array(z.string())
        .optional()
        .describe("Optional engineer list filter"),
      limit: z.number().int().min(1).max(200).optional().default(20),
    }),
  },
  async ({ query, teamRoot, engineers, limit }) => {
    const result = await queryEngineerTasks({
      prompt: query,
      teamRoot,
      engineers,
      limit,
    });

    return object({
      ...result,
    });
  }
);

server.tool(
  {
    name: "claude-p",
    description:
      "Equivalent of `claude -p \"...\"` for querying engineer task logs",
    schema: z.object({
      p: z.string().describe("Prompt/query text used by `claude -p`"),
      teamRoot: z
        .string()
        .optional()
        .describe("Team root dir (default: ~/team)"),
      engineers: z
        .array(z.string())
        .optional()
        .describe("Optional engineer list filter"),
      limit: z.number().int().min(1).max(200).optional().default(20),
    }),
  },
  async ({ p, teamRoot, engineers, limit }) => {
    const result = await queryEngineerTasks({
      prompt: p,
      teamRoot,
      engineers,
      limit,
    });

    return object({
      command: `claude -p "${p}"`,
      ...result,
    });
  }
);

// Compatibility tool for the existing sample widget shipped in this repo.
server.tool(
  {
    name: "get-fruit-details",
    description: "Compatibility tool for the default sample widget",
    schema: z.object({
      fruit: z.string().describe("Fruit name"),
    }),
    outputSchema: z.object({
      fruit: z.string(),
      facts: z.array(z.string()),
    }),
  },
  async ({ fruit }) => {
    return object({
      fruit,
      facts: [`${fruit} details are not part of this backend`],
    });
  }
);

server.listen().then(() => {
  console.log(`Server running`);
});
