import { useEffect, useRef, type RefObject } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { agentChannel, agentRpc, uiReport, type UiReport } from "./agent-contract";
import { usePortalScopeProps } from "./lib/portal-scope";

type State = UiReport["state"];
const views = new Map<HTMLElement, () => State>();
let generation = 0;
export function setAgentGeneration(value: number) { generation = value; }

export function useAgentView(surface: RefObject<HTMLElement | null>, read: () => State) {
  const current = useRef(read);
  current.current = read;
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    views.set(element, () => current.current());
    return () => { views.delete(element); };
  }, [surface]);
}

function shown(element: Element) {
  return element.getClientRects().length > 0 && !element.closest('[hidden], [aria-hidden="true"]');
}
function shortText(element: Element, limit = 200) {
  return (element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.textContent ?? "")
    .replace(/\s+/g, " ").trim().slice(0, limit);
}
function inViewport(element: Element) {
  const rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
  let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const clip = parent.getBoundingClientRect();
    if (/(hidden|clip|scroll|auto)/.test(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
    if (/(hidden|clip|scroll|auto)/.test(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
  }
  return right > left && bottom > top;
}

/** Reads the mounted DOM. It deliberately does not synthesize visibility from server data. */
export function collectAgentUi(pluginId: string, windowId: string, requestId: string | null, errors: string[]): UiReport {
  const roots = Array.from(document.querySelectorAll(`[data-bb-plugin="${CSS.escape(pluginId)}"]`));
  const elements = (selector: string) => [...new Set(roots.flatMap((root) => [
    ...(root.matches(selector) ? [root] : []), ...Array.from(root.querySelectorAll(selector)),
  ]))].filter(shown);
  const cards = elements("[data-kanban-card-id]").map((element) => {
    const rect = element.getBoundingClientRect();
    return { id: element.getAttribute("data-kanban-card-id")!, kind: element.getAttribute("data-kanban-kind") ?? "issue",
      projectId: element.getAttribute("data-kanban-project") ?? "", stage: element.getAttribute("data-kanban-stage") ?? "",
      title: (element.querySelector(".kb-card-title")?.textContent ?? element.getAttribute("data-kanban-title") ?? "").trim().slice(0, 300),
      inViewport: inViewport(element), chatOpen: element.getAttribute("data-chat-open") === "true",
      chatActive: element.getAttribute("data-chat-active") === "true",
      cardActive: element.getAttribute("data-card-active") === "true",
      x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const controls = elements('button, [role="button"], [role="tab"], input:not([type="password"]), select, [role="menuitem"], [role="checkbox"]').map((element) => ({
    role: element.getAttribute("role") ?? element.tagName.toLowerCase(), name: shortText(element),
    disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true",
    expanded: element.getAttribute("aria-expanded"), selected: element.getAttribute("aria-selected") ?? element.getAttribute("aria-checked"),
  }));
  const overlays = elements('[role="dialog"], [role="menu"], [role="alertdialog"]').map((element) => ({
    role: element.getAttribute("role")!, text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 3000),
  }));
  const panels = elements("[data-kanban-panel]").map((element) => ({ kind: element.getAttribute("data-kanban-panel")!,
    id: element.getAttribute("data-kanban-id") ?? "", tab: element.getAttribute("data-kanban-tab") ?? "" }));
  const state = [...views].filter(([element]) => element.isConnected && shown(element)).map(([, read]) => read());
  const appBounds = document.querySelector('[data-testid="app-layout-root"]')?.getBoundingClientRect();
  const bars = elements('[data-kanban-status-bar]').map((bar) => bar.getBoundingClientRect());
  state.push({ statusShell: {
    enabled: document.documentElement.hasAttribute('data-kanban-status-shell'), bars: bars.length,
    appBottom: appBounds?.bottom ?? null, barTop: bars[0]?.top ?? null,
    overlap: appBounds && bars.length ? Math.max(0, appBounds.bottom - Math.min(...bars.map((bar) => bar.top))) : null,
  } });
  const observer = new URL(location.href).searchParams.get("kanban-observer");
  return uiReport.parse({ pluginId, windowId, observerId: observer && /^[a-f\d-]{36}$/i.test(observer) ? observer : null,
    requestId, capturedAt: Date.now(), generation, route: location.pathname.slice(0, 1000),
    documentVisible: document.visibilityState === "visible", mounted: state.length > 0 || panels.length > 0,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, state,
    cards: cards.slice(0, 500), controls: controls.slice(0, 300), overlays: overlays.slice(0, 12), panels: panels.slice(0, 20),
    errors: [...errors, ...elements('[role="alert"]').map((element) => shortText(element, 2000))].slice(-20),
    truncated: cards.length > 500 || controls.length > 300 || overlays.length > 12 || panels.length > 20 });
}

export function KanbanAgentBridge() {
  const rpc = useRpc<typeof agentRpc>();
  const scope = usePortalScopeProps();
  const pluginId = scope["data-bb-plugin"];
  const windowId = useRef(crypto.randomUUID());
  const errors = useRef<string[]>([]);
  const report = useRef<(requestId?: string) => void>(() => {});
  useRealtime(agentChannel, (payload) => {
    if (!payload || typeof payload !== "object" || !("requestId" in payload) || typeof payload.requestId !== "string") return;
    if ("windowId" in payload && payload.windowId && payload.windowId !== windowId.current) return;
    report.current(payload.requestId);
  });
  useEffect(() => {
    if (!pluginId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let queued = false;
    const send = async (requestId?: string) => {
      if (disposed) return;
      if (!requestId && inFlight) { queued = true; return; }
      if (!requestId) inFlight = true;
      try { await rpc.call("agentUiReport", collectAgentUi(pluginId, windowId.current, requestId ?? null, errors.current)); }
      catch { /* A reload/offline server must not disrupt the user's board. */ }
      finally {
        if (!requestId) { inFlight = false; if (queued && !disposed) { queued = false; schedule(); } }
      }
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { void send(); }, 250); };
    report.current = (requestId) => { void send(requestId); };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["data-state", "data-kanban-layout", "data-chat-open", "data-chat-active", "data-card-active", "aria-expanded", "aria-selected", "hidden"] });
    const onError = (event: ErrorEvent) => { errors.current = [...errors.current, event.message.slice(0, 2000)].slice(-20); schedule(); };
    const onRejection = (event: PromiseRejectionEvent) => {
      errors.current = [...errors.current, String(event.reason instanceof Error ? event.reason.message : event.reason).slice(0, 2000)].slice(-20); schedule();
    };
    window.addEventListener("error", onError); window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("resize", schedule); document.addEventListener("visibilitychange", schedule);
    const heartbeat = setInterval(() => { void send(); }, 4000);
    void send();
    return () => {
      disposed = true; report.current = () => {}; observer.disconnect(); clearInterval(heartbeat); clearTimeout(timer);
      window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("resize", schedule); document.removeEventListener("visibilitychange", schedule);
      void rpc.call("agentUiGone", { windowId: windowId.current }).catch(() => {});
    };
  }, [pluginId, rpc]);
  return null;
}
