import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { experimental_useAppPanel, useSdk, type ExperimentalPanelTab } from '@get-bb/plugin-sdk/app';
import { artifactOwner, artifactStore, afterArtifactClose } from './panel-artifacts';
import { contextKey, sectionStore } from './panel-context';
import { focusSection } from './panel-context-actions';
import { browserLabel, useBrowserArtifacts, type BrowserArtifact } from './browser-artifacts';
import { usePortalScopeProps } from './lib/portal-scope';
import { Icon } from './components/ui/icon';
import { toast } from 'sonner';

export type ArtifactGroup = { section: string; owner: string; mainKey: string; mount: HTMLElement; native: readonly ExperimentalPanelTab[]; selectedKey: string | null };
const noNativeTabs: readonly ExperimentalPanelTab[] = [];
export type ArtifactItem = { key: string; title: string; description: string; type: string; icon: string; closable: boolean; browser?: BrowserArtifact; native?: ExperimentalPanelTab };
export function nativeArtifact(tab: ExperimentalPanelTab): ArtifactItem {
  const kind = tab.detail.kind;
  const type = kind === 'file' ? 'Файл' : kind === 'browser' ? 'Браузер' : kind === 'terminal' ? 'Терминал' : 'Артефакт';
  const description = kind === 'file' ? tab.detail.path : kind === 'browser' ? tab.detail.url : tab.title;
  return { key: `native:${tab.key}`, title: tab.title || description, description, type,
    icon: kind === 'file' ? 'FileText' : kind === 'browser' ? 'Globe' : kind === 'terminal' ? 'Terminal' : 'PanelsTopLeft', closable: tab.closable, native: tab };
}
export function ArtifactChrome({ groups }: { groups: readonly ArtifactGroup[] }) {
  return groups.map(group => createPortal(<ArtifactGroupTabs group={group} />, group.mount, group.owner));
}
function ArtifactGroupTabs({ group }: { group: ArtifactGroup }) {
  const panel = experimental_useAppPanel();
  const sdk = useSdk();
  const scope = usePortalScopeProps();
  useSyncExternalStore(sectionStore.subscribe, sectionStore.getSnapshot, sectionStore.getSnapshot);
  useSyncExternalStore(artifactStore.subscribe, artifactStore.getSnapshot, artifactStore.getSnapshot);
  const context = sectionStore.get(group.section).context;
  const threadId = context?.threadId ?? null;
  const owner = artifactOwner(group.section, context ? contextKey(context) : 'empty');
  // Section updates are synchronous; the native chrome adapter updates on the
  // next frame. Never render/adopt the previous card's snapshot in that gap.
  const matchesOwner = group.owner === owner;
  const native = matchesOwner ? group.native : noNativeTabs;
  const browsers = useBrowserArtifacts(threadId);
  const allItems: ArtifactItem[] = matchesOwner ? [...native.map(nativeArtifact), ...browsers.tabs.map(browser => ({
    key: browser.key, title: browsers.tabs.filter(tab => tab.title === browser.title).length > 1
      ? `${browser.title} · ${browserLabel(browser.url)}` : browser.title,
    description: browser.url, type: 'Браузер', icon: 'Globe', closable: true, browser,
  }))] : [];
  const items = allItems.map(item => {
    const duplicates = allItems.filter(other => other.type === item.type && other.title === item.title);
    return duplicates.length > 1 ? { ...item, title: `${item.title} · ${duplicates.findIndex(other => other.key === item.key) + 1}` } : item;
  });
  const selected = artifactStore.get(owner);
  const previous = useRef<ArtifactItem[]>([]);
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState('');
  const pickerId = useId();
  const strip = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!items.length) { setMenu(false); setQuery(''); } }, [items.length]);
  useEffect(() => { setMenu(false); setQuery(''); }, [owner]);
  const select = (key: string | null) => {
    const item = items.find(item => item.key === key);
    focusSection(group.section);
    if (!panel.selectTab(item?.native?.key ?? group.mainKey)) { toast.error('Вкладка уже закрыта.'); return; }
    artifactStore.select(owner, item?.key ?? null);
    setMenu(false);
  };
  // Native files selected through a message/file link join this row immediately.
  useEffect(() => {
    const active = items.find(item => item.native?.key === group.selectedKey);
    if (active) artifactStore.select(owner, active.key);
  }, [group.selectedKey, owner, native]);
  useEffect(() => {
    if (!matchesOwner || group.selectedKey !== group.mainKey || !selected?.startsWith('native:')) return;
    const current = panel.getTabs();
    if (current.selectedKey !== group.mainKey) return;
    const key = selected.slice('native:'.length);
    if (!current.tabs.some(tab => tab.key === key)) { artifactStore.select(owner, null); return; }
    if (items.some(item => item.native?.key === key)) panel.selectTab(key);
  }, [matchesOwner, group.selectedKey, group.mainKey, native, owner, selected, panel]);
  useEffect(() => {
    if (!matchesOwner) return;
    const old = previous.current;
    previous.current = items;
    if (!selected || items.some(item => item.key === selected) || browsers.error) return;
    // Do not erase a browser choice while its first subscription snapshot is loading.
    if (selected.startsWith('browser:') && !browsers.ready) return;
    if (!old.some(item => item.key === selected)) return;
    const remaining = new Set(items.map(item => item.key));
    const next = afterArtifactClose(old.map(item => item.key), selected, selected);
    select(next && remaining.has(next) ? next : items[0]?.key ?? null);
  });
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [selected]);
  useEffect(() => {
    const header = row.current, tabs = strip.current;
    if (!header || !tabs) return;
    const scroll = (event: WheelEvent) => {
      if (event.ctrlKey || event.defaultPrevented || (event.target instanceof Element && event.target.closest('.kb-artifact-menu'))) return;
      const limit = tabs.scrollWidth - tabs.clientWidth;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (limit <= 0 || !delta) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? tabs.clientWidth : 1;
      // A native, non-passive listener keeps wheel events over the tab row from
      // scrolling the chat, including when the strip reaches either end.
      event.preventDefault();
      tabs.scrollLeft = Math.max(0, Math.min(limit, tabs.scrollLeft + delta * unit));
    };
    header.addEventListener('wheel', scroll, { passive: false });
    return () => header.removeEventListener('wheel', scroll);
  }, [items.length]);
  async function close(item: ArtifactItem) {
    try {
      if (item.browser) await sdk.experimental_desktopBrowsers.closeTab({ ...item.browser.scope, threadId: item.browser.threadId, tabId: item.browser.tabId });
      else if (item.native && !panel.closeTab(item.native.key)) toast.error('Не удалось закрыть вкладку.');
      // Reconcile only after BB confirms the tab is gone, including unsaved-file prompts.
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : String(cause)); }
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target instanceof HTMLInputElement) return;
    const buttons = Array.from(strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else if (event.key === 'Delete' && index > 0) { event.preventDefault(); void close(items[index - 1]); return; }
    else return;
    event.preventDefault(); buttons[next]?.focus(); buttons[next]?.click();
  }
  if (!items.length) return null;
  return <div {...scope} ref={row} className="kb-artifact-row" data-kanban-artifacts={group.section} data-artifact-owner={owner} onKeyDown={keyboard}>
    <button type="button" className="kb-artifact-caption" aria-label={`Материалы (${items.length})`}
      aria-expanded={menu} aria-controls={menu ? pickerId : undefined}
      title="Найти и выбрать материал текущей вкладки" onClick={() => { setMenu(!menu); setQuery(''); }}>
      <Icon name="Layers" /><span>Материалы</span><span className="kb-artifact-count" aria-hidden="true">{items.length}</span>
    </button>
    <div ref={strip} className="kb-artifact-strip" role="tablist" aria-label="Браузеры, файлы и артефакты" aria-orientation="horizontal">
      <button type="button" role="tab" aria-selected={!selected} tabIndex={selected ? -1 : 0} className="kb-artifact-home" onClick={() => select(null)} title="Вернуться к основной вкладке"><Icon name={context?.kind === 'issue' ? 'FileText' : 'MessageSquare'} /><span>{context?.kind === 'issue' ? 'Карточка' : 'Чат'}</span></button>
      {items.map(item => <div className="kb-artifact-tab" data-active={selected === item.key} key={item.key}>
        <button type="button" role="tab" aria-selected={selected === item.key} tabIndex={selected === item.key ? 0 : -1}
          data-artifact-key={item.key} onClick={() => select(item.key)} title={`${item.type} · ${item.title}\n${item.description}`}>
          <Icon name={item.icon} /><span className="kb-artifact-type">{item.type} · </span><span className="kb-artifact-title">{item.title}</span>
        </button>
        {item.closable && <button type="button" className="kb-artifact-close" aria-label={`Закрыть ${item.type.toLowerCase()}: ${item.title}`} title="Закрыть вкладку" onClick={() => void close(item)}><Icon name="X" /></button>}
      </div>)}
    </div>
    {menu && <div id={pickerId} className="kb-artifact-menu" role="region" aria-label="Материалы текущей вкладки" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setMenu(false); row.current?.querySelector<HTMLButtonElement>('.kb-artifact-caption')?.focus(); } }}>
      <input autoFocus aria-label="Найти материал" placeholder="Найти по названию или пути…" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="kb-artifact-menu-items">{items.filter(item => `${item.title} ${item.description}`.toLowerCase().includes(query.toLowerCase())).map(item =>
        <div className="kb-artifact-menu-item" key={item.key}><button type="button" aria-pressed={selected === item.key} title={`${item.type} · ${item.description}`} onClick={() => select(item.key)}>
          <Icon name={item.icon} /><span><strong>{item.title}</strong><small>{item.type} · {item.description}</small></span>{selected === item.key && <Icon name="Check" />}
        </button>{item.closable && <button type="button" aria-label={`Закрыть ${item.title}`} onClick={() => void close(item)}><Icon name="X" /></button>}</div>)}
      </div>
      {!items.some(item => `${item.title} ${item.description}`.toLowerCase().includes(query.toLowerCase())) && <p className="kb-artifact-empty">Материалы не найдены</p>}
    </div>}
  </div>;
}
