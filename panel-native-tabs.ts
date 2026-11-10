/** A caption can identify several distinct native tabs; never use it as their key. */
export function nativeTabCandidates<T extends { title: string; status: string | null }>(tabs: readonly T[], label: string | null | undefined): T[] {
  return tabs.filter(tab => tab.title === label || (tab.status && [
    `${tab.title}${tab.status}`, `${tab.title}(${tab.status})`, `${tab.title} (${tab.status})`,
  ].includes(label ?? '')));
}
export function resolveNativeTab<T extends { title: string; status: string | null }>(tabs: readonly T[], label: string | null | undefined): T | null {
  const candidates = nativeTabCandidates(tabs, label);
  return candidates.length === 1 ? candidates[0] : null;
}

/** The mounted body is authoritative for the selected tab, including restored legacy tabs. */
export function resolveMountedTab<T>(pill: HTMLElement, tabs: readonly T[], sectionId: (tab: T) => string | null): T | null {
  if (!pill.querySelector('button[aria-pressed="true"]')) return null;
  // The unsplit sidebar has no data-split-pane-id. Its chrome and body are siblings.
  let pane: HTMLElement | null = pill.parentElement;
  while (pane && !pane.querySelector('[data-kanban-section]')) pane = pane.parentElement;
  if (!pane) return null;
  const bodies = pane.querySelectorAll<HTMLElement>('[data-kanban-section]');
  // A file pane may have no card body; do not borrow one from a neighbouring pane.
  if (bodies.length !== 1 || pane.querySelectorAll('[data-tab-pill] button[aria-pressed="true"]').length !== 1) return null;
  const id = bodies[0].dataset.kanbanSection;
  const matches = tabs.filter((tab) => sectionId(tab) === id);
  return matches.length === 1 ? matches[0] : null;
}

/** Desktop's unsplit sidebar uses Full Screen; split/browser panes use Maximize pane. */
export function nativeTabGroup(pill: HTMLElement): Element | null {
  const toolbar = pill.closest('[data-sidebar-split-tab-group],[role="toolbar"][aria-label="Right panel views"]');
  if (toolbar) return toolbar;
  const controls = 'button[aria-label="Maximize pane"],button[aria-label="Restore pane"]';
  let group: Element | null = pill.parentElement;
  while (group && !group.querySelector(controls)) group = group.parentElement;
  return group?.querySelectorAll(controls).length === 1 ? group : null;
}
