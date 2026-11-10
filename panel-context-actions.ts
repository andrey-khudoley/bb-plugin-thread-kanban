import type { ExperimentalPanelController, ExperimentalPanelTab, ExperimentalPanelTabs } from "@get-bb/plugin-sdk/app";
import { contextKey, panelContext, sectionStore, type PanelContext } from "./panel-context";
import { matchingCardTabs, type TabActivity } from "./panel-card-navigation";
import { replacementTabKey } from "./panel-tab-selection";
import { prepareKanbanPanel } from "./window-placement";

export const contextTab = { id: "context", context: { kind: "nav-panel", panelId: "board" }, availability: "action" } as const;
let contextPluginId: string | null = null;
export function setContextPluginId(id: string) { contextPluginId = id; }
export function sectionTitle() {
  let number = 1;
  try { number = Number(localStorage.getItem('thread-kanban:section-number') ?? 0) + 1;
    localStorage.setItem('thread-kanban:section-number', String(number)); } catch { number = Date.now(); }
  return `Вкладка ${number}`;
}
export function sectionId(tab: ExperimentalPanelTab | undefined): string | null {
  const detail = tab?.detail;
  if (detail?.kind !== "plugin" || !detail.params || typeof detail.params !== "object") return null;
  if (contextPluginId && detail.pluginId !== contextPluginId) return null;
  if (detail.tab.context.kind !== 'nav-panel' || detail.tab.context.panelId !== 'board') return null;
  if (detail.tab.id === 'workspace' && 'threadId' in detail.params && typeof detail.params.threadId === 'string') return `legacy-chat:${detail.params.threadId}`;
  if (detail.tab.id === 'issue' && 'issueId' in detail.params && typeof detail.params.issueId === 'string') return `legacy-issue:${detail.params.issueId}:${'openRequest' in detail.params ? detail.params.openRequest : ''}`;
  if (detail.tab.id !== contextTab.id) return null;
  return "sectionId" in detail.params && typeof detail.params.sectionId === "string" ? detail.params.sectionId : null;
}

// Only live tab keys are held here. Persisted state is addressed by our own section UUIDs.
export const fileSections = new Map<string, string>();
export const sectionGroups = new Map<string, string>();
export let focusedSection: string | null = null;
export function focusSection(id: string) { focusedSection = id; }

const activities = new WeakMap<ExperimentalPanelTabs, TabActivity>();
export function trackPanelActivity(snapshot: ExperimentalPanelTabs, activity: TabActivity) {
  activity.update(snapshot.tabs, snapshot.selectedKey);
  activities.set(snapshot, activity);
}

/** A legacy tab's original params cease to identify its card once its section was replaced. */
export function tabContext(tab: ExperimentalPanelTab): PanelContext | null {
  const id = sectionId(tab);
  if (!id) return null;
  const section = sectionStore.get(id);
  if (section.initialized) return section.context;
  const detail = tab.detail;
  if (detail.kind !== 'plugin' || !detail.params || typeof detail.params !== 'object') return null;
  const params = detail.params;
  const parsed = panelContext.safeParse(detail.tab.id === 'workspace'
    ? { kind: 'chat', threadId: 'threadId' in params ? params.threadId : null, title: tab.title }
    : detail.tab.id === 'issue' ? { kind: 'issue', issueId: 'issueId' in params ? params.issueId : null,
      title: tab.title, threadId: 'threadId' in params ? params.threadId : null,
      startWithAssistant: 'startWithAssistant' in params && params.startWithAssistant === true,
      request: 'openRequest' in params ? params.openRequest : 0 } : null);
  return parsed.success ? parsed.data : null;
}

export type CardTarget = { kind: 'issue'; issueId: string } | { kind: 'chat'; threadId: string };
/** Select only: never replace a section or increment an issue's open request. */
export function focusOpenCard(panel: ExperimentalPanelController, target: CardTarget): 'focused' | 'missing' | 'failed' {
  const key = target.kind === 'issue' ? `issue:${target.issueId}` : `chat:${target.threadId}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = panel.getTabs();
    const selected = snapshot.tabs.find((tab) => tab.key === snapshot.selectedKey);
    const selectedId = sectionId(selected);
    // Native + and the plugin's empty launcher deliberately request another instance.
    if (selected?.detail.kind === 'new-tab' || (selectedId && sectionStore.get(selectedId).initialized
      && sectionStore.get(selectedId).context === null)) return 'missing';
    const candidates = matchingCardTabs(snapshot.tabs.map((tab) => {
      const context = tabContext(tab);
      return { key: tab.key, section: sectionId(tab), cardKey: context ? contextKey(context) : null };
    }), key, snapshot.selectedKey, activities.get(snapshot));
    if (!candidates.length) return 'missing';
    const candidate = candidates[0];
    if ((snapshot.open && candidate.key === snapshot.selectedKey) || panel.selectTab(candidate.key)) {
      if (candidate.section) focusSection(candidate.section);
      return 'focused';
    }
  }
  // A still-listed tab that cannot be selected must not cause the current card to be overwritten.
  return 'failed';
}

export function createPanelTab(panel: ExperimentalPanelController) {
  prepareKanbanPanel(panel);
  const id = crypto.randomUUID();
  sectionStore.clear(id);
  const opened = panel.openTab({ tab: contextTab, params: { sectionId: id }, title: sectionTitle() });
  if (opened) focusSection(id);
  return opened;
}

export function openPanelContext(panel: ExperimentalPanelController, context: PanelContext) {
  prepareKanbanPanel(panel);
  const snapshot = panel.getTabs();
  const currentKey = replacementTabKey(snapshot.tabs.map((tab) => ({key:tab.key, contextId:sectionId(tab), kind:tab.detail.kind})),
    snapshot.selectedKey, focusedSection, fileSections, sectionGroups);
  const current = snapshot.tabs.find((tab) => tab.key === currentKey);
  const currentId = sectionId(current);
  if (current && currentId) {
    sectionStore.replace(currentId, context);
    focusSection(currentId);
    return panel.selectTab(current.key);
  }
  const id = crypto.randomUUID();
  sectionStore.replace(id, context);
  const opened = panel.openTab({ tab: contextTab, params: { sectionId: id }, title: sectionTitle() });
  if (opened) focusSection(id);
  return opened;
}
