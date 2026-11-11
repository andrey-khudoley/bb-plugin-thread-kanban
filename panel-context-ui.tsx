import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { experimental_useAppPanel, experimental_usePanelTabs, type ReadonlyJsonValue } from "@get-bb/plugin-sdk/app";
import { contextKey, contextThreadId, sectionStore } from "./panel-context";
import { forgetPanelState, usePanelScroll } from "./panel-view-state";
import { fileSections, focusSection, focusedSection, sectionGroups, sectionId, trackPanelActivity } from "./panel-context-actions";
import { createTabActivity } from "./panel-card-navigation";
import { WorkspaceTab } from "./workspace";
import { IssuePanel } from "./issue-panel";
import { SectionContext, setSectionVisible } from "./panel-section-ui";
import { nativeTabCandidates, nativeTabGroup, resolveMountedTab, resolveNativeTab } from "./panel-native-tabs";
import { openChatStore } from "./open-chats";
import { createTabLabels } from "./panel-tab-labels";
import { useAgentView } from "./agent-ui";
import { registerStatusPanel } from "./status-navigation";
import { ArtifactChrome, type ArtifactGroup } from './artifact-tabs';
import { artifactStore, artifactOwner, nativeArtifactOwners } from './panel-artifacts';
import { BrowserArtifactContent, useBrowserArtifacts } from './browser-artifacts';
import type { Issue } from './issues';

export function ContextPanel({ params }: { params: ReadonlyJsonValue | null }) {
  const id = params && typeof params === "object" && "sectionId" in params && typeof params.sectionId === "string" ? params.sectionId : null;
  const surface = useRef<HTMLDivElement>(null);
  useSyncExternalStore(sectionStore.subscribe, sectionStore.getSnapshot, sectionStore.getSnapshot);
  const context = id ? sectionStore.get(id).context : null;
  useSyncExternalStore(artifactStore.subscribe, artifactStore.getSnapshot, artifactStore.getSnapshot);
  const browsers = useBrowserArtifacts(context?.threadId ?? null);
  const selectedArtifact = id && context ? artifactStore.get(artifactOwner(id, contextKey(context))) : null;
  const browser = browsers.tabs.find(tab => tab.key === selectedArtifact);
  useAgentView(surface, () => ({ artifactContext: { section: id, selected: selectedArtifact,
    browsers: browsers.tabs.map(tab => ({ id: tab.tabId, title: tab.title.slice(0, 300) })),
    browserDiscoveryReady: browsers.ready, browserDiscoveryError: browsers.error,
    viewport: (() => {
      const element = surface.current?.querySelector<HTMLElement>('.kb-browser-viewport');
      return element ? { attached: element.dataset.browserAttached === 'true', visible: element.dataset.browserVisible === 'true',
        page: element.dataset.browserPage?.slice(0, 1000) ?? null } : null;
    })(),
  } }));
  usePanelScroll(surface, id && context ? `${id}:${contextKey(context)}:${context.view ?? 'chat'}` : null);
  if (!id) return <p className="p-3 text-sm">Выбери чат или карточку на канбане.</p>;
  return <SectionContext.Provider value={id}>
    <div ref={surface} className="kb-context flex h-full min-h-0 flex-col" data-kanban-section={id}
      onPointerDownCapture={() => focusSection(id)} onFocusCapture={() => focusSection(id)}>
      <div className="flex min-h-0 flex-1 flex-col" hidden={!!browser} style={browser ? { display: 'none' } : undefined}>
        {context?.kind === "chat" ? <WorkspaceTab params={{ threadId: context.threadId }} />
          : context?.kind === "issue" ? <IssuePanel params={{ issueId: context.issueId, threadId: context.threadId,
            startWithAssistant: context.startWithAssistant, openRequest: context.request, view: context.view ?? null }} />
          : <p className="p-3 text-sm text-muted-foreground">Выбери карточку на канбане — она откроется в этой вкладке.</p>}
      </div>
      {browser && <BrowserArtifactContent key={browser.key} tab={browser} />}
    </div>
  </SectionContext.Provider>;
}

export function LegacyWorkspacePanel({ params }: { params: ReadonlyJsonValue | null }) {
  const input = params && typeof params === 'object' && 'threadId' in params ? params : null;
  const threadId = typeof input?.threadId === 'string' ? input.threadId : null;
  useEffect(() => {
    if (!threadId) return;
    const id = `legacy-chat:${threadId}`;
    if (!sectionStore.get(id).initialized) sectionStore.replace(id, {kind:'chat', threadId, title: 'Чат'});
  }, [threadId]);
  if (typeof input?.threadId !== 'string') return <WorkspaceTab params={params} />;
  const id = `legacy-chat:${input.threadId}`;
  return <ContextPanel params={{sectionId:id}} />;
}
export function LegacyIssuePanel({ params }: { params: ReadonlyJsonValue | null }) {
  const input = params && typeof params === 'object' && 'issueId' in params ? params : null;
  useEffect(() => {
    if (typeof input?.issueId !== 'string') return;
    const id = `legacy-issue:${input.issueId}:${'openRequest' in input ? input.openRequest : ''}`;
    if (!sectionStore.get(id).initialized) sectionStore.replace(id, {kind:'issue', issueId: input.issueId, title:'Карточка',
      threadId: 'threadId' in input && typeof input.threadId === 'string' ? input.threadId : null,
      startWithAssistant: 'startWithAssistant' in input && input.startWithAssistant === true,
      request: 'openRequest' in input && typeof input.openRequest === 'number' ? input.openRequest : 0});
  }, [input]);
  if (typeof input?.issueId !== 'string') return <IssuePanel params={params} />;
  const id = `legacy-issue:${input.issueId}:${'openRequest' in input ? input.openRequest : ''}`;
  return <ContextPanel params={{sectionId:id}} />;
}

/**
 * Cosmetic adapter for native tab chrome, not a replacement for BB's layout/editor store.
 * The SDK exposes tabs, but no pane API. Use the mounted body for selected tabs
 * and unambiguous native labels for the rest. Leave unknown native controls intact.
 */
const noIssues: Issue[] = [];
export function PanelContextBridge({ surface, issues = noIssues }: { surface: RefObject<HTMLElement | null>; issues?: Issue[] }) {
  const controller = experimental_useAppPanel();
  useEffect(() => {
    if (surface.current) return registerStatusPanel(surface.current, controller, issues);
  }, [surface, controller, issues]);
  const snapshot = experimental_usePanelTabs();
  const [artifactGroups, setArtifactGroups] = useState<ArtifactGroup[]>([]);
  const activity = useRef(createTabActivity());
  const previousSections = useRef(new Set<string>());
  useLayoutEffect(() => {
    trackPanelActivity(snapshot, activity.current);
    const live = new Set(snapshot.tabs.flatMap((tab) => { const id = sectionId(tab); return id ? [id] : []; }));
    for (const id of previousSections.current) if (!live.has(id)) forgetPanelState(id);
    previousSections.current = live;
  }, [snapshot]);
  useSyncExternalStore(sectionStore.subscribe, sectionStore.getSnapshot, sectionStore.getSnapshot);
  useAgentView(surface, () => ({
    panelAdapter: surface.current?.dataset.kanbanPanelAdapter ?? null,
    panelTabs: snapshot.tabs.slice(0, 50).map((tab) => ({ key: tab.key, title: tab.title.slice(0, 300),
      section: sectionId(tab), context: sectionId(tab) ? sectionStore.get(sectionId(tab)!).context : null,
      artifactOwner: nativeArtifactOwners.get(tab.key) ?? null })),
    nativeTabs: Array.from(document.querySelectorAll<HTMLElement>('[data-tab-pill]')).slice(0, 50).map((pill) => ({
      title: pill.querySelector('button[aria-pressed]')?.textContent?.slice(0, 300) ?? null,
      section: pill.dataset.kbSection ?? null, selected: pill.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed') ?? null,
      grouped: nativeTabGroup(pill) !== null, visible: pill.getClientRects().length > 0,
      artifact: pill.dataset.kbArtifactNative === 'true',
    })),
  }));
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const requestUpdate = useRef(() => {});
  useEffect(() => {
    let disposed = false;
    let frame = 0;
    const marked = new Set<HTMLElement>();
    const labels = createTabLabels();
    const previousFiles = new Map<string, { section: string; path: string }>();
    const activeHomes = new WeakMap<Element, string>();
    const mounts = new Map<Element, HTMLElement>();
    const nativeOwners = nativeArtifactOwners;
    let previousNativeKeys = new Set<string>();
    const restoredKeys = new Set(latest.current.tabs.map(tab => tab.key));
    const visibleSections = new Set<string>();
    const openSections = new Map<string, { threadId: string; close: () => void }>();
    const clearOpenSections = () => {
      visibleSections.forEach((id) => setSectionVisible(id, false)); visibleSections.clear();
      openSections.forEach((lease) => lease.close()); openSections.clear();
    };
    const update = () => {
      frame = 0;
      if (disposed) return;
      const snapshot = latest.current;
      const root = surface.current;
      if (!root) { labels.clear(); clearOpenSections(); return; }
      root.dataset.kanbanPanelAdapter = `tabs:${snapshot.tabs.length}`;
      // The board's native surface owns its side panel. Do not decorate another split route.
      let hostSurface: Element | null = root;
      while (hostSurface && !hostSurface.querySelector('[data-tab-pill]')) hostSurface = hostSurface.parentElement;
      if (!hostSurface) { labels.clear(); clearOpenSections(); return; }
      const pills = Array.from(hostSurface.querySelectorAll<HTMLElement>('[data-tab-pill]'));
      const nativeKeys = new Set(snapshot.tabs.filter(tab => !sectionId(tab)).map(tab => tab.key));
      for (const key of previousNativeKeys) if (!nativeKeys.has(key)) nativeOwners.delete(key);
      previousNativeKeys = nativeKeys;
      for (const element of marked) { element.removeAttribute('data-kb-card-tab'); element.removeAttribute('data-kb-file-parked'); element.removeAttribute('data-kb-section'); element.removeAttribute('data-kb-artifact-native'); element.removeAttribute('data-kb-active-home'); }
      marked.clear();
      labels.retain(new Set(pills));
      sectionGroups.clear();
      for (const tab of snapshot.tabs) { const id = sectionId(tab); if (id) sectionStore.get(id); }
      const groups = new Map<Element, { tab: typeof snapshot.tabs[number]; pill: HTMLElement | null }[]>();
      const artifactPills = new Map<Element, Set<HTMLElement>>();
      const records = pills.map(pill => {
        const caption = pill.querySelector('button[aria-pressed]')?.textContent?.trim();
        return { pill, group: nativeTabGroup(pill), caption, candidates: nativeTabCandidates(snapshot.tabs, caption) };
      });
      for (const {pill, group, caption, candidates} of records) {
        if (!group) continue;
        const nativeTab = labels.resolve(pill, snapshot.tabs, () =>
          resolveNativeTab(snapshot.tabs, caption))
          // A browser/editor can retain the previous card body. In particular,
          // duplicate artifact captions must never be resolved as that card.
          ?? (candidates.every(tab => sectionId(tab)) ? resolveMountedTab(pill, snapshot.tabs, sectionId) : null);
        const tabs = groups.get(group) ?? [];
        if (nativeTab) {
          if (!tabs.some(entry => entry.tab.key === nativeTab.key)) tabs.push({ tab: nativeTab, pill });
          groups.set(group, tabs);
          continue;
        }
        if (!candidates.length || candidates.some(tab => sectionId(tab))) continue;
        const matching = records.filter(record => record.candidates.some(tab => candidates.some(candidate => candidate.key === tab.key)));
        // Hiding a group of equal native pills needs no guessed one-to-one DOM
        // identity. The second row selects/closes the actual SDK keys instead.
        // Do not guess which pane owns equal captions spread across split panes.
        if (matching.some(record => record.group !== group)) continue;
        candidates.forEach(tab => { if (!tabs.some(entry => entry.tab.key === tab.key)) tabs.push({ tab, pill: null }); });
        groups.set(group, tabs);
        const hidden = artifactPills.get(group) ?? new Set<HTMLElement>();
        matching.forEach(record => hidden.add(record.pill)); artifactPills.set(group, hidden);
      }
      const liveFiles = new Set(snapshot.tabs.filter((t) => t.detail.kind === 'file').map((t) => t.key));
      for (const [key, file] of previousFiles) if (!liveFiles.has(key)) {
        sectionStore.forget(file.section, file.path); previousFiles.delete(key); fileSections.delete(key);
      }
      const nextVisible = new Set<string>();
      const nextArtifactGroups: ArtifactGroup[] = [];
      for (const [group, entries] of groups) {
        const homes = entries.filter((entry): entry is typeof entry & {pill: HTMLElement} => !!sectionId(entry.tab) && !!entry.pill);
        const selected = entries.find(({tab}) => tab.key === snapshot.selectedKey)?.tab
          ?? entries.find(({pill}) => pill?.querySelector('button[aria-pressed="true"]'))?.tab;
        const home = homes.find(({tab}) => tab.key === selected?.key)
          ?? homes.find(({tab}) => sectionId(tab) === nativeOwners.get(selected?.key ?? '')?.section)
          ?? homes.find(({tab}) => sectionId(tab) === focusedSection)
          ?? homes.find(({tab}) => sectionId(tab) === activeHomes.get(group))
          ?? homes.find(({tab}) => selected?.detail.kind === 'file' && sectionStore.hasFile(sectionId(tab)!, selected.detail.path)) ?? homes[0];
        const id = home && sectionId(home.tab);
        if (!home || !id) continue;
        activeHomes.set(group, id);
        const context = sectionStore.get(id).context;
        const card = context ? contextKey(context) : 'empty';
        if (snapshot.open && root.getClientRects().length > 0) homes.forEach(({tab}) => nextVisible.add(sectionId(tab)!));
        // Restored artifacts sit next to their original main tab. New ones belong
        // to the currently focused card, even when BB appends them at the end.
        const neighbors = new Map<string, string>();
        let neighbor = sectionId(homes[0]?.tab) ?? id;
        for (const {tab} of entries) {
          neighbor = sectionId(tab) ?? neighbor;
          neighbors.set(tab.key, neighbor);
        }
        for (const {tab, pill} of entries) if (pill) { pill.dataset.kbSection = sectionId(tab) ?? id; marked.add(pill); }
        for (const {tab, pill} of homes) {
          pill.setAttribute('data-kb-card-tab', 'true'); marked.add(pill);
          labels.show(pill, tab, sectionStore.get(sectionId(tab)!).context?.title ?? 'Новая вкладка');
        }
        for (const {tab, pill} of entries) {
          if (tab.detail.kind !== 'file') continue;
          const path = tab.detail.path;
          const previous = previousFiles.get(tab.key);
          // Ownership follows the card, including when its tab moves to another native pane.
          const owner = homes.map(({tab}) => sectionId(tab)!).find(section => sectionStore.hasFile(section, path))
            ?? previous?.section ?? (restoredKeys.has(tab.key) ? neighbors.get(tab.key) : id) ?? id;
          if (!previous && !sectionStore.isKnownFile(path)) sectionStore.remember(owner, path);
          previousFiles.set(tab.key, previous ?? {section: owner, path}); fileSections.set(tab.key, owner);
          if (pill && !sectionStore.hasFile(id, path)) { pill.setAttribute('data-kb-file-parked', 'true'); marked.add(pill); }
        }
        const native: typeof snapshot.tabs[number][] = [];
        for (const { tab, pill } of entries) {
          if (sectionId(tab) || tab.detail.kind === 'new-tab' || tab.detail.kind === 'info') continue;
          if (tab.detail.kind === 'file') {
            if (sectionStore.hasFile(id, tab.detail.path)) native.push(tab);
            else if (!sectionStore.isKnownFile(tab.detail.path)) continue;
          } else {
            if (!nativeOwners.has(tab.key)) {
              const section = (restoredKeys.has(tab.key) ? neighbors.get(tab.key) : id) ?? id;
              const ownerContext = sectionStore.get(section).context;
              nativeOwners.set(tab.key, { section, card: ownerContext ? contextKey(ownerContext) : 'empty' });
            }
            const owner = nativeOwners.get(tab.key)!;
            if (owner.section === id && owner.card === card) native.push(tab);
          }
          if (pill) { pill.dataset.kbArtifactNative = 'true'; marked.add(pill); }
        }
        for (const pill of artifactPills.get(group) ?? []) { pill.dataset.kbArtifactNative = 'true'; marked.add(pill); }
        for (const {tab, pill} of entries) {
          const owner = sectionId(tab) ?? fileSections.get(tab.key) ?? nativeOwners.get(tab.key)?.section ?? id;
          sectionGroups.set(tab.key, owner); if (pill) pill.dataset.kbSection = owner;
        }
        if (selected && !sectionId(selected)) { home.pill.dataset.kbActiveHome = 'true'; marked.add(home.pill); }
        let mount = mounts.get(group);
        if (!mount || !mount.isConnected) {
          // Append only plugin-owned DOM. The native strip and editor roots never move.
          const chrome = group.closest('[data-testid="thread-secondary-panel-top-chrome"]') ?? group;
          mount = document.createElement('div'); mount.className = 'kb-artifact-mount';
          chrome.insertAdjacentElement('afterend', mount); mounts.set(group, mount);
        }
        nextArtifactGroups.push({ section: id, owner: artifactOwner(id, card), mainKey: home.tab.key, mount, native, selectedKey: selected?.key ?? null });
      }
      for (const [group, mount] of mounts) if (!groups.has(group)) { mount.remove(); mounts.delete(group); }
      setArtifactGroups(previous => {
        const signature = (values: ArtifactGroup[]) => values.map(value => [value.section, value.owner, value.mainKey, value.selectedKey,
          value.native.map(tab => [tab.key, tab.title, tab.status, tab.detail])]);
        return previous.length === nextArtifactGroups.length && previous.every((value, index) => value.mount === nextArtifactGroups[index].mount)
          && JSON.stringify(signature(previous)) === JSON.stringify(signature(nextArtifactGroups)) ? previous : nextArtifactGroups;
      });
      root.dataset.kanbanPanelAdapter = `ready:${groups.size},tabs:${nextVisible.size}`;
      for (const id of visibleSections) if (!nextVisible.has(id)) setSectionVisible(id, false);
      for (const id of nextVisible) setSectionVisible(id, true);
      visibleSections.clear(); nextVisible.forEach((id) => visibleSections.add(id));
      // Native file selection can unmount the plugin tab body. The section still owns its chat.
      for (const [id, lease] of openSections) {
        const context = sectionStore.get(id).context;
        const threadId = contextThreadId(context);
        if (!nextVisible.has(id) || lease.threadId !== threadId) { lease.close(); openSections.delete(id); }
      }
      for (const id of nextVisible) {
        const context = sectionStore.get(id).context;
        const threadId = contextThreadId(context);
        if (threadId && !openSections.has(id)) openSections.set(id, {threadId, close: openChatStore.open(threadId)});
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const onPointer = (event: Event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-kb-section],[data-kanban-section]') : null;
      const id = target?.dataset.kbSection ?? target?.dataset.kanbanSection;
      if (id) focusSection(id);
      schedule();
    };
    requestUpdate.current = schedule;
    const unsubscribe = sectionStore.subscribe(schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('focusin', onPointer, true);
    schedule();
    return () => { disposed = true; requestUpdate.current = () => {}; observer.disconnect(); unsubscribe(); cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('focusin', onPointer, true);
      clearOpenSections();
      labels.clear();
      mounts.forEach(mount => mount.remove());
      for (const element of marked) { element.removeAttribute('data-kb-card-tab'); element.removeAttribute('data-kb-file-parked'); element.removeAttribute('data-kb-section'); element.removeAttribute('data-kb-artifact-native'); element.removeAttribute('data-kb-active-home'); }
    };
  }, [surface]);
  useEffect(() => { requestUpdate.current(); }, [snapshot]);
  return <ArtifactChrome groups={artifactGroups} />;
}

export function mountPanelStyles() {
  const style = document.createElement('style');
  style.textContent = `
    [data-kb-file-parked="true"] { display: none !important; }
  `;
  document.head.append(style);
  return () => style.remove();
}
