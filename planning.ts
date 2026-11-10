import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const priorities = {
  urgent: "Срочно",
  high: "Высокий",
  normal: "Обычный",
  low: "Низкий",
} as const;

const maxTags = 12;
export const testTag = "Test";
export const isTestTag = (tag: string) => tag.toLowerCase() === "test";

export function withTestTag(tags: string[]) {
  return [testTag, ...tags.filter((tag) => !isTestTag(tag)).slice(0, maxTags - 1)];
}

export const planSchema = z.object({
  notes: z.string().max(12000).default(""),
  priority: z.enum(["urgent", "high", "normal", "low"]).nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(40)).max(maxTags).default([])
    .transform((tags) => tags.some(isTestTag) ? withTestTag(tags) : tags),
});

export type Plan = z.infer<typeof planSchema>;
export const emptyPlan = planSchema.parse({});
export const planChanged = "plan-changed";

export const planRpc = defineRpcContract({
  planList: {
    input: z.object({ keys: z.array(z.string().min(1)).min(1).max(200) }),
    output: z.record(z.string(), planSchema),
  },
  planSave: {
    input: z.object({ threadId: z.string().min(1), plan: planSchema }),
    output: planSchema,
  },
});
