import { useEffect, useRef, type RefObject } from "react";
import { experimental_useAppPanel, experimental_usePanelTabs, useRpc } from "@get-bb/plugin-sdk/app";
import { onKanbanPanelOpen, defaultPaneHeaders, windowPlacementContract, type PaneHeaders, type WindowPlacement } from "./window-placement";
import { createWindowPlacementLayout } from "./window-placement-layout";

export function WindowPlacementBridge({ surface }: { surface: RefObject<HTMLElement | null> }) {
  const rpc = useRpc<typeof windowPlacementContract>();
  const tabs = experimental_usePanelTabs();
  const panel = experimental_useAppPanel();
  const latest = useRef(tabs);
  const request = useRef(() => {});
  latest.current = tabs;
  useEffect(() => {
    const root = surface.current;
    if (!root) return;
    let adapter: ReturnType<typeof createWindowPlacementLayout> = null;
    let disposed = false;
    let sequence = 0;
    let saved: WindowPlacement = 'right';
    let headers: PaneHeaders = defaultPaneHeaders;
    const apply = async () => {
      const current = ++sequence;
      // Read on opening, not on settings changes. Realtime signals are scoped
      // to their publishing plugin; this also handles another device's save.
      try {
        const [value, headerValue] = await Promise.allSettled([
          rpc.call('readWindowPlacement', null),
          rpc.call('readPaneHeaders', null),
        ]);
        if (disposed || current !== sequence) return;
        if (value.status === 'fulfilled') saved = value.value;
        if (headerValue.status === 'fulfilled') headers = headerValue.value;
      } catch { /* Preserve the last usable layout if settings are unavailable. */ }
      if (disposed || current !== sequence) return;
      if (adapter && !adapter.isCurrent()) { adapter.dispose(); adapter = null; }
      adapter ??= createWindowPlacementLayout(root);
      adapter?.apply(saved, latest.current.open, headers);
    };
    request.current = () => { void apply(); };
    const unsubscribe = onKanbanPanelOpen(panel, request.current);
    request.current();
    return () => { disposed = true; request.current = () => {}; unsubscribe(); adapter?.dispose(); };
  }, [surface, panel, rpc]);
  // Covers native file links, terminal and browser tabs as well as restored tabs.
  useEffect(() => { request.current(); }, [tabs.open, tabs.selectedKey, tabs.tabs.length]);
  return null;
}
