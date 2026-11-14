import { useCallback, useEffect, useState } from 'react';
import { useRealtime, useRealtimeConnectionState, useRpc } from '@get-bb/plugin-sdk/app';
import { channel, noticeLabel, type contract, type Notice } from './notification-contract';

export function useNotifications() {
  const rpc = useRpc<typeof contract>();
  const connection = useRealtimeConnectionState();
  const [data, setData] = useState<{ notices: Notice[]; unread: number; coveredThreads: string[]; hiddenLegacyThreads: string[] }>({ notices: [], unread: 0, coveredThreads: [], hiddenLegacyThreads: [] });
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useRealtime(channel, () => setRevision(value => value + 1));
  useEffect(() => {
    let cancelled = false;
    rpc.call('notifications.list', {}).then(value => { if (!cancelled) { setData(value); setError(''); } })
      .catch(() => { if (!cancelled) setError('Не удалось загрузить уведомления.'); });
    return () => { cancelled = true; };
  }, [rpc, revision, connection]);
  const viewThread = useCallback(async (threadId: string) => {
    try { await rpc.call('notifications.viewThread', { threadId }); setRevision(value => value + 1); }
    catch { setError('Не удалось обновить уведомления просмотренного чата.'); throw new Error('viewThread failed'); }
  }, [rpc]);
  const read = useCallback(async (id: string) => {
    try { await rpc.call('notifications.read', { id }); setRevision(value => value + 1); }
    catch { setError('Не удалось отметить уведомление прочитанным.'); }
  }, [rpc]);
  return { ...data, error, viewThread, read, async clearAll(legacyThreadIds: string[]) {
    try {
      await rpc.call('notifications.dismissAll', { legacyThreadIds }); setRevision(value => value + 1); return true;
    } catch { setError('Не удалось очистить уведомления.'); return false; }
  }, async dismiss(id: string) {
    try { await rpc.call('notifications.dismiss', { id }); setRevision(value => value + 1); }
    catch { setError('Не удалось скрыть уведомление.'); }
  }, async dismissLegacy(threadId: string) {
    try { await rpc.call('notifications.dismissLegacy', { threadId }); setRevision(value => value + 1); }
    catch { setError('Не удалось скрыть уведомление.'); }
  } };
}

export function NotificationList({ notices, open, dismiss }: { notices: Notice[]; open: (notice: Notice) => void; dismiss: (id: string) => void }) {
  return <ul className="kb-status-chat-list">{notices.map(notice => <li className="kb-status-notification-row" key={notice.id}>
    <button type="button" data-notification-id={notice.id} data-unread={notice.readAt === null}
      onClick={() => open(notice)} title={notice.detail}>
      <span className="kb-status-event-type">{notice.readAt === null ? '● ' : ''}{noticeLabel(notice)}</span>
      <span className="kb-status-chat-title">{notice.title}</span>
      <span className="kb-status-chat-detail">{notice.detail}</span>
    </button>
    <button type="button" className="kb-status-notification-dismiss" aria-label={`Скрыть уведомление: ${notice.title}`}
      title="Скрыть без прочтения" onClick={() => dismiss(notice.id)}>×</button>
  </li>)}</ul>;
}
