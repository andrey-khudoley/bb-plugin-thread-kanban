import { useCallback, useEffect, useRef, useState } from 'react';
import type { Notice } from './notification-contract';

export type Popup = { id: string; label: string; title: string; threadId?: string; noticeId?: string };

/** Per-window session state. Observing history or reconnecting never replays old popups. */
export function createArrivalTracker(storage?: Pick<Storage, 'getItem' | 'setItem'>, startedAt = Date.now()) {
  const key = 'status-bar:popup-seen:v1';
  let seen = new Set<string>();
  try {
    const saved: unknown = JSON.parse(storage?.getItem(key) ?? '[]');
    if (Array.isArray(saved)) seen = new Set(saved.filter((id): id is string => typeof id === 'string').slice(-1000));
  } catch { /* Popups still work when browser storage is unavailable. */ }
  const claim = (id: string) => {
    if (seen.has(id)) return false;
    seen.add(id);
    seen = new Set([...seen].slice(-1000));
    try { storage?.setItem(key, JSON.stringify([...seen])); } catch { /* Keep the in-memory deduplication. */ }
    return true;
  };
  return {
    claim,
    observe(notices: readonly Notice[]): Popup[] {
      const fresh: Popup[] = [];
      for (const notice of [...notices].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
        if (!claim(notice.id)) continue;
        if (notice.readAt !== null || notice.createdAt < startedAt) continue;
        fresh.push({ id: notice.id, noticeId: notice.id, threadId: notice.threadId, title: notice.title,
          label: notice.kind === 'question' ? 'Требуется ответ' : 'Работа завершена' });
      }
      return fresh;
    },
  };
}

export function usePopupArrivals(notices: readonly Notice[]) {
  const tracker = useRef<ReturnType<typeof createArrivalTracker> | null>(null);
  if (!tracker.current) {
    let storage: Storage | undefined;
    try { storage = sessionStorage; } catch { /* Private browser or SSR. */ }
    tracker.current = createArrivalTracker(storage);
  }
  const [queue, setQueue] = useState<Popup[]>([]);
  const dismiss = useCallback((id: string) => { setQueue(current => current.filter(item => item.id !== id)); }, []);
  const clear = useCallback(() => { setQueue([]); }, []);
  const notify = useCallback((item: Popup) => {
    if (tracker.current!.claim(item.id)) setQueue(current => [...current, item]);
  }, []);
  useEffect(() => {
    const arrivals = tracker.current!.observe(notices);
    if (arrivals.length) setQueue(current => [...current, ...arrivals]);
    const read = new Set(notices.filter(notice => notice.readAt !== null).map(notice => notice.id));
    const visible = new Set(notices.map(notice => notice.id));
    setQueue(current => current.filter(item => !item.noticeId || visible.has(item.id) && !read.has(item.id)));
  }, [notices]);
  useEffect(() => {
    const receive = (event: Event) => {
      const data = (event as CustomEvent).detail;
      if (!data || typeof data.id !== 'string' || typeof data.label !== 'string' || typeof data.title !== 'string') return;
      notify({ id: data.id.slice(0, 250), label: data.label.slice(0, 120), title: data.title.slice(0, 500) });
    };
    window.addEventListener('bb:status-popup', receive);
    return () => window.removeEventListener('bb:status-popup', receive);
  }, [notify]);
  return { queue, dismiss, notify, clear };
}

function PopupCard({ item, dismiss, open, duration }: {
  item: Popup; dismiss: (id: string) => void; open: (item: Popup) => void; duration: number;
}) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => dismiss(item.id), duration);
    return () => clearTimeout(timer);
  }, [item.id, paused, duration, dismiss]);
  return <article className="kb-notification-popup" data-notification-popup={item.id}
    onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
    onFocusCapture={() => setPaused(true)} onBlurCapture={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
    }}>
    <div role="status" aria-live="polite" aria-atomic="true">
      <strong>{item.label}</strong><p title={item.title}>{item.title}</p>
    </div>
    <button type="button" className="kb-notification-popup-open" onClick={() => { open(item); dismiss(item.id); }}>Открыть</button>
    <button type="button" className="kb-notification-popup-close" aria-label={`Скрыть уведомление: ${item.title}`}
      onClick={() => dismiss(item.id)}>×</button>
  </article>;
}

export function NotificationPopups({ items, dismiss, open, duration = 8000 }: {
  items: readonly Popup[]; dismiss: (id: string) => void; open: (item: Popup) => void; duration?: number;
}) {
  return <aside className="kb-notification-popups" aria-label="Новые уведомления">
    {items.slice(0, 3).map(item => <PopupCard key={item.id} item={item} dismiss={dismiss} open={open} duration={duration} />)}
    {items.length > 3 && <span className="kb-notification-popup-more">Ещё уведомлений: {items.length - 3}</span>}
  </aside>;
}
