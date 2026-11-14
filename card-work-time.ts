import type { ActivityEvent, ActivitySample, ActivityThread } from './card-activity';
import { isAgentWorking } from './card-activity';

export function workStartedAt(events: readonly ActivityEvent[], initial: number | null = null): number | null {
  let start = initial;
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.type === 'turn/completed' || event.type === 'system/thread/interrupted') start = null;
    else if (event.type === 'turn/started' || event.type === 'client/turn/requested') {
      // Steering an existing turn must not restart its clock (or resurrect a finished turn).
      const target = event.data.target as { kind?: string } | undefined;
      if (event.type === 'client/turn/requested' && target?.kind === 'steer') continue;
      if (Number.isFinite(event.createdAt) && event.createdAt > 0) start ??= event.createdAt;
    }
  }
  return start;
}

/** A task uses the earliest currently running linked chat, independent of sidebar order. */
export function cardWorkStartedAt(threads: readonly ActivityThread[], samples: Readonly<Record<string, ActivitySample>>) {
  return linkedWorkStartedAt(threads.filter(isAgentWorking).map(thread => thread.id), samples);
}

export function linkedWorkStartedAt(ids: readonly string[], samples: Readonly<Record<string, ActivitySample>>) {
  const starts = ids.flatMap(id => {
    const start = samples[id]?.startedAt;
    return typeof start === 'number' && Number.isFinite(start) && start > 0 ? [start] : [];
  });
  return starts.length ? Math.min(...starts) : null;
}

export function formatWorkDuration(startedAt: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  return seconds < 3600 ? `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}` :
    `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}
