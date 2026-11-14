import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import { cardActivityChanged, cardActivityRpc } from './card-activity-contract';
import { isAgentWorking, type ActivitySample, type CardPresentation, type ActivityThread } from './card-activity';

export const CardActivityContext = createContext<Readonly<Record<string, ActivitySample>>>({});
export const useCardActivities = () => useContext(CardActivityContext);

/** One subscription and poll per board, independent of card count and layout. */
export function useBoardActivities(threads: readonly ActivityThread[]) {
  const rpc = useRpc<typeof cardActivityRpc>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [samples, setSamples] = useState<Record<string, ActivitySample>>({});
  const keys = threads.filter(isAgentWorking).map(thread => thread.id).sort().join(',');
  const refresh = useRef<(ids?: string[]) => void>(() => {});
  useRealtime(cardActivityChanged, payload => {
    const ids = payload && typeof payload === 'object' && 'ids' in payload && Array.isArray(payload.ids) ? payload.ids : [];
    refresh.current(ids.filter((id): id is string => typeof id === 'string'));
  });
  useEffect(() => {
    let disposed = false, inFlight = false, again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ids = keys ? keys.split(',') : [];
    // Invalidate at turn boundaries before an old label can be reused by a retry.
    setSamples(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => ids.includes(id))));
    async function read() {
      if (disposed || document.hidden || !ids.length) return;
      if (inFlight) { again = true; return; }
      inFlight = true;
      try {
        const next: Record<string, ActivitySample> = {};
        for (let offset = 0; offset < ids.length; offset += 100) Object.assign(next, await rpcRef.current.call('cardActivities', { keys: ids.slice(offset, offset + 100) }));
        if (!disposed) setSamples(next);
      } catch { if (!disposed) setSamples({}); }
      finally { inFlight = false; if (again && !disposed) { again = false; timer = setTimeout(() => void read(), 180); } }
    }
    refresh.current = changed => {
      if (changed && !changed.some(id => ids.includes(id))) return;
      if (!timer) timer = setTimeout(() => { timer = undefined; void read(); }, 120);
    };
    const visible = () => { if (!document.hidden) void read(); };
    document.addEventListener('visibilitychange', visible);
    const poll = setInterval(() => void read(), 1500);
    void read();
    return () => { disposed = true; refresh.current = () => {}; clearTimeout(timer); clearInterval(poll); document.removeEventListener('visibilitychange', visible); };
  }, [keys]);
  return samples;
}

export function CardStatus({ value, open }: { value: CardPresentation; open: () => void }) {
  const label = value.state === 'error' ? `${value.hint}. Открыть подробности ошибки` : value.hint;
  return <button type="button" className="kb-card-status" data-state={value.state} title={label} aria-label={label} onClick={open}>
    <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {value.state === 'working' ? <><circle cx="12" cy="12" r="8.5" /><path d="m10 8 6 4-6 4z" /></> :
        value.state === 'waiting' ? <><path d="M4 4h16v12H9l-5 4z" /><path d="M12 7v4m0 2h.01" /></> :
        value.state === 'error' ? <><path d="m12 3 10 18H2z" /><path d="M12 9v5m0 3h.01" /></> :
        value.state === 'done' ? <><circle cx="12" cy="12" r="8.5" /><path d="m8 12 3 3 5-6" /></> :
        <circle cx="12" cy="12" r="5" strokeDasharray="2 3" />}
    </svg>
  </button>;
}

export function CardActivityLine({ value }: { value: CardPresentation }) {
  return <div className="kb-card-activity" data-state={value.state} title={value.label} tabIndex={0} aria-label={`Текущее действие: ${value.label}`}>
    <span>{value.label}</span>
  </div>;
}
