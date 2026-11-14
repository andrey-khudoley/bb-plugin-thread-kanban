import { useEffect, useRef, useState } from 'react';
import { useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import { cardChatPreviewRpc } from './card-chat-preview-contract';
import { cardActivityChanged } from './card-activity-contract';
import type { ChatPreviewLine } from './card-chat-preview';

/** Mounted only while the popup is open; reading a preview never marks a chat read. */
export function CardChatPreview({ threadId, caption }: { threadId: string; caption?: string }) {
  const rpc = useRpc<typeof cardChatPreviewRpc>();
  const rpcRef = useRef(rpc); rpcRef.current = rpc;
  const [state, setState] = useState<{ lines: ChatPreviewLine[]; error: boolean } | null>(null);
  const refresh = useRef<() => void>(() => {});
  useRealtime(cardActivityChanged, payload => {
    if (payload && typeof payload === 'object' && 'ids' in payload && Array.isArray(payload.ids) && payload.ids.includes(threadId)) refresh.current();
  });
  useEffect(() => {
    let disposed = false, inFlight = false, again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      if (disposed || document.hidden) return;
      if (inFlight) { again = true; return; }
      inFlight = true;
      try {
        const result = await rpcRef.current.call('cardChatPreview', { threadId });
        if (!disposed) setState({ lines: result.lines, error: false });
      } catch { if (!disposed) setState(previous => ({ lines: previous?.lines ?? [], error: true })); }
      finally {
        inFlight = false;
        if (again && !disposed) { again = false; refresh.current(); }
      }
    }
    refresh.current = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void read(); }, 250); };
    const visible = () => { if (!document.hidden) void read(); };
    document.addEventListener('visibilitychange', visible);
    const poll = setInterval(() => void read(), 2000);
    void read();
    return () => { disposed = true; refresh.current = () => {}; clearTimeout(timer); clearInterval(poll); document.removeEventListener('visibilitychange', visible); };
  }, [threadId]);
  return <section className="kb-card-chat-preview" aria-label="Последние 8 строк чата" aria-busy={!state}>
    <div className="kb-card-chat-heading"><span>Последние 8 строк</span>{caption && <span>{caption}</span>}</div>
    <div className="kb-card-chat-lines">
      {state?.lines.length ? state.lines.map(line => <div key={line.key} className="kb-card-chat-line" data-role={line.role}
        title={line.text} aria-label={`${line.role === 'user' ? 'Вы' : 'Агент'}: ${line.text}`}>
        <span className="kb-card-chat-role" aria-hidden="true">{line.role === 'user' ? 'Вы' : 'Агент'}</span>
        <span className="kb-card-chat-text">{line.text}</span>
      </div>) : <p className="kb-card-chat-empty">{!state ? 'Загружаю чат…' : state.error ? 'Не удалось загрузить чат' : 'В чате пока нет сообщений'}</p>}
    </div>
  </section>;
}
