import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { ActivityEvent } from './card-activity';
import { workStartedAt } from './card-work-time';

/** Recover from BB's durable lifecycle events, never from observation or page-load time. */
export async function readWorkStartedAt(bb: BbPluginApi, threadId: string) {
  let beforeSeq: string | undefined;
  const period: ActivityEvent[] = [];
  while (true) {
    const events = await bb.sdk.threads.events.list({ threadId, order: 'desc', limit: '100', beforeSeq,
      types: ['client/turn/requested', 'turn/started', 'turn/completed', 'system/thread/interrupted'] });
    const sorted = [...events].sort((a, b) => b.seq - a.seq);
    const end = sorted.findIndex(event => event.type === 'turn/completed' || event.type === 'system/thread/interrupted');
    period.push(...(end >= 0 ? sorted.slice(0, end) : sorted));
    if (end >= 0 || events.length < 100) return workStartedAt(period);
    const next = sorted.at(-1)!.seq;
    if (beforeSeq !== undefined && next >= Number(beforeSeq)) return null;
    beforeSeq = String(next);
  }
}
