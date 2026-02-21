import { z } from "zod";

export const propSchema = z.object({
  title: z.string().optional().describe("Dashboard title"),
  subtitle: z.string().optional().describe("Dashboard subtitle"),
  source: z.string().optional().describe("Dashboard HTML path"),
});

export type DashboardWidgetProps = z.infer<typeof propSchema>;

export type AccordionItemProps = {
  question: string;
  answer: string;
  isOpen: boolean;
  onToggle: () => void;
};
