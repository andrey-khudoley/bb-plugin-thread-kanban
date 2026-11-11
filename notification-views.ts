export type ViewedTargets = { threadIds: string[]; issueIds: string[] };

/** Native tabs stay mounted: acknowledge only card/chat content actually visible on screen. */
export function visibleNotificationTargets(doc: Document): ViewedTargets {
  const result = { threadIds: new Set<string>(), issueIds: new Set<string>() };
  if (doc.visibilityState !== 'visible' || !doc.hasFocus()) return { threadIds: [], issueIds: [] };
  for (const element of Array.from(doc.querySelectorAll<HTMLElement>('[data-kanban-panel="workspace"], [data-kanban-panel="issue"]'))) {
    if (element.closest('[hidden], [aria-hidden="true"]') || !element.getClientRects().length) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 ||
      rect.top >= (doc.defaultView?.innerHeight ?? 0) || rect.left >= (doc.defaultView?.innerWidth ?? 0)) continue;
    const id = element.dataset.kanbanId;
    if (!id) continue;
    if (element.dataset.kanbanPanel === 'issue') result.issueIds.add(id);
    else if (element.dataset.kanbanTab === 'chat') result.threadIds.add(id);
  }
  return { threadIds: [...result.threadIds].sort(), issueIds: [...result.issueIds].sort() };
}

export function mountNotificationViews(doc: Document, viewed: (targets: ViewedTargets) => void) {
  const win = doc.defaultView!;
  let stopped = false, queued = false, signature = '';
  function refresh(force = false) {
    if (stopped) return;
    const targets = visibleNotificationTargets(doc);
    viewed(targets);
    const next = JSON.stringify(targets);
    if (force || next !== signature) {
      signature = next;
      win.dispatchEvent(new CustomEvent('bb:notification-view', { detail: { source: 'kanban', ...targets } }));
    }
  }
  const schedule = () => {
    if (queued || stopped) return;
    queued = true;
    queueMicrotask(() => { queued = false; refresh(); });
  };
  const request = () => refresh(true);
  const observer = new MutationObserver(schedule);
  observer.observe(doc.body, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['data-kanban-id', 'data-kanban-tab', 'hidden', 'aria-hidden', 'style', 'class'] });
  win.addEventListener('focus', schedule); win.addEventListener('blur', schedule);
  win.addEventListener('resize', schedule); win.addEventListener('bb:notification-view-request', request);
  doc.addEventListener('visibilitychange', schedule); doc.addEventListener('scroll', schedule, true);
  refresh(true);
  return { refresh, dispose() {
    stopped = true; observer.disconnect();
    win.removeEventListener('focus', schedule); win.removeEventListener('blur', schedule);
    win.removeEventListener('resize', schedule); win.removeEventListener('bb:notification-view-request', request);
    doc.removeEventListener('visibilitychange', schedule); doc.removeEventListener('scroll', schedule, true);
    win.dispatchEvent(new CustomEvent('bb:notification-view', { detail: { source: 'kanban', threadIds: [], issueIds: [] } }));
  } };
}
