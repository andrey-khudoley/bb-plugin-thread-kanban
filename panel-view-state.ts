import { useLayoutEffect, useRef, useSyncExternalStore, type Dispatch, type SetStateAction, type RefObject } from 'react';
import { usePanelSection } from './panel-section-ui';

type Cell<T> = { value: T; listeners: Set<() => void> };
const sections = new Map<string, Map<string, Cell<unknown>>>();

/** Explicit navigation can reveal a view in an already mounted or restored section. */
export function setPanelState(section: string, key: string, value: unknown) {
  const cell = sections.get(section)?.get(key);
  if (!cell || Object.is(cell.value, value)) return;
  cell.value = value;
  cell.listeners.forEach(listener => listener());
}

/** Preserve presentation state across native tab unmounts; data drafts have their own stores. */
export function usePanelState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const section = usePanelSection();
  const own = useRef(new Map<string, Cell<unknown>>());
  let cells = section ? sections.get(section) : own.current;
  if (!cells) { cells = new Map(); sections.set(section!, cells); }
  let cell = cells.get(key) as Cell<T> | undefined;
  if (!cell) {
    cell = { value: typeof initial === 'function' ? (initial as () => T)() : initial, listeners: new Set() };
    cells.set(key, cell as Cell<unknown>);
  }
  const current = cell;
  const value = useSyncExternalStore((listener) => {
    current.listeners.add(listener); return () => { current.listeners.delete(listener); };
  }, () => current.value);
  return [value, (change) => {
    const next = typeof change === 'function' ? (change as (value: T) => T)(current.value) : change;
    if (Object.is(current.value, next)) return;
    current.value = next;
    current.listeners.forEach((listener) => listener());
  }];
}

export function forgetPanelState(section: string) {
  sections.delete(section);
  for (const key of scrolls.keys()) if (key.startsWith(`${section}:`)) scrolls.delete(key);
}

type ScrollEntry = { top: number; left: number };
const scrolls = new Map<string, Map<string, ScrollEntry>>();
/** Only the plugin's own scroll containers are restored; BB owns chat/editor scroll recovery. */
export function rememberPanelScroll(key: string, path: string, element: Element) {
  const saved = scrolls.get(key) ?? new Map<string, ScrollEntry>();
  saved.set(path, { top: element.scrollTop, left: element.scrollLeft }); scrolls.set(key, saved);
}
export function restorePanelScroll(key: string, path: string, element: Element) {
  const saved = scrolls.get(key)?.get(path);
  if (saved) { element.scrollTop = saved.top; element.scrollLeft = saved.left; }
  return !saved || (Math.abs(element.scrollTop - saved.top) < 1 && Math.abs(element.scrollLeft - saved.left) < 1);
}

export function usePanelScroll(surface: RefObject<HTMLElement | null>, key: string | null) {
  useLayoutEffect(() => {
    const root = surface.current;
    if (!root || !key) return;
    const restored = new WeakSet<Element>();
    const containers = () => Array.from(root.querySelectorAll<HTMLElement>('[data-kanban-scroll]'));
    const restore = () => {
      for (const element of containers()) if (!restored.has(element)) {
        if (restorePanelScroll(key, element.dataset.kanbanScroll!, element)) restored.add(element);
      }
    };
    const save = (event: Event) => {
      const element = event.target;
      if (element instanceof HTMLElement && element.dataset.kanbanScroll && restored.has(element))
        rememberPanelScroll(key, element.dataset.kanbanScroll, element);
    };
    // A loading view may not yet have enough content to restore its old offset.
    // Retry on content changes until restored, but always give a user's new scroll priority.
    const interact = () => { for (const element of containers()) restored.add(element); };
    restore();
    const observer = new MutationObserver(restore);
    observer.observe(root, { childList: true, subtree: true });
    root.addEventListener('scroll', save, true);
    for (const event of ['wheel', 'pointerdown', 'keydown']) root.addEventListener(event, interact, true);
    return () => {
      observer.disconnect(); root.removeEventListener('scroll', save, true);
      for (const event of ['wheel', 'pointerdown', 'keydown']) root.removeEventListener(event, interact, true);
      for (const element of containers()) if (restored.has(element)) rememberPanelScroll(key, element.dataset.kanbanScroll!, element);
    };
  }, [surface, key]);
}
