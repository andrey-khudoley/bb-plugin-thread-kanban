import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const key = "thread-kanban:list-context";
type Context = { projects: Record<string, boolean>; positions: Record<string, number> };
function read(): Context {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "{}");
    return {
      projects: Object.fromEntries(Object.entries(value.projects ?? {}).filter(([, value]) => typeof value === "boolean")) as Context["projects"],
      positions: Object.fromEntries(Object.entries(value.positions ?? {}).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0)) as Context["positions"],
    };
  } catch { return { projects: {}, positions: {} }; }
}

/** Keep independent positions for each mode/filter, including tree round trips. */
export function useListViewContext({ ready, ...view }: { ready: boolean; [field: string]: string | boolean }) {
  const [initial] = useState(read);
  const [projectExpansion, setProjectExpansion] = useState<ReadonlyMap<string, boolean>>(new Map(Object.entries(initial.projects)));
  const positions = useRef(initial.positions);
  const element = useRef<HTMLDivElement | null>(null);
  const context = JSON.stringify(view);
  const current = useRef(context);
  current.current = context;
  const persist = useCallback(() => {
    try { sessionStorage.setItem(key, JSON.stringify({ projects: Object.fromEntries(projectExpansion), positions: positions.current })); }
    catch { /* Private browsing or full storage must not block navigation. */ }
  }, [projectExpansion]);
  const saveScroll = useCallback(() => {
    if (!element.current) return;
    positions.current[current.current] = element.current.scrollTop;
    positions.current = Object.fromEntries(Object.entries(positions.current).slice(-40));
    persist();
  }, [persist]);
  const scrollRef = useCallback((node: HTMLDivElement | null) => {
    element.current = node;
    if (node) node.scrollTop = positions.current[current.current] ?? 0;
  }, []);
  useLayoutEffect(() => {
    if (ready && element.current) element.current.scrollTop = positions.current[context] ?? 0;
  }, [context, ready]);
  useEffect(persist, [persist]);
  return { projectExpansion, setProjectExpansion, scrollRef, saveScroll };
}
