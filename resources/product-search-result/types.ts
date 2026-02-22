import { z } from "zod";

export const propSchema = z.object({
  title: z.string().optional().describe("Dashboard title"),
  subtitle: z.string().optional().describe("Dashboard subtitle"),
  source: z.string().optional().describe("Dashboard HTML path"),
  query: z.string().optional().describe("Current query string"),
  themes: z
    .array(
      z.object({
        name: z.string(),
        engineers: z.array(z.string()).optional(),
      })
    )
    .optional()
    .describe("Runtime themes and optional engineer names for graph nodes"),
  selectedNodeIds: z
    .array(z.string())
    .optional()
    .describe("Node IDs that should render as selected"),
  scopeTeams: z
    .array(z.string())
    .optional()
    .describe("Team filters currently applied to query scope"),
  scopeEngineers: z
    .array(z.string())
    .optional()
    .describe("Engineer filters currently applied to query scope"),
  focusEngineers: z
    .array(z.string())
    .optional()
    .describe("Engineers that should be highlighted and expanded after query"),
});

export type DashboardWidgetProps = z.infer<typeof propSchema>;

export type AccordionItemProps = {
  question: string;
  answer: string;
  isOpen: boolean;
  onToggle: () => void;
};
