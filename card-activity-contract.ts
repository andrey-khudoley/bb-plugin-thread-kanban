import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const cardActivityChanged = 'kanban-card-activity';
export const cardStateTag = (id: string) => `kanban-card-state:${id}`;
const cardThreadState = z.object({ id: z.string(), isArchived: z.boolean(), status: z.string(), runtimeStatus: z.string(),
  queuedWork: z.string(), hasPendingInteraction: z.boolean(), updatedAt: z.number(),
  activity: z.object({ workflows: z.number(), backgroundAgents: z.number(), backgroundCommands: z.number(), planMode: z.number() }) });
export const cardActivityRpc = defineRpcContract({
  cardThreadStates: { input: z.object({ keys: z.array(z.string().min(1).max(160)).max(200) }),
    output: z.record(z.string(), cardThreadState), keyTags: id => [cardStateTag(id)] },
  cardActivities: { input: z.object({ keys: z.array(z.string().min(1).max(160)).max(100) }),
    output: z.record(z.string(), z.object({ label: z.string().max(160), seq: z.number(), at: z.number(),
      phase: z.enum(['active', 'done', 'error', 'stopped']), startedAt: z.number().positive().nullable() })) },
});
