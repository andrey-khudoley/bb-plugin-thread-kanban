import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { cardActivityChanged, cardActivityRpc, cardStateTag } from './card-activity-contract';
import { activityFromEvents } from './card-activity';
import { readWorkStartedAt } from './card-work-time-server';

export function registerCardActivity(bb: BbPluginApi) {
  // Events carry only invalidation IDs. Arguments, file contents and reasoning stay on the server.
  const changed = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invalidate = (threadId: string) => {
    changed.add(threadId);
    if (!timer) timer = setTimeout(() => {
      timer = undefined; const ids = [...changed]; changed.clear();
      bb.realtime.publish(cardActivityChanged, { ids });
      bb.rpc.experimental_invalidate(ids.map(cardStateTag));
    }, 180);
  };
  bb.events.on('experimental_thread.events', ({ thread }) => invalidate(thread.id));
  for (const event of ['thread.active', 'thread.idle', 'thread.failed', 'thread.archived', 'thread.unarchived', 'thread.deleted'] as const)
    bb.events.on(event, ({ thread }) => invalidate(thread.id));
  bb.onDispose(() => { clearTimeout(timer); changed.clear(); });
  bb.rpc.register(cardActivityRpc, {
    async cardThreadStates({ keys }) {
      if (!keys.length) return {};
      const rows = (await Promise.all([false, true].map(archived => bb.sdk.threads.list({
        threadIds: [...new Set(keys)], includeHidden: true, archived, limit: 200,
      })))).flat();
      return Object.fromEntries(rows.map(thread => [thread.id, {
        id: thread.id, isArchived: thread.archivedAt !== null, status: thread.status,
        runtimeStatus: thread.runtime.displayStatus, queuedWork: thread.queuedWork,
        hasPendingInteraction: thread.hasPendingInteraction, updatedAt: thread.updatedAt,
        activity: { workflows: thread.activity.activeWorkflowCount, backgroundAgents: thread.activity.activeBackgroundAgentCount,
          backgroundCommands: thread.activity.activeBackgroundCommandCount, planMode: thread.activity.activePlanModeCount },
      }]));
    },
    async cardActivities({ keys }) {
      const result: Record<string, ReturnType<typeof activityFromEvents> & { startedAt: number | null }> = {};
      if (!keys.length) return result;
      // Restrict reads to running chats and keep concurrency bounded on large boards.
      const threads = await bb.sdk.threads.list({ threadIds: [...new Set(keys)], includeHidden: true, limit: 100 });
      const active = threads.filter(thread => thread.archivedAt === null && (
        ['active', 'starting', 'stopping', 'provisioning', 'waiting-for-host'].includes(thread.runtime.displayStatus) ||
        thread.queuedWork === 'waiting' || thread.activity.activeWorkflowCount > 0 ||
        thread.activity.activeBackgroundAgentCount > 0 || thread.activity.activeBackgroundCommandCount > 0 || thread.activity.activePlanModeCount > 0));
      for (let offset = 0; offset < active.length; offset += 6) {
        await Promise.all(active.slice(offset, offset + 6).map(async thread => {
          const events = await bb.sdk.threads.events.list({ threadId: thread.id, order: 'desc', limit: '100',
            types: ['client/turn/requested', 'turn/started', 'turn/completed', 'system/thread/interrupted',
              'item/started', 'item/completed', 'item/toolCall/progress', 'item/mcpToolCall/progress'] });
          result[thread.id] = { ...activityFromEvents(events), startedAt: await readWorkStartedAt(bb, thread.id) };
        }));
      }
      return result;
    },
  });
}
