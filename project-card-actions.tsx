import { createContext, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type DragEvent, type HTMLAttributes, type ReactNode } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import { folderRpc, type ProjectFolder } from './project-folders';
import { issueStages, type Issue, type IssueStatus } from './issues';
import { Button } from './components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog';

export type CardDestination = { sectionId?: string; folderId?: string | null; status?: IssueStatus; beforeId?: string; atEnd?: boolean; positionScope?: 'stage' | 'project' };
export type MoveCards = (ids: string[], target: CardDestination) => Promise<boolean>;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export function restoreCardFocus(trigger?: HTMLElement | null, ids: string[] = []) {
  const card = Array.from(document.querySelectorAll<HTMLElement>('[data-kanban-card-id]')).find(node => ids.includes(node.dataset.kanbanCardId ?? '') && !node.closest('[hidden]'));
  const target = trigger?.isConnected && !trigger.closest('[hidden]') ? trigger : card?.querySelector<HTMLElement>('button.kb-card-title') ??
    document.querySelector<HTMLElement>('.kb-project-members input[type="search"]') ?? document.querySelector<HTMLElement>('.kb-shell');
  target?.focus();
}
// Compact drawers are unmounted with their owner, so they do not receive an
// open=false render. Restore focus after their inert layer has been removed.
export function useCardDialogFocus(trigger?: HTMLElement | null, ids: string[] = [], skip?: { current: boolean }) {
  const latest = useRef({ trigger, ids, skip });
  latest.current = { trigger, ids, skip };
  useEffect(() => () => {
    const { trigger, ids, skip } = latest.current;
    if (!skip?.current) requestAnimationFrame(() => restoreCardFocus(trigger, ids));
  }, []);
}
export function useCardRelocation(issues: Issue[], changed: () => unknown) {
  const rpc = useRpc<typeof folderRpc>();
  const [pending, setPending] = useState(false);
  const guard = useRef(false);
  const [lastUndo, setLastUndo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!lastUndo) return; const timer = setTimeout(() => setLastUndo(null), 60000); return () => clearTimeout(timer); }, [lastUndo]);
  const refresh = async () => { try { await changed(); } catch { /* Mutation success is independent of a recovery read. */ } };
  const undoToken = async (token: string) => {
    if (guard.current) return false; guard.current = true; setPending(true); setError(null);
    try { await rpc.call('folderUndoMove', { token }); setLastUndo(current => current === token ? null : current); await refresh(); toast.success('Перенос отменён'); return true; }
    catch (error) { const text = errorText(error); setError(text); toast.error(text); await refresh(); return false; }
    finally { guard.current = false; setPending(false); }
  };
  const move: MoveCards = async (ids, target) => {
    if (guard.current || !ids.length) return false;
    const cards = ids.map(id => issues.find(issue => issue.id === id));
    if (cards.some(card => !card)) { toast.error('Карточка больше не доступна. Обнови список.'); return false; }
    guard.current = true; setPending(true); setError(null);
    try {
      const result = await rpc.call('folderRelocate', { cards: cards.map(card => ({ id: card!.id, version: card!.version })),
        ...(target.folderId !== undefined ? { folderId: target.folderId } : {}), ...(target.status ? { status: target.status } : {}),
        ...(target.beforeId ? { beforeId: target.beforeId } : {}), ...(target.atEnd ? { atEnd: true } : {}), ...(target.positionScope ? { positionScope: target.positionScope } : {}) });
      if (result.undoToken) setLastUndo(result.undoToken);
      await refresh();
      if (result.moved) toast.success(result.moved === 1 ? 'Карточка перемещена' : `Перемещено карточек: ${result.moved}`, {
        duration: 10000,
        ...(result.undoToken ? { action: { label: 'Отменить', onClick: () => {
          void undoToken(result.undoToken!);
        } } } : {}),
      });
      return true;
    } catch (error) { const text = errorText(error); setError(text); toast.error(text); await refresh(); return false; }
    finally { guard.current = false; setPending(false); }
  };
  return { move, pending, error, canUndo: !!lastUndo, undo: () => lastUndo ? undoToken(lastUndo) : Promise.resolve(false) };
}

export function MoveCardsDialog({ cards, folders, move, close, returnFocus, onMoved }: {
  cards: Issue[]; folders: ProjectFolder[]; move: MoveCards; close: () => void; returnFocus?: HTMLElement | null; onMoved?: () => void;
}) {
  const initial = cards[0]?.folderId ?? '';
  const sameFolder = cards.every(card => (card.folderId ?? '') === initial);
  const [folderId, setFolderId] = useState(sameFolder ? initial : '__keep');
  const [stage, setStage] = useState<string>('keep');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const sameSection = new Set(cards.map(card => card.projectId)).size === 1;
  const control = 'w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-2 text-sm';
  useCardDialogFocus(returnFocus, cards.map(card => card.id));
  return <Dialog open onOpenChange={open => { if (!open && !pending) close(); }}><DialogContent className="kb-scope kb-folder-dialog"
    onCloseAutoFocus={event => event.preventDefault()} onAfterCloseAutoFocus={() => restoreCardFocus(returnFocus, cards.map(card => card.id))}>
    <DialogHeader><DialogTitle>{cards.length === 1 ? 'Переместить карточку' : `Переместить карточки · ${cards.length}`}</DialogTitle>
      <DialogDescription>{cards.length === 1 ? cards[0].title || 'Без названия' : 'Проект и этап изменятся одним действием. Чаты и история сохранятся.'}</DialogDescription></DialogHeader>
    {!sameSection ? <p role="alert">Выберите карточки одного раздела. Проекты не переносят карточки между разделами.</p> :
      <form className="space-y-3" onSubmit={event => { event.preventDefault(); setPending(true);
        void move(cards.map(card => card.id), { ...(folderId === '__keep' ? {} : { folderId: folderId || null }),
          ...(stage === 'keep' ? {} : { status: stage as IssueStatus }) }).then(ok => { if (ok) { onMoved?.(); close(); } else setError('Перенос не выполнен. Карточки обновлены; повторите действие или выберите другое назначение.'); }).finally(() => setPending(false)); }}>
        <label className="block text-sm">Проект<select autoFocus className={control} aria-label="Проект назначения" value={folderId} disabled={pending} onChange={event => setFolderId(event.target.value)}>
          <option value="__keep">Сохранить текущие проекты</option><option value="">Без проекта · в разделе</option>
          {folders.filter(folder => folder.sectionId === cards[0].projectId).map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
        </select></label>
        <label className="block text-sm">Этап<select className={control} aria-label="Этап назначения" value={stage} disabled={pending} onChange={event => setStage(event.target.value)}>
          <option value="keep">Сохранить текущие этапы</option>{issueStages.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select></label>
        {error && <p role="alert">{error}</p>}
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={pending || (stage === 'keep' && (folderId === '__keep' || (sameFolder && folderId === initial)))}>{pending ? 'Перемещаю…' : 'Переместить'}</Button>
          <Button type="button" variant="ghost" disabled={pending} onClick={close}>Отмена</Button></div>
      </form>}
  </DialogContent></Dialog>;
}

export function ChatProjectDialog({ title, folders, create, close, returnFocus }: {
  title: string; folders: ProjectFolder[]; create: (folderId: string) => Promise<unknown>; close: () => void; returnFocus?: HTMLElement | null;
}) {
  const [folderId, setFolderId] = useState('');
  const [pending, setPending] = useState(false);
  const navigated = useRef(false);
  useCardDialogFocus(returnFocus, [], navigated);
  return <Dialog open onOpenChange={open => { if (!open && !pending) close(); }}><DialogContent className="kb-scope kb-folder-dialog"
    onCloseAutoFocus={event => event.preventDefault()} onAfterCloseAutoFocus={() => { if (!navigated.current) restoreCardFocus(returnFocus); }}>
    <DialogHeader><DialogTitle>Добавить чат в проект</DialogTitle><DialogDescription>Для чата «{title}» будет создана карточка. История чата и его этап сохранятся.</DialogDescription></DialogHeader>
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (pending || !folderId) return; setPending(true);
      void create(folderId).then(result => { if (result) { navigated.current = true; close(); } }).finally(() => setPending(false)); }}>
      <label className="block text-sm">Проект<select autoFocus aria-label="Проект для чата" className="w-full rounded-md border border-input bg-background p-2" value={folderId} disabled={pending} onChange={event => setFolderId(event.target.value)}>
        <option value="">Выберите проект</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
      </select></label>
      {!folders.length && <p role="status">Сначала создайте проект в этом разделе через «Создать».</p>}
      <div className="flex flex-wrap gap-2"><Button type="submit" disabled={pending || !folderId}>{pending ? 'Добавляю…' : 'Создать карточку в проекте'}</Button>
        <Button variant="ghost" type="button" disabled={pending} onClick={close}>Отмена</Button></div>
    </form>
  </DialogContent></Dialog>;
}

type DragContext = {
  source: Issue | undefined; issues: Issue[]; folders: ProjectFolder[];
  start: (id: string) => void; end: () => void; move: MoveCards;
  sectionOf: (id: string) => string; openMove: (ids: string[], trigger?: HTMLButtonElement | null) => void; suppressClick: () => boolean;
  over: string | null; hover: (id: string | null) => void;
  openChatProject: (threadId: string, trigger?: HTMLButtonElement | null) => void;
  drop: MoveCards;
};
const CardDragContext = createContext<DragContext | null>(null);
export const useProjectCardActions = () => useContext(CardDragContext);
export function ProjectCardActions({ issues, folders, move, drop, sectionOf, openMove, openChatProject, children }: {
  issues: Issue[]; folders: ProjectFolder[]; move: MoveCards; sectionOf: (id: string) => string;
  openMove: (ids: string[], trigger?: HTMLButtonElement | null) => void;
  openChatProject: (threadId: string, trigger?: HTMLButtonElement | null) => void; drop: MoveCards; children: ReactNode;
}) {
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, hover] = useState<string | null>(null);
  const suppressUntil = useRef(0);
  const end = () => { setDragged(null); hover(null); suppressUntil.current = Date.now() + 200; };
  useEffect(() => {
    if (!dragged) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') end(); };
    window.addEventListener('dragend', end); window.addEventListener('drop', end); window.addEventListener('keydown', cancel);
    return () => { window.removeEventListener('dragend', end); window.removeEventListener('drop', end); window.removeEventListener('keydown', cancel); };
  }, [dragged]);
  return <CardDragContext.Provider value={{ source: issues.find(issue => issue.id === dragged), issues, folders, over, hover,
    start: setDragged, end, move, drop, sectionOf, openMove, openChatProject, suppressClick: () => Date.now() < suppressUntil.current }}>
    {children}</CardDragContext.Provider>;
}

export function useCardDrop(target: CardDestination) {
  const context = useProjectCardActions();
  const targetId = useId();
  const source = context?.source;
  const before = context?.issues.find(issue => issue.id === target.beforeId);
  const folder = target.folderId ? context?.folders.find(folder => folder.id === target.folderId) : undefined;
  const destinationFor = (issue: Issue): CardDestination | null => {
    if (!target.beforeId) return target;
    if (target.positionScope === 'project') {
      // A list has no stage destination. Extracting from a project is explicit.
      return target.folderId === null && issue.folderId ? null : target;
    }
    if (target.folderId) {
      // Every part of a project adds membership without changing the stage.
      // A card in another stage cannot be a positional neighbour.
      return issue.status === target.status ? { ...target, status: undefined } :
        { sectionId: target.sectionId, folderId: target.folderId, atEnd: true, positionScope: 'project' };
    }
    // An ordinary card in a column is a stage target, not an extraction action.
    return issue.folderId ? { sectionId: target.sectionId, status: target.status, atEnd: true } : target;
  };
  const allowed = (issue: Issue | undefined) => !!issue && !issue.busy && issue.id !== target.beforeId &&
    !!destinationFor(issue) &&
    (!before || before.projectId === issue.projectId) && (!folder || folder.sectionId === issue.projectId) &&
    (!target.sectionId || (folder ? folder.sectionId === issue.projectId : context?.sectionOf(issue.projectId) === target.sectionId));
  const active = context?.over === targetId && !!source;
  const valid = allowed(source);
  const destination = source ? destinationFor(source) : target;
  const stage = issueStages.find(stage => stage.id === destination?.status)?.label;
  const label = !valid ? source?.busy ? 'Дождитесь завершения действия карточки' : destination === null ? 'Для извлечения используйте область «Без проекта»' : 'Карточки можно переносить только внутри своего раздела' :
    destination?.beforeId ? `Поставить перед этой карточкой · ${stage ?? 'этап сохранится'}` :
      destination?.folderId !== undefined ? `${folder ? `${source?.folderId === folder.id ? 'В конец проекта' : 'В проект'} «${folder.name}»` : 'Без проекта'} · этап сохранится` :
        `Сменить этап · ${stage ?? ''}${source?.folderId ? ' · проект сохранится' : ''}`;
  const bindings = {
    'data-drop-state': active ? valid ? 'allowed' : 'forbidden' : undefined,
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes('application/x-bb-kanban-issue')) return;
      // More specific targets own their event; invalid foreign drops must not
      // bubble into the containing lane and appear to succeed there.
      event.stopPropagation(); event.preventDefault();
      if (source?.id === target.beforeId) { context?.hover(null); event.dataTransfer.dropEffect = 'none'; return; }
      context?.hover(targetId);
      event.dataTransfer.dropEffect = valid ? 'move' : 'none';
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if ((!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) && active) context?.hover(null);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      const id = event.dataTransfer.getData('application/x-bb-kanban-issue');
      if (!id) return;
      event.preventDefault(); event.stopPropagation(); context?.hover(null);
      const issue = context?.issues.find(issue => issue.id === id);
      const destination = issue ? destinationFor(issue) : null;
      if (allowed(issue) && destination) void context?.drop([id], destination);
      context?.end();
    },
  };
  return { bindings, label, active, valid, dragging: !!source };
}

export function CardDropZone({ target, children, className = '', label, ...props }: {
  target: CardDestination; children?: ReactNode; className?: string; label?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, 'onDrop' | 'onDragOver'>) {
  const drop = useCardDrop(target);
  return <div {...props} {...drop.bindings} data-card-dragging={drop.dragging || undefined} className={`${className} kb-drop-zone`}>
    {children}{drop.active && <span className="kb-drop-label" role="status">{drop.label}</span>}
    {label && <span className="kb-drop-zone-caption">{label}</span>}
  </div>;
}

export function StageDropButton({ status, children, ...props }: { status: IssueStatus } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const drop = useCardDrop({ status });
  return <button {...props} {...drop.bindings}>{children}{drop.active && <span className="kb-drop-label" role="status">{drop.label}</span>}</button>;
}
