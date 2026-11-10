import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useBbNavigate } from '@get-bb/plugin-sdk/app';
import { DerivationNotifications, DerivationPolling, useActivityRuns } from './derive-activity';
import { focusStatusChat } from './status-navigation';
import { usePortalScopeProps } from './lib/portal-scope';
import { activityStore } from './activity-store';

/** Optional integration: status-bar owns the panel; Kanban owns task generation and card navigation. */
export function StatusContribution() {
  const runs = useActivityRuns();
  const navigate = useBbNavigate();
  const scope = usePortalScopeProps();
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const update = () => setTarget(document.querySelector<HTMLElement>('[data-bb-status-notification-contributions]'));
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true }); update();
    const focus = (event: Event) => {
      const id = (event as CustomEvent).detail?.threadId;
      if (typeof id === 'string' && focusStatusChat(id)) event.preventDefault();
    };
    window.addEventListener('bb:focus-status-chat', focus);
    const clear = () => activityStore().hideAll();
    window.addEventListener('bb:clear-status-notifications', clear);
    return () => { observer.disconnect(); window.removeEventListener('bb:focus-status-chat', focus);
      window.removeEventListener('bb:clear-status-notifications', clear); };
  }, []);
  return <><DerivationPolling /><span hidden data-bb-status-contribution-count={runs.filter(run => !run.hidden).length} />
    {target && createPortal(<div {...scope}>
      <DerivationNotifications openTree={id => {
        window.dispatchEvent(new Event('bb:close-status-notifications'));
        navigate.toPluginPanel('board', { subPath: `issue-tree/${id}` });
      }} />
    </div>, target)}
  </>;
}
