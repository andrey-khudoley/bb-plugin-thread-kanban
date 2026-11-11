export type FooterItem = { id: string; label: string; icon: string; disabled: boolean; expanded: boolean };
export type FooterSnapshot = { items: FooterItem[]; usage: string; usageTitle: string };
const usageTestId = 'plugin-sidebar-footer-item-bb--provider-usage-usage';

/** Adapt host-owned footer controls without moving React nodes or mounting service components twice. */
export function mountStatusShell(changed: (snapshot: FooterSnapshot) => void) {
  const style = document.createElement('style');
  // Ownership lives in the DOM so independently bundled plugin copies share it.
  style.dataset.kanbanStatusShellOwner = '';
  style.textContent = `
    html[data-kanban-status-shell] [data-testid="app-layout-root"] {
      height: calc(100% - 26px - env(safe-area-inset-bottom)) !important;
      --bb-shell-height: calc(100dvh - 26px - env(safe-area-inset-bottom));
    }
    /* BB portals the mobile side panel directly into body, outside app-layout-root.
       Reserve the same row there, while retaining BB's own live viewport height. */
    html[data-kanban-status-shell] [data-testid="secondary-panel-shelf"] {
      height: calc(var(--bb-shell-height) - 26px - env(safe-area-inset-bottom)) !important;
    }
    html[data-kanban-status-shell] [data-sidebar="footer"] {
      height: 0 !important; min-height: 0 !important; padding: 0 !important; gap: 0 !important; overflow: visible !important;
    }
    html[data-kanban-status-shell] [data-sidebar="footer"] > [data-sidebar="menu"] { display: none !important; }
    html[data-kanban-status-shell] [id^="plugin-sidebar-footer-disclosure-"] { display: none !important; }
    html[data-kanban-status-shell] [data-kanban-native-disclosure]:popover-open {
      display: block !important; position: fixed !important; inset: auto 8px 32px auto !important;
      margin: 0 !important; width: min(390px, calc(100vw - 16px)) !important;
      height: auto !important; max-height: calc(100dvh - 64px) !important; overflow: auto !important;
      visibility: visible !important; color: var(--foreground); background: var(--popover, var(--background));
      border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 6px 24px #0005;
    }
    html[data-kanban-status-shell] [data-kanban-native-footer-menu] {
      position: fixed !important; inset: auto 8px 32px auto !important; transform: none !important;
    }
  `;
  document.head.append(style);
  document.documentElement.setAttribute('data-kanban-status-shell', '');
  let disposed = false, scheduled = false, serialized = '';
  let active: string | null = null;
  let preloaded: Element | null = null;
  let lastUsage: { usage: string; usageTitle: string } | null = null;
  const promoted = new Map<HTMLElement, string | null>();
  const menus = new Set<HTMLElement>();
  const sources = new Map<string, HTMLElement>();
  const preloadedByAdapter = new Set<HTMLElement>();
  const findSection = (source: HTMLElement) => {
    const id = source.getAttribute('aria-controls');
    return id ? document.getElementById(id) : null;
  };
  function hideDisclosures() {
    for (const element of promoted.keys()) if (element.matches(':popover-open')) element.hidePopover();
  }
  function promote(element: HTMLElement) {
    if (!promoted.has(element)) {
      promoted.set(element, element.getAttribute('popover'));
      element.setAttribute('popover', 'manual'); element.dataset.kanbanNativeDisclosure = '';
    }
    if (!element.matches(':popover-open')) {
      element.showPopover();
      element.querySelector<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled)')?.focus({ preventScroll: true });
    }
  }
  function read() {
    if (disposed) return;
    // Recover if an older adapter's cleanup removed the shared reservation.
    if (!document.documentElement.hasAttribute('data-kanban-status-shell'))
      document.documentElement.setAttribute('data-kanban-status-shell', '');
    sources.clear();
    const items: FooterItem[] = [];
    for (const source of Array.from(document.querySelectorAll<HTMLElement>('[data-sidebar="footer"] [data-sidebar="menu-button"]'))) {
      const id = source.id;
      if (!id) continue;
      sources.set(id, source);
      items.push({ id, label: source.getAttribute('aria-label') ?? source.textContent?.trim() ?? 'Сервис BB',
        icon: source.querySelector('[data-icon-root]')?.outerHTML ?? '',
        disabled: source.hasAttribute('disabled') || source.getAttribute('aria-disabled') === 'true',
        expanded: source.getAttribute('aria-expanded') === 'true' });
    }
    const source = document.querySelector<HTMLElement>(`[data-testid="${usageTestId}"]`);
    const section = source && findSection(source);
    const labels = section ? Array.from(section.querySelectorAll<HTMLElement>('button[aria-label]'))
      .map(button => button.getAttribute('aria-label') ?? '').filter(label => /\d+%/.test(label)) : [];
    const percents = labels.flatMap(label => Number(/(\d+)%/.exec(label)?.[1] ?? 0));
    const text = section?.textContent ?? '';
    let usage = percents.length ? `${Math.max(...percents)}%` : /couldn.t|failed|error|ошиб/i.test(text) ? 'ошибка' :
      section?.querySelector('[aria-label="Reload provider usage"][disabled]') ? '…' : '—';
    let usageTitle = labels.length ? `Использовано: ${labels.join('; ')}` :
      usage === 'ошибка' ? 'Не удалось загрузить лимиты. Откройте подробности для повторной загрузки.' :
      usage === '…' ? 'Загрузка текущих лимитов…' : 'Нет данных о лимитах. Открыть подробности.';
    if (labels.length || usage === 'ошибка') lastUsage = { usage, usageTitle };
    else if (lastUsage) {
      usage = lastUsage.usage;
      usageTitle = `${lastUsage.usageTitle} Последние полученные данные. Откройте подробности для обновления.`;
    }
    const snapshot = { items, usage, usageTitle };
    const next = JSON.stringify(snapshot);
    if (next !== serialized) { serialized = next; changed(snapshot); }
    if (active) {
      const trigger = sources.get(active);
      const disclosure = trigger && findSection(trigger);
      if (disclosure) promote(disclosure);
      if (active === 'sidebar-footer-more' && trigger?.getAttribute('aria-expanded') === 'true') {
        const menu = document.querySelector<HTMLElement>('[data-radix-popper-content-wrapper]:has([role="menu"][aria-labelledby="sidebar-footer-more"])');
        if (menu) { menu.dataset.kanbanNativeFooterMenu = ''; menus.add(menu); }
      }
    }
    // Use the existing single usage component/cache and its refresh schedule. No parallel RPC/polling path.
    if (source && source !== preloaded) {
      preloaded = source;
      if (source.getAttribute('aria-expanded') !== 'true' && !items.some(item => item.expanded)) {
        preloadedByAdapter.add(source); source.click();
      }
    }
  }
  const schedule = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; read(); });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['aria-expanded', 'aria-label', 'disabled', 'data-state'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-kanban-status-shell'] });
  const dismiss = () => { active = null; hideDisclosures(); };
  const outside = (event: PointerEvent) => {
    if (event.target instanceof Element && !event.target.closest('[data-kanban-native-disclosure], [data-kanban-service]')) dismiss();
  };
  const keyboard = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && active) {
      const id = active; dismiss();
      document.querySelector<HTMLElement>(`[data-kanban-service="${CSS.escape(id)}"]`)?.focus();
    }
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', keyboard);
  read();
  return {
    activate(id: string) {
      const source = sources.get(id);
      if (!source) return false;
      if (active === id && findSection(source)?.matches(':popover-open')) { dismiss(); return true; }
      hideDisclosures(); active = id;
      const section = findSection(source);
      if (section) promote(section);
      else if (source.getAttribute('aria-haspopup') === 'menu') {
        source.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      } else source.click();
      schedule(); return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true; observer.disconnect(); dismiss();
      document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keyboard);
      for (const [element, previous] of promoted) {
        if (previous === null) element.removeAttribute('popover'); else element.setAttribute('popover', previous);
        delete element.dataset.kanbanNativeDisclosure;
      }
      menus.forEach(element => { delete element.dataset.kanbanNativeFooterMenu; });
      preloadedByAdapter.forEach(source => {
        if (source.isConnected && source.getAttribute('aria-expanded') === 'true') source.click();
      });
      style.remove();
      if (!document.head.querySelector('style[data-kanban-status-shell-owner]'))
        document.documentElement.removeAttribute('data-kanban-status-shell');
    },
  };
}
