import { MCPServer, object, text, widget } from "mcp-use/server";
import { z } from "zod";

const server = new MCPServer({
  name: "hack-yc",
  title: "hack-yc", // display name
  version: "1.0.0",
  description: "MCP server with MCP Apps integration",
  // Do not hardcode localhost: Claude/tunnel clients need externally reachable URLs.
  baseUrl: process.env.MCP_URL,
  // Avoid dev-session transport churn across reconnects/hot reloads.
  stateless: true,
  favicon: "favicon.ico",
  websiteUrl: "https://mcp-use.com", // Can be customized later
  icons: [
    {
      src: "icon.svg",
      mimeType: "image/svg+xml",
      sizes: ["512x512"],
    },
  ],
});

const openDashboardWidget = (focus?: string) => {
  const subtitle = focus
    ? `Focus: ${focus}`
    : "Context infrastructure for AI agents";
  return widget({
    props: {
      title: "ultracontext",
      subtitle,
    },
    output: text("Opened ultracontext dashboard."),
  });
};

server.tool(
  {
    name: "show-dashboard",
    description: "Open the ultracontext dashboard widget",
    schema: z.object({
      focus: z
        .string()
        .optional()
        .describe("Optional focus string displayed as dashboard subtitle"),
    }),
    widget: {
      name: "product-search-result",
      invoking: "Opening dashboard...",
      invoked: "Dashboard ready",
    },
  },
  async ({ focus }) => openDashboardWidget(focus)
);

// Backward-compatible alias for older clients/tool plans.
server.tool(
  {
    name: "search-tools",
    description:
      "Compatibility alias: opens the ultracontext dashboard widget",
    schema: z.object({
      query: z
        .string()
        .optional()
        .describe("Legacy search query; mapped to dashboard focus"),
      focus: z
        .string()
        .optional()
        .describe("Optional focus string displayed as dashboard subtitle"),
    }),
    widget: {
      name: "product-search-result",
      invoking: "Opening dashboard...",
      invoked: "Dashboard ready",
    },
  },
  async ({ query, focus }) => openDashboardWidget(focus ?? query)
);

// Backward-compatible stub for legacy fruit flows.
server.tool(
  {
    name: "get-fruit-details",
    description: "Compatibility stub for legacy clients",
    schema: z.object({
      fruit: z.string().optional().describe("Legacy field"),
    }),
    outputSchema: z.object({
      status: z.string(),
      message: z.string(),
    }),
  },
  async ({ fruit }) =>
    object({
      status: "deprecated",
      message: fruit
        ? `Legacy fruit tool "${fruit}" is deprecated. Use show-dashboard.`
        : "Legacy fruit tool is deprecated. Use show-dashboard.",
    })
);

server.listen().then(() => {
  console.log(`Server running`);
});
