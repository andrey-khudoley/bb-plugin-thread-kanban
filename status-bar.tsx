import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { experimental_useSidebarThreads, useBbContext, useBbNavigate, useSidebarSplitLayout, useRealtime,
  type PluginSidebarThread } from '@get-bb/plugin-sdk/app';
import * as Popover from '@radix-ui/react-popover';
import { usePortalScopeProps } from './lib/portal-scope';
import { NotificationList, useNotifications } from './notifications';
import { useViewedNotifications } from './viewed-notifications';
import { NotificationPopups, usePopupArrivals } from './notification-popups';
import { NotificationSoundControls, useNotificationSound } from './use-notification-sound';
import { testNotificationChannel } from './notification-contract';
import { useActivityRuns } from './derive-activity';
import { statusThreads, chatStatusText } from './status-model';
import { mountStatusShell, type FooterItem, type FooterSnapshot } from './status-shell';
import './status-bar.css';

function StatusIcon({ kind }: { kind: 'working' | 'waiting' | 'bell' | 'project' | 'limits' | 'more' }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round">
    {kind === 'working' ? <><circle cx="12" cy="12" r="9" /><path d="m10 8 6 4-6 4z" /></> :
      kind === 'waiting' ? <><path d="M4 4h16v12H9l-5 4z" /><path d="M12 7v4m0 2h.01" /></> :
      kind === 'bell' ? <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></> :
      kind === 'project' ? <path d="M3 6h7l2 3h9v11H3z" /> :
      kind === 'limits' ? <><path d="M4 20h16M7 16V9m5 7V4m5 12v-5" /></> :
      <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>}
  </svg>;
}

const emptyFooter: FooterSnapshot = { items: [], usage: '—', usageTitle: 'Нет данных о лимитах. Открыть подробности.' };

export function GlobalStatusBar() {
  const data = experimental_useSidebarThreads();
  const context = useBbContext();
  const split = useSidebarSplitLayout();
  const navigate = useBbNavigate();
  const scope = usePortalScopeProps();
  const notices = useNotifications();
  const runs = useActivityRuns();
  // The originating window already has the detailed generation entry. Other clients use the saved result.
  const visibleNotices = useMemo(() => notices.notices.filter(notice => !notice.derivationId ||
    !runs.some(run => run.jobId === notice.derivationId)), [notices.notices, runs]);
  useViewedNotifications(split?.panes.find(pane => pane.isFocused)?.threadId ?? context.threadId,
    notices.notices, notices.viewThread, notices.read);
  const sound = useNotificationSound();
  const popups = usePopupArrivals(visibleNotices);
  useRealtime(testNotificationChannel, payload => {
    window.dispatchEvent(new CustomEvent('bb:status-popup', { detail: payload }));
  });
  const [contributions, setContributions] = useState(0);
  const [clearing, setClearing] = useState(false);
  const threads = useMemo(() => statusThreads(data.threads), [data.threads]);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState<'working' | 'waiting' | 'notifications' | 'project' | 'services' | 'limits' | null>(null);
  const [activeChat, setActiveChat] = useState<string | null>(null);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const pathname = location.pathname;
  const previousPath = useRef(pathname);
  const [footer, setFooter] = useState(emptyFooter);
  const bridge = useRef<ReturnType<typeof mountStatusShell> | null>(null);
  const previousCount = useRef<number | null>(null);
  const previousErrors = useRef<Set<string> | null>(null);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    const update = () => setContributions(Array.from(document.querySelectorAll<HTMLElement>('[data-bb-status-contribution-count]'))
      .reduce((sum, element) => sum + (Number(element.dataset.bbStatusContributionCount) || 0), 0));
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-bb-status-contribution-count'] });
    update();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    setActiveChat(null); setActiveProject(null);
  }, [pathname]);

  useLayoutEffect(() => {
    const host = document.createElement('div'); host.dataset.kanbanStatusHost = '';
    document.body.append(host); setTarget(host);
    bridge.current = mountStatusShell(setFooter);
    return () => { bridge.current?.dispose(); bridge.current = null; host.remove(); };
  }, []);
  useEffect(() => {
    const show = () => setOpen('notifications');
    const close = () => setOpen(null);
    const focus = (event: Event) => {
      const element = event.target instanceof Element ? event.target : null;
      if (!element || element.closest('[data-kanban-status-host], [data-bb-portaled-overlay]')) return;
      const workspace = element.closest<HTMLElement>('[data-kanban-panel="workspace"]');
      setActiveChat(workspace?.dataset.kanbanId ?? null);
      const card = element.closest<HTMLElement>('[data-kanban-project]');
      if (card?.dataset.kanbanProject) setActiveProject(card.dataset.kanbanProject);
    };
    window.addEventListener('kanban:show-notifications', show);
    window.addEventListener('bb:close-status-notifications', close);
    document.addEventListener('pointerdown', focus, true); document.addEventListener('focusin', focus, true);
    return () => { window.removeEventListener('kanban:show-notifications', show);
      window.removeEventListener('bb:close-status-notifications', close);
      document.removeEventListener('pointerdown', focus, true); document.removeEventListener('focusin', focus, true); };
  }, []);
  useEffect(() => {
    const count = threads.waiting.length;
    if (previousCount.current !== null && previousCount.current !== count) setAnnouncement(`Ожидают пользователя: ${count}`);
    previousCount.current = count;
  }, [threads.waiting.length]);
  useEffect(() => {
    if (activeChat || context.threadId) return;
    const read = () => {
      const shown = (element: HTMLElement) => element.getClientRects().length > 0 && !element.closest('[hidden], [aria-hidden="true"]');
      const pane = Array.from(document.querySelectorAll<HTMLElement>('[data-kanban-panel="workspace"]')).find(shown) ??
        Array.from(document.querySelectorAll<HTMLElement>('[data-kanban-panel="issue"]')).find(shown);
      if (pane?.dataset.kanbanPanel === 'workspace') setActiveChat(pane.dataset.kanbanId ?? null);
      const project = pane?.closest<HTMLElement>('[data-kanban-project]')?.dataset.kanbanProject;
      if (project) setActiveProject(project);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['data-kanban-project', 'data-kanban-tab'] });
    return () => observer.disconnect();
  }, [activeChat, context.threadId]);

  const focusedThreadId = activeChat ?? split?.panes.find(pane => pane.isFocused)?.threadId ?? context.threadId;
  const thread = threads.all.find(item => item.id === focusedThreadId);
  const projectId = thread?.projectId ?? activeProject ?? context.projectId;
  const project = data.projects.find(item => item.id === projectId);
  const openChatId = (id: string, title?: string) => {
    setOpen(null);
    const request = new CustomEvent('bb:focus-status-chat', { detail: { threadId: id, title }, cancelable: true });
    if (window.dispatchEvent(request)) navigate.toThread(id,
      split?.panes.some(pane => pane.threadId === id) ? { split: true } : undefined);
    setActiveChat(id);
  };
  const openChat = (selected: PluginSidebarThread) => openChatId(selected.id, selected.displayTitle);
  const openIssueId = (issueId: string) => {
    setOpen(null);
    const request = new CustomEvent('bb:focus-status-issue', { detail: { issueId }, cancelable: true });
    if (window.dispatchEvent(request)) navigate.toPluginPanel('board', { subPath: `issue/${issueId}` });
  };
  const usageItem = footer.items.find(item => item.id.includes('bb--provider-usage-usage'));
  const serviceItems = footer.items.filter(item => item !== usageItem && item.id !== 'sidebar-footer-more');
  const more = footer.items.find(item => item.id === 'sidebar-footer-more');
  // Preserve existing unread/error/cancelled chats and pre-install history.
  const legacy = threads.notifications.filter(thread => !notices.coveredThreads.includes(thread.id) && !notices.hiddenLegacyThreads.includes(thread.id));
  useEffect(() => {
    if (data.status !== 'ready') return;
    const errors = legacy.filter(thread => thread.status === 'error' || thread.queuedWork === 'failed');
    if (previousErrors.current) for (const error of errors) {
      if (!previousErrors.current.has(error.id)) popups.notify({ id: `error:${error.id}:${error.updatedAt}`,
        label: 'Работа прервана с ошибкой', title: error.displayTitle, threadId: error.id });
    }
    previousErrors.current = new Set(errors.map(error => error.id));
  }, [legacy, data.status, popups.notify]);
  const notifications = contributions + notices.unread - (notices.notices.length - visibleNotices.length) + legacy.length;
  const clearNotifications = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      if (await notices.clearAll(legacy.map(thread => thread.id))) {
        window.dispatchEvent(new Event('bb:clear-status-notifications'));
        popups.clear();
      }
    } finally { setClearing(false); }
  };
  const activate = (item: FooterItem) => { setOpen(null); bridge.current?.activate(item.id); };
  const service = (item: FooterItem, inMenu = false) => <button key={item.id} type="button" disabled={item.disabled}
    className={inMenu ? 'kb-status-service-row' : 'kb-status-item kb-status-service-icon'}
    data-kanban-service={item.id} aria-label={item.label} title={item.label}
    onClick={() => activate(item)}>
    {item.icon ? <span className="kb-status-native-icon" dangerouslySetInnerHTML={{ __html: item.icon }} /> : <StatusIcon kind="more" />}
    {inMenu && <span>{item.label}</span>}
  </button>;
  const list = (items: readonly PluginSidebarThread[], empty: string, dismiss?: (threadId: string) => void) => items.length ?
    <ul className="kb-status-chat-list">{items.map(item => <li key={item.id} className={dismiss ? 'kb-status-notification-row' : undefined}>
      <button type="button" data-status-thread={item.id} onClick={() => openChat(item)} title={item.displayTitle}>
        <span className="kb-status-chat-title">{item.displayTitle}</span>
        <span className="kb-status-chat-detail">{data.projects.find(project => project.id === item.projectId)?.name ?? item.projectId} · {chatStatusText(item)}</span>
      </button>
      {dismiss && <button type="button" className="kb-status-notification-dismiss" aria-label={`Скрыть уведомление: ${item.displayTitle}`}
        title="Скрыть без прочтения" onClick={() => dismiss(item.id)}>×</button>}
    </li>)}</ul> : <p className="kb-status-empty">{empty}</p>;
  const popup = (id: NonNullable<typeof open>, label: string, trigger: React.ReactNode, content: React.ReactNode,
    className = '') => <Popover.Root open={open === id} onOpenChange={value => setOpen(value ? id : null)}>
    <Popover.Trigger asChild><button type="button" className={`kb-status-item ${className}`} aria-label={label} title={label}>{trigger}</button></Popover.Trigger>
    <Popover.Portal><Popover.Content {...scope} side="top" align={id === 'notifications' || id === 'services' || id === 'limits' ? 'end' : 'start'}
      sideOffset={5} collisionPadding={8} className="kb-status-popup" aria-label={label}>
      <header><strong>{label}</strong><span className="kb-status-popup-actions">
        {id === 'notifications' && <button type="button" className="kb-status-clear-all" onClick={() => void clearNotifications()}
          disabled={clearing || !notices.notices.length && !legacy.length && !contributions}
          title="Скрыть все уведомления без прочтения чатов">Очистить все</button>}
        <Popover.Close asChild><button type="button" aria-label="Закрыть">×</button></Popover.Close>
      </span></header>
      {content}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;

  if (!target) return null;
  return createPortal(<>
    <div {...scope}><NotificationPopups items={popups.queue} dismiss={popups.dismiss} open={item => {
      if (item.issueId) openIssueId(item.issueId);
      else if (item.threadId) openChatId(item.threadId, item.title);
      else setOpen('notifications');
      if (item.noticeId) void notices.read(item.noticeId);
    }} /></div>
    <div {...scope} role="toolbar" aria-label="Общая строка состояния BB" data-kanban-status-bar="" className="kb-status-bar"
      data-working-count={threads.working.length} data-waiting-count={threads.waiting.length}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
          .filter(button => button.getClientRects().length > 0);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
          (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        if (buttons[next]) { event.preventDefault(); buttons[next].focus(); }
      }}>
      <div className="kb-status-left">
        {popup('project', project?.name ?? 'Раздел не выбран', <><StatusIcon kind="project" /><span className="kb-status-project-label">{project?.name ?? 'BB'}</span>
          {thread?.environment?.branchName && <span className="kb-status-branch">⑂ {thread.environment.branchName}</span>}</>, <>
          <p>{project?.name ?? 'Выберите раздел или чат'}</p>
          {thread?.environment?.name && <p>Окружение: {thread.environment.name}</p>}
          {thread?.environment?.branchName && <p>Ветка: {thread.environment.branchName}</p>}
          {project && <button className="kb-status-service-row" onClick={() => { setOpen(null); navigate.toProject(project.id); }}>Открыть раздел</button>}
        </>, 'kb-status-project')}
        {popup('working', `Работающие чаты: ${data.status === 'ready' ? threads.working.length : 'данные недоступны'}`,
          <><StatusIcon kind="working" /><span className="kb-status-caption">Работают</span><span className="kb-status-count">{data.status === 'ready' ? threads.working.length : '—'}</span></>,
          list(threads.working, data.status === 'ready' ? 'Сейчас нет работающих чатов.' : 'Список чатов загружается или недоступен.'), 'kb-status-working')}
        {popup('waiting', `Ожидают пользователя: ${data.status === 'ready' ? threads.waiting.length : 'данные недоступны'}`,
          <><StatusIcon kind="waiting" /><span className="kb-status-caption">Ожидают</span><span className="kb-status-count">{data.status === 'ready' ? threads.waiting.length : '—'}</span></>,
          list(threads.waiting, data.status === 'ready' ? 'Нет чатов, ожидающих вашего ответа.' : 'Список чатов загружается или недоступен.'), 'kb-status-waiting')}
      </div>
      <div className="kb-status-right">
        <div className="kb-status-services">{serviceItems.map(item => service(item))}</div>
        {popup('services', 'Плагины и сервисы', <StatusIcon kind="more" />, <>
          {serviceItems.map(item => service(item, true))}
          {more && <button type="button" className="kb-status-service-row" data-kanban-service={more.id}
            onClick={() => activate(more)}>Все действия BB и настройка значков…</button>}
          {!footer.items.length && <p>Сервисы BB пока недоступны.</p>}
        </>, 'kb-status-overflow')}
        {usageItem ? <button type="button" className="kb-status-item kb-status-limits" title={footer.usageTitle}
          aria-label={`Лимиты: ${footer.usage}. ${footer.usageTitle}`} data-kanban-service={usageItem.id} onClick={() => activate(usageItem)}>
          <StatusIcon kind="limits" /><span className="kb-status-caption">Лимиты</span><span>{footer.usage}</span>
        </button> : popup('limits', 'Лимиты недоступны', <><StatusIcon kind="limits" /><span>—</span></>,
          <p>Сервис лимитов BB недоступен. Проверьте, что плагин Provider usage включён.</p>)}
        {popup('notifications', `Уведомления: ${notifications}`, <><StatusIcon kind="bell" /><span className="kb-status-count">{notifications}</span></>, <>
          <NotificationSoundControls sound={sound} />
          <div data-bb-status-notification-contributions="" />
          {notices.error && <p role="alert">{notices.error}</p>}
          <NotificationList notices={visibleNotices} open={notice => {
            if (notice.issueId) openIssueId(notice.issueId);
            else openChatId(notice.threadId, notice.title);
            void notices.read(notice.id);
          }} dismiss={id => void notices.dismiss(id)} />
          {list(legacy, '', id => void notices.dismissLegacy(id))}
          {!notices.notices.length && !contributions && !legacy.length && <p className="kb-status-empty">Новых уведомлений нет. Здесь появятся результаты работы агентов и запросы ответа.</p>}
        </>, 'kb-status-notifications')}
      </div>
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    </div>
  </>, target);
}
