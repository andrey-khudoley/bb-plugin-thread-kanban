import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useBbNavigate } from '@get-bb/plugin-sdk/app';
import { DerivationNotifications, DerivationPolling, useActivityRuns } from './derive-activity';
import { focusStatusChat, focusStatusIssue } from './status-navigation';
import { usePortalScopeProps } from './lib/portal-scope';
import { activityStore } from './activity-store';
import { mountNotificationViews, type ViewedTargets } from './notification-views';

/** Task-generation entries and card navigation share the Kanban status-bar overlay. */
export function StatusContribution() {
  const runs = useActivityRuns();
  const navigate = useBbNavigate();
  const scope = usePortalScopeProps();
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const nativeThreads = useRef<string[]>([]);
  const viewBridge = useRef<ReturnType<typeof mountNotificationViews> | null>(null);
  useEffect(() => {
    const viewed = (targets: ViewedTargets) => activityStore().view({ ...targets,
      threadIds: [...targets.threadIds, ...nativeThreads.current] });
    const receive = (event: Event) => {
      const data = (event as CustomEvent).detail;
      if (data?.source !== 'native' || !Array.isArray(data.threadIds)) return;
      nativeThreads.current = data.threadIds.filter((id: unknown): id is string => typeof id === 'string');
      viewBridge.current?.refresh();
    };
    window.addEventListener('bb:notification-view', receive);
    viewBridge.current = mountNotificationViews(document, viewed);
    window.dispatchEvent(new Event('bb:notification-view-request'));
    return () => { viewBridge.current?.dispose(); viewBridge.current = null;
      window.removeEventListener('bb:notification-view', receive); };
  }, []);
  useEffect(() => { viewBridge.current?.refresh(); }, [runs]);
  useEffect(() => {
    const update = () => setTarget(document.querySelector<HTMLElement>('[data-bb-status-notification-contributions]'));
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true }); update();
    const focus = (event: Event) => {
      if (event.defaultPrevented) return;
      const { threadId, title } = (event as CustomEvent).detail ?? {};
      if (typeof threadId === 'string' && focusStatusChat(threadId, typeof title === 'string' ? title : undefined)) event.preventDefault();
    };
    window.addEventListener('bb:focus-status-chat', focus);
    const clear = () => activityStore().hideAll();
    window.addEventListener('bb:clear-status-notifications', clear);
    return () => { observer.disconnect(); window.removeEventListener('bb:focus-status-chat', focus);
      window.removeEventListener('bb:clear-status-notifications', clear); };
  }, []);
  return <><DerivationPolling /><span hidden data-bb-status-contribution-count={runs.filter(run => !run.hidden).length} />
    {target && createPortal(<div {...scope}>
      <DerivationNotifications openCard={id => {
        window.dispatchEvent(new Event('bb:close-status-notifications'));
        if (focusStatusIssue(id)) return;
        const threadId = runs.flatMap(run => run.result?.children ?? []).find(issue => issue.id === id)?.threadIds.at(-1);
        if (threadId) navigate.toThread(threadId);
        else navigate.toPluginPanel('board', { subPath: `issue-tree/${id}` });
      }} openTree={id => {
        window.dispatchEvent(new Event('bb:close-status-notifications'));
        navigate.toPluginPanel('board', { subPath: `issue-tree/${id}` });
      }} />
    </div>, target)}
  </>;
}
