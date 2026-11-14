import { useEffect, useRef, useState } from 'react';
import type { Notice } from './notification-contract';

/** Only foreground, visible chat content is acknowledged; mounted background tabs are not. */
export function useViewedNotifications(nativeThreadId: string | null, notices: readonly Notice[],
  viewThread: (threadId: string) => Promise<void>, readNotice?: (id: string) => Promise<void>) {
  const [active, setActive] = useState(() => document.visibilityState === 'visible' && document.hasFocus());
  const [kanbanThreads, setKanbanThreads] = useState<string[]>([]);
  const [kanbanIssues, setKanbanIssues] = useState<string[]>([]);
  const handled = useRef(new Map<string, string>());
  const handledResults = useRef(new Set<string>());
  useEffect(() => {
    const focus = () => setActive(document.visibilityState === 'visible' && document.hasFocus());
    const receive = (event: Event) => {
      const data = (event as CustomEvent).detail;
      if (data?.source !== 'kanban' || !Array.isArray(data.threadIds)) return;
      setKanbanThreads(data.threadIds.filter((id: unknown): id is string => typeof id === 'string'));
      setKanbanIssues(Array.isArray(data.issueIds) ? data.issueIds.filter((id: unknown): id is string => typeof id === 'string') : []);
    };
    document.addEventListener('visibilitychange', focus);
    window.addEventListener('focus', focus); window.addEventListener('blur', focus);
    window.addEventListener('bb:notification-view', receive);
    window.dispatchEvent(new Event('bb:notification-view-request'));
    return () => {
      document.removeEventListener('visibilitychange', focus);
      window.removeEventListener('focus', focus); window.removeEventListener('blur', focus);
      window.removeEventListener('bb:notification-view', receive);
    };
  }, []);
  useEffect(() => {
    const publish = () => window.dispatchEvent(new CustomEvent('bb:notification-view', { detail: {
      source: 'native', threadIds: active && nativeThreadId ? [nativeThreadId] : [], issueIds: [],
    } }));
    window.addEventListener('bb:notification-view-request', publish);
    publish();
    return () => window.removeEventListener('bb:notification-view-request', publish);
  }, [active, nativeThreadId]);
  useEffect(() => {
    if (!active) return;
    const visible = new Set([...kanbanThreads, ...(nativeThreadId ? [nativeThreadId] : [])]);
    for (const threadId of visible) {
      const entries = notices.filter(notice => !notice.derivationId && !notice.issueId && notice.threadId === threadId && notice.readAt === null);
      if (!entries.length) continue;
      const key = `${threadId}:${entries.map(notice => notice.id).sort().join(',')}`;
      if (handled.current.get(threadId) === key) continue;
      handled.current.set(threadId, key);
      void viewThread(threadId).catch(() => {
        if (handled.current.get(threadId) === key) handled.current.delete(threadId);
      });
    }
    const threads = new Set(notices.map(notice => notice.threadId));
    for (const threadId of handled.current.keys()) if (!threads.has(threadId)) handled.current.delete(threadId);
  }, [active, nativeThreadId, kanbanThreads, notices, viewThread]);
  useEffect(() => {
    if (!active || !readNotice) return;
    const visibleThreads = [...kanbanThreads, ...(nativeThreadId ? [nativeThreadId] : [])];
    for (const notice of notices) {
      if (!notice.derivationId && !notice.issueId || notice.readAt !== null) continue;
      if (!(notice.issueId ? kanbanIssues.includes(notice.issueId) : visibleThreads.includes(notice.threadId))) continue;
      if (handledResults.current.has(notice.id)) continue;
      handledResults.current.add(notice.id);
      void readNotice(notice.id).catch(() => handledResults.current.delete(notice.id));
    }
    const ids = new Set(notices.map(notice => notice.id));
    for (const id of handledResults.current) if (!ids.has(id)) handledResults.current.delete(id);
  }, [active, nativeThreadId, kanbanThreads, kanbanIssues, notices, readNotice]);
}
