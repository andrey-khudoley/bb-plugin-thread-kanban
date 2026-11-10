import { defaultPaneHeaders, type PaneHeaders, type WindowPlacement } from './window-placement';

type Position = 'top' | 'bottom';
const preferenceKey = 'thread-kanban:split-pane-chrome:v2';

function readCompact(): Record<Position, boolean> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(preferenceKey) ?? 'null');
    if (saved && typeof saved === 'object' && 'top' in saved && 'bottom' in saved
      && typeof saved.top === 'boolean' && typeof saved.bottom === 'boolean') return { top: saved.top, bottom: saved.bottom };
    const legacy = localStorage.getItem('thread-kanban:compact-split-chrome') === 'true';
    return { top: legacy, bottom: legacy };
  } catch { return { top: false, bottom: false }; }
}

/** Decorate the existing panes without reparenting React-owned headers or bodies. */
export function createPaneChrome(surface: HTMLElement, group: HTMLElement, main: HTMLElement, handle: HTMLElement, secondary: HTMLElement) {
  const host = group.parentElement ?? group;
  const previousHost = host.getAttribute('data-kanban-chrome-controls-host');
  host.setAttribute('data-kanban-chrome-controls-host', '');
  const controls = document.createElement('div');
  controls.dataset.kanbanSplitControls = '';
  controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', 'Шапки областей канбана');
  controls.hidden = true;
  const compact = readCompact();
  let placement: WindowPlacement = 'right';
  let open = false;
  let headers: PaneHeaders = defaultPaneHeaders;
  const marked = new Map<HTMLElement, Set<string>>();
  const buttons = new Map<Position, HTMLButtonElement>();
  const mark = (element: HTMLElement, name: string) => {
    element.setAttribute(name, '');
    const names = marked.get(element) ?? new Set<string>(); names.add(name); marked.set(element, names);
  };
  const clearMarks = () => { marked.forEach((names, element) => names.forEach((name) => element.removeAttribute(name))); marked.clear(); };
  function positionControls() {
    controls.hidden = placement === 'right' || !open;
    if (!controls.hidden) {
      const bounds = host.getBoundingClientRect();
      const divider = handle.getBoundingClientRect();
      controls.style.top = `${Math.max(12, Math.min(bounds.height - 12, divider.top - bounds.top))}px`;
    }
  }
  function update() {
    clearMarks();
    const stacked = placement !== 'right';
    for (const [pane, position] of [[main, placement === 'below' ? 'top' : 'bottom'],
      [secondary, placement === 'below' ? 'bottom' : 'top']] as const) {
      if (stacked) {
        pane.dataset.kanbanPanePosition = position;
        pane.dataset.kanbanPaneCompact = String(compact[position]);
        pane.dataset.kanbanHeaderSide = headers[position] ? 'right' : 'top';
      } else {
        delete pane.dataset.kanbanPanePosition; delete pane.dataset.kanbanPaneCompact; delete pane.dataset.kanbanHeaderSide;
      }
    }
    const header = surface.closest('[data-pane-content]')?.previousElementSibling;
    if (header instanceof HTMLElement && header.tagName === 'HEADER') mark(header, 'data-kanban-service-chrome');
    for (const bar of Array.from(secondary.querySelectorAll('[data-testid="thread-secondary-panel-top-chrome"]'))) {
      if (bar.parentElement) {
        mark(bar.parentElement, 'data-kanban-service-chrome');
        if (bar.parentElement.nextElementSibling instanceof HTMLElement) mark(bar.parentElement.nextElementSibling, 'data-kanban-native-body');
      }
    }
    for (const [position, button] of buttons) {
      const name = position === 'top' ? 'верхней' : 'нижней';
      button.textContent = `${position === 'top' ? 'Верхняя' : 'Нижняя'}: ${compact[position] ? 'показать' : 'скрыть'}`;
      button.setAttribute('aria-label', `${compact[position] ? 'Показать' : 'Скрыть'} шапку ${name} панели`);
      button.setAttribute('aria-pressed', String(compact[position]));
      button.title = `Управление шапкой ${name} области. Общая строка состояния остаётся внизу окна.`;
    }
    positionControls();
  }
  function toggle(position: Position) {
    compact[position] = !compact[position]; update();
    try { localStorage.setItem(preferenceKey, JSON.stringify(compact)); } catch { /* Keep the session usable. */ }
  }
  for (const position of ['top', 'bottom'] as const) {
    const button = document.createElement('button'); button.type = 'button';
    button.dataset.kanbanChromeToggle = position;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      // Pointer activation already ran before BB's native resize capture.
      if (!event.detail && placement !== 'right') toggle(position);
    });
    buttons.set(position, button); controls.append(button);
  }
  host.append(controls);
  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(positionControls);
  resizeObserver?.observe(host); resizeObserver?.observe(main); resizeObserver?.observe(secondary);
  const targetButton = (target: EventTarget | null) => {
    const button = target instanceof Element ? target.closest<HTMLElement>('[data-kanban-chrome-toggle]') : null;
    return button && controls.contains(button) ? button : null;
  };
  return {
    apply(next: WindowPlacement, showing: boolean, sides: PaneHeaders) { placement = next; open = showing; headers = sides; update(); },
    refresh: positionControls,
    pointerDown(event: PointerEvent) {
      const button = targetButton(event.target);
      if (!button || placement === 'right') return false;
      event.preventDefault(); event.stopImmediatePropagation();
      button.focus({ preventScroll: true }); toggle(button.dataset.kanbanChromeToggle as Position); return true;
    },
    keyDown(event: KeyboardEvent) {
      const button = targetButton(event.target);
      if (!button || placement === 'right' || !['Enter', ' '].includes(event.key)) return false;
      event.preventDefault(); event.stopImmediatePropagation(); toggle(button.dataset.kanbanChromeToggle as Position); return true;
    },
    dispose() {
      resizeObserver?.disconnect(); controls.remove(); clearMarks();
      for (const pane of [main, secondary]) {
        delete pane.dataset.kanbanPanePosition; delete pane.dataset.kanbanPaneCompact; delete pane.dataset.kanbanHeaderSide;
      }
      if (previousHost === null) host.removeAttribute('data-kanban-chrome-controls-host');
      else host.setAttribute('data-kanban-chrome-controls-host', previousHost);
    },
  };
}
