import { createContext, useContext, useSyncExternalStore } from "react";

export const SectionContext = createContext<string | null>(null);
export function usePanelSection() { return useContext(SectionContext); }
const visible = new Set<string>();
const listeners = new Set<() => void>();
export function setSectionVisible(id: string, value: boolean) {
  if (visible.has(id) === value) return;
  if (value) visible.add(id); else visible.delete(id);
  listeners.forEach((listener) => listener());
}
export function useSectionVisible(id: string | null) {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => id !== null && visible.has(id),
  );
}
