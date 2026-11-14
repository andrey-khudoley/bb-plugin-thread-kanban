import { useSyncExternalStore } from 'react';
import { formatWorkDuration } from './card-work-time';

// One local clock for all visible timers. Ticks update only these small components.
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const tick = () => { now = Date.now(); for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) {
    now = Date.now();
    timer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { clearInterval(timer); timer = undefined; document.removeEventListener('visibilitychange', tick); }
  };
};
const snapshot = () => now;
export const useKanbanClock = () => useSyncExternalStore(subscribe, snapshot, snapshot);

function RunningTime({ startedAt }: { startedAt: number }) {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const duration = formatWorkDuration(startedAt, current);
  return <span className="kb-card-work-time" data-work-started-at={startedAt}
    title={`Начало работы: ${new Date(startedAt).toLocaleString('ru-RU')}`}
    aria-label={`В работе · ${duration}`}>
    <span>В работе · </span><span className="kb-card-work-value">{duration}</span>
  </span>;
}

export function CardWorkTime({ stage, startedAt }: { stage: string; startedAt: number | null }) {
  return stage === 'working' && startedAt !== null && Number.isFinite(startedAt) && startedAt > 0 ?
    <RunningTime startedAt={startedAt} /> : null;
}
