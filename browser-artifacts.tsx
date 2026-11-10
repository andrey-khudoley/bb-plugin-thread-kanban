import { useEffect, useRef, useState } from 'react';
import { useSdk, experimental_useTabVisible } from '@get-bb/plugin-sdk/app';
import { desktopBrowser, browserBounds, type DesktopTarget, type BrowserState } from './desktop-browser';
import { Icon } from './components/ui/icon';

export type BrowserArtifact = {
  key: string; tabId: string; threadId: string; title: string; url: string;
  scope: DesktopTarget; controlled: boolean;
};

/** Includes hidden tabs and subscribes without acquiring automation control. */
export function useBrowserArtifacts(threadId: string | null) {
  const sdk = useSdk();
  const [result, setResult] = useState<{ threadId: string | null; tabs: BrowserArtifact[]; error: string | null; ready: boolean }>({ threadId: null, tabs: [], error: null, ready: false });
  useEffect(() => {
    if (!threadId) return;
    let disposed = false;
    const subscriptions = new Map<string, { dispose(): void }>();
    const byScope = new Map<string, BrowserArtifact[]>();
    const update = () => { if (!disposed) setResult({ threadId, tabs: [...byScope.values()].flat(), error: null, ready: true }); };
    const error = (cause: unknown) => { if (!disposed) setResult(previous => ({
      ...(previous.threadId === threadId ? previous : { threadId, tabs: [], ready: false }),
      error: cause instanceof Error ? cause.message : String(cause),
    })); };
    let discovering = false;
    async function start() {
      if (discovering || disposed) return;
      discovering = true;
      try {
        const [local, execution] = await Promise.allSettled([
          desktopBrowser()?.getTarget(),
          sdk.threads.get({ threadId: threadId! }).then(thread => thread.environmentId
            ? sdk.environments.get({ environmentId: thread.environmentId }) : null),
        ]);
        const hosts = new Set<string>();
        if (local.status === 'fulfilled' && local.value) hosts.add(local.value.hostId);
        if (execution.status === 'fulfilled' && execution.value) hosts.add(execution.value.hostId);
        if (!hosts.size) { if (execution.status === 'rejected') error(execution.reason); else update(); return; }
        const discoveries = await Promise.allSettled([...hosts].map(async hostId => ({ hostId,
          ...(await sdk.experimental_desktopBrowsers.listInstances({ hostId })) })));
        if (disposed) return;
        const live = new Set<string>();
        for (const discovery of discoveries) {
          if (discovery.status === 'rejected') { error(discovery.reason); continue; }
          const { hostId, instances } = discovery.value;
          for (const instance of instances) {
            const scope = { hostId, instanceId: instance.instanceId, generation: instance.generation };
            const scopeKey = JSON.stringify(scope);
            live.add(scopeKey);
            if (subscriptions.has(scopeKey)) continue;
            const receive = (result: { tabs: { tabId: string; threadId: string; title: string; url: string; control: unknown }[] }) => {
              if (disposed || !subscriptions.has(scopeKey)) return;
              byScope.set(scopeKey, result.tabs.filter(tab => tab.threadId === threadId).map(tab => ({
                key: `browser:${instance.instanceId}:${tab.tabId}`, tabId: tab.tabId, threadId: tab.threadId,
                title: tab.title || browserLabel(tab.url), url: tab.url, scope, controlled: !!tab.control,
              })));
              update();
            };
            subscriptions.set(scopeKey, sdk.experimental_desktopBrowsers.subscribe({ ...scope, threadId: threadId!, onChange: receive, onError: error }));
          }
        }
        // A disconnected host is provisional: retain its tabs until discovery succeeds.
        const failed = discoveries.some(discovery => discovery.status === 'rejected');
        if (!failed) for (const [key, subscription] of subscriptions) if (!live.has(key)) {
          subscription.dispose(); subscriptions.delete(key); byScope.delete(key);
        }
        if (!live.size && !failed) update();
      } finally { discovering = false; }
    }
    void start().catch(error);
    const discoveryTimer = setInterval(() => { void start().catch(error); }, 5000);
    return () => { disposed = true; clearInterval(discoveryTimer); subscriptions.forEach(subscription => subscription.dispose()); };
  }, [sdk, threadId]);
  return result.threadId === threadId ? result : { threadId, tabs: [], error: null, ready: false };
}
export function browserLabel(url: string) {
  try { return new URL(url).hostname || 'Браузер'; } catch { return 'Браузер'; }
}

export function BrowserArtifactContent({ tab }: { tab: BrowserArtifact }) {
  const viewport = useRef<HTMLDivElement>(null);
  const visible = experimental_useTabVisible();
  const [state, setState] = useState<BrowserState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState(tab.url);
  const bridge = desktopBrowser();
  useEffect(() => { setAddress(state?.url ?? tab.url); }, [state?.url, tab.url]);
  useEffect(() => {
    setState(null); setError(null);
    if (!bridge || !viewport.current) return;
    let disposed = false, attached = false, frame = 0;
    const region = viewport.current;
    let lastBounds = '', showing = false;
    const hide = () => { if (showing) bridge.setVisible({ tabId: tab.tabId, visible: false }); showing = false; region.dataset.browserVisible = 'false'; };
    const update = () => {
      frame = 0;
      if (disposed || !attached) return;
      // Native BrowserViews sit above the DOM. Hide them while a menu/dialog is open.
      const overlay = Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="menu"],[data-kb-artifact-menu="true"]'))
        .some(element => !element.contains(region) && element.getClientRects().length > 0
          && !element.closest('[hidden],[aria-hidden="true"],[data-state="closed"]'));
      const bounds = visible && document.visibilityState === 'visible' && !overlay ? browserBounds(region) : null;
      if (!bounds) { hide(); return; }
      const serialized = JSON.stringify(bounds);
      if (serialized !== lastBounds) { bridge.setBounds({ tabId: tab.tabId, bounds }); lastBounds = serialized; }
      if (!showing) (bridge.setVisibleWithoutFocus ?? bridge.setVisible).call(bridge, { tabId: tab.tabId, visible: true });
      showing = true; region.dataset.browserVisible = 'true';
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const unsubscribe = bridge.onState(next => { if (next.tabId === tab.tabId && !disposed) {
      setState(next);
      try { const url = new URL(next.url); region.dataset.browserPage = url.origin + url.pathname; }
      catch { region.dataset.browserPage = ''; }
    } });
    void bridge.getTarget().then(target => {
      if (disposed) return;
      if (!target || target.hostId !== tab.scope.hostId || target.instanceId !== tab.scope.instanceId || target.generation !== tab.scope.generation) {
        setError('Эта сессия открыта в другом окне BB. Открой канбан в том окне, чтобы продолжить работу.'); return;
      }
      const bounds = browserBounds(region) ?? { x: 0, y: 0, width: 1, height: 1 };
      // existingOnly prevents a closed/stale session from silently creating a duplicate.
      bridge.attach({ tabId: tab.tabId, threadId: tab.threadId, url: tab.url, bounds, visible: false, existingOnly: true });
      attached = true; region.dataset.browserAttached = 'true'; schedule();
    }).catch(cause => { if (!disposed) setError(String(cause)); });
    const resize = new ResizeObserver(schedule); resize.observe(region);
    const mutation = new MutationObserver(schedule);
    mutation.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'data-state', 'style'] });
    window.addEventListener('resize', schedule); document.addEventListener('scroll', schedule, true);
    document.addEventListener('visibilitychange', schedule);
    return () => { disposed = true; cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect(); unsubscribe();
      window.removeEventListener('resize', schedule); document.removeEventListener('scroll', schedule, true);
      document.removeEventListener('visibilitychange', schedule); if (attached) hide();
      // Never detach: switching main tabs must preserve the live page and its control lease.
    };
  }, [bridge, tab.tabId, tab.threadId, tab.scope.hostId, tab.scope.instanceId, tab.scope.generation, visible]);
  return <section className="kb-browser-content" aria-label={`Браузер: ${tab.title}`} data-kanban-browser={tab.tabId}>
    <form className="kb-browser-address" onSubmit={event => { event.preventDefault();
      try { const url = new URL(address); if (!['https:', 'http:'].includes(url.protocol)) return; bridge?.navigate({ tabId: tab.tabId, url: url.href }); } catch { /* Keep the entered address editable. */ }
    }}>
      <button type="button" title="Назад" aria-label="Назад в браузере" disabled={!bridge?.goBack || !state?.canGoBack} onClick={() => bridge?.goBack?.(tab.tabId)}><Icon name="ArrowLeft" /></button>
      <button type="button" title="Обновить страницу" aria-label="Обновить страницу" disabled={!bridge} onClick={() => bridge?.reload(tab.tabId)}><Icon name="RotateCcw" /></button>
      <input aria-label="Адрес страницы" value={address} onChange={event => setAddress(event.target.value)} />
      <span className="kb-browser-status">{tab.controlled ? 'Агент управляет' : state?.isLoading ? 'Загрузка…' : browserLabel(state?.url ?? tab.url)}</span>
      {tab.controlled && bridge?.releaseControl && <button type="button" title="Остановить управление агента и работать со страницей" onClick={() => {
        bridge.releaseControl?.(tab.tabId); bridge.focus?.(tab.tabId);
      }}>Перехватить</button>}
    </form>
    {!bridge || error ? <div className="kb-browser-unavailable" role="status">{error ?? 'Рабочая страница доступна в приложении BB на компьютере, где открыта эта сессия.'}<p>{tab.url}</p></div>
      : <div ref={viewport} className="kb-browser-viewport" />}
  </section>;
}
