import { defaultPaneHeaders, type PaneHeaders, type WindowPlacement } from "./window-placement";
import { createPaneChrome } from './pane-chrome';

/** SDK 0.6.132 has no panel-direction API. Adapt only the existing two-panel
 * Kanban host; never move DOM nodes, touch nested splits, or change BB tab state.
 * Unknown markup stays native. All changes are removed when the board unmounts.
 */
export function createWindowPlacementLayout(surface: HTMLElement) {
  const group = surface.closest<HTMLElement>('[data-panel-group]');
  const children = group ? Array.from(group.children) : [];
  const main = children[0];
  const handle = children[1];
  const secondary = children[2];
  if (!group || children.length !== 3 || !(main instanceof HTMLElement) || !main.contains(surface)
    || !main.dataset.panelId?.startsWith('plugin-panel-main-') || !(handle instanceof HTMLElement)
    || !handle.hasAttribute('data-panel-resize-handle-id') || !(secondary instanceof HTMLElement)
    || secondary.dataset.panelId !== 'thread-detail-secondary-panel') return null;

  const original = new Map(['aria-label', 'aria-orientation', 'tabindex', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow']
    .map((name) => [name, handle.getAttribute(name)]));
  let placement: WindowPlacement = 'right';
  let stopDrag: (() => void) | null = null;
  let share = 50;
  const chrome = createPaneChrome(surface, group, main, handle, secondary);
  try {
    const saved = Number(localStorage.getItem('thread-kanban:vertical-panel-share') ?? 50);
    if (Number.isFinite(saved)) share = Math.max(20, Math.min(80, saved));
  } catch { /* Resizing also works without browser storage. */ }
  function restoreHandle() {
    for (const [name, value] of original) {
      if (value === null) handle.removeAttribute(name); else handle.setAttribute(name, value);
    }
  }
  function resize(value: number) {
    share = Math.max(20, Math.min(80, value));
    group!.style.setProperty('--kb-main-share', String(share));
    group!.style.setProperty('--kb-secondary-share', String(100 - share));
    handle.setAttribute('aria-valuenow', String(Math.round(share)));
    chrome.refresh();
  }
  function saveSize() {
    try { localStorage.setItem('thread-kanban:vertical-panel-share', String(share)); } catch { /* Session only. */ }
  }
  function pointerDown(event: PointerEvent) {
    if (placement === 'right' || event.button !== 0) return;
    if (chrome.pointerDown(event)) { stopDrag?.(); return; }
    if (!(event.target instanceof Element) || !handle.contains(event.target)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    stopDrag?.();
    const bounds = group!.getBoundingClientRect();
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId || !bounds.height) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const fromTop = (event.clientY - bounds.top) / bounds.height * 100;
      resize(placement === 'above' ? 100 - fromTop : fromTop);
    };
    const pointerId = event.pointerId;
    const finish = (event: PointerEvent) => { if (event.pointerId === pointerId) { stopDrag?.(); saveSize(); } };
    view?.addEventListener('pointermove', move, true);
    view?.addEventListener('pointerup', finish, true);
    view?.addEventListener('pointercancel', finish, true);
    stopDrag = () => {
      view?.removeEventListener('pointermove', move, true);
      view?.removeEventListener('pointerup', finish, true);
      view?.removeEventListener('pointercancel', finish, true);
      stopDrag = null;
    };
  }
  function keyDown(event: KeyboardEvent) {
    if (placement === 'right') return;
    if (chrome.keyDown(event)) return;
    if (!(event.target instanceof Element) || !handle.contains(event.target)) return;
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const delta = (event.key === 'ArrowUp' ? -5 : 5) * (placement === 'above' ? -1 : 1);
    resize(event.key === 'Home' ? 20 : event.key === 'End' ? 80 : share + delta);
    saveSize();
  }
  // BB's native horizontal resizer captures at document level. Intercept only
  // this vertical handle at window capture, before that native listener.
  const view = surface.ownerDocument.defaultView;
  view?.addEventListener('pointerdown', pointerDown, true);
  view?.addEventListener('keydown', keyDown, true);
  return {
    isCurrent: () => surface.closest('[data-panel-group]') === group,
    apply(next: WindowPlacement, open: boolean, headers: PaneHeaders = defaultPaneHeaders) {
      stopDrag?.(); placement = next;
      group.dataset.kanbanWindowPlacement = next;
      group.dataset.kanbanPanelOpen = String(open);
      chrome.apply(next, open, headers);
      if (next === 'right') restoreHandle();
      else {
        resize(share);
        handle.setAttribute('aria-label', 'Изменить высоту канбана и открытого окна');
        handle.setAttribute('aria-orientation', 'horizontal');
        handle.setAttribute('tabindex', '0');
        handle.setAttribute('aria-valuemin', '20'); handle.setAttribute('aria-valuemax', '80');
      }
    },
    dispose() {
      stopDrag?.();
      view?.removeEventListener('pointerdown', pointerDown, true);
      view?.removeEventListener('keydown', keyDown, true);
      restoreHandle();
      chrome.dispose();
      delete group.dataset.kanbanWindowPlacement; delete group.dataset.kanbanPanelOpen;
      group.style.removeProperty('--kb-main-share'); group.style.removeProperty('--kb-secondary-share');
    },
  };
}
