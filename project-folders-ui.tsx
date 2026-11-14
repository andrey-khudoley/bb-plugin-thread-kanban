import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { experimental_useRpcQuery, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog';
import { folderChanged, folderRpc, formatProjectDuration, projectDuration, type ProjectFolder, type ProjectMaterial, type ProjectSearchHit } from './project-folders';
import { issueStages, type Issue, type IssueStatus } from './issues';
import { useKanbanClock } from './card-work-time-ui';
import { CardMenu } from './kanban-ui';
import { restoreCardFocus, useCardDialogFocus, useCardDrop, useCardRelocation } from './project-card-actions';
import { ProjectMembers } from './project-members';
import './project-folders.css';

const control = 'w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-2 text-sm';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export function useProjectFolders() {
  const query = experimental_useRpcQuery({ contract: folderRpc, method: 'folderList', input: null });
  useRealtime(folderChanged, () => void query.refetch());
  return query;
}
export function ProjectTimer({ folder, compact = false }: { folder: Pick<ProjectFolder, 'elapsedMs' | 'activeSince'>; compact?: boolean }) {
  const now = useKanbanClock();
  const duration = projectDuration(folder, now);
  const full = formatProjectDuration(duration);
  const minutes = Math.floor(duration / 60000);
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes / 60) % 24;
  const short = days ? `${days} д ${hours} ч` : hours ? `${hours} ч ${minutes % 60} мин` : `${minutes} мин`;
  return <span className="kb-folder-timer" data-project-active-since={folder.activeSince ?? ''}
    title={`Активное время проекта: ${full}`} aria-label={`Активное время проекта: ${full}`}>
    {compact && <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M8 4.5V8l2.5 1.5" /></svg>}
    {compact ? short : full}
  </span>;
}

export type ProjectFolderTab = 'assistant' | 'materials' | 'cards';

export function ProjectFolderCard({ folder, stage, children, matching, expanded, toggle, manage, create, creating = false }: {
  folder: ProjectFolder; stage: IssueStatus | null; children: ReactNode; matching: number; expanded: boolean;
  toggle: () => void; manage: (tab: ProjectFolderTab, action?: 'add' | 'rename' | 'delete', trigger?: HTMLButtonElement | null) => void; create: () => void; creating?: boolean;
}) {
  const contentId = useId();
  const drop = useCardDrop({ sectionId: folder.sectionId, folderId: folder.id, atEnd: true, positionScope: 'project' });
  const stageLabel = issueStages.find((item) => item.id === stage)?.label;
  const label = `${folder.name}${stageLabel ? ` · ${stageLabel}` : ''}`;
  const state = folder.count === 0 ? 'Пустой' : folder.activeCount ? 'Активен' : 'Завершён';
  const countLabel = `Показано карточек: ${matching}${stageLabel ? ` · ${stageLabel}` : ''}. Всего в проекте: ${folder.count}`;
  return <article {...drop.bindings} className="kb-folder" aria-label={`Проект ${label}`} data-expanded={expanded} data-drop-target={drop.active && drop.valid}
    data-kanban-card-id={stage ? `${folder.id}:${stage}` : folder.id} data-project-folder-id={folder.id} data-kanban-kind="project"
    data-kanban-project={folder.sectionId} data-kanban-title={folder.name} data-kanban-stage={stage ?? 'project'}>
    <header className="kb-folder-heading">
      <button type="button" className="kb-folder-toggle" aria-expanded={expanded} aria-controls={contentId}
        aria-label={`${expanded ? 'Свернуть' : 'Развернуть'} проект ${label}`} title={folder.name} onClick={toggle}>
        <svg className="kb-folder-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
        <span className="kb-card-title kb-folder-name">{folder.name}</span>
      </button>
      <CardMenu label={`Действия с проектом: ${folder.name}`} groups={[{ label: 'Карточки', items: [
        { label: 'Создать карточку', disabled: creating, action: create },
        { label: 'Добавить существующие…', action: trigger => manage('cards', 'add', trigger) },
      ] }, { label: 'Проект', items: [
        { label: 'Помощник', action: trigger => manage('assistant', undefined, trigger) },
        { label: 'Материалы', action: trigger => manage('materials', undefined, trigger) },
        { label: 'Карточки', action: trigger => manage('cards', undefined, trigger) },
      ] }, { label: 'Управление', items: [
        { label: 'Переименовать…', action: trigger => manage('cards', 'rename', trigger) },
        { label: 'Удалить проект…', destructive: true, action: trigger => manage('cards', 'delete', trigger) },
      ] }]} />
      <div className="kb-folder-meta">
        <button type="button" className="kb-folder-count" title={`${countLabel}. Управление карточками`} aria-label={countLabel} onClick={event => manage('cards', undefined, event.currentTarget)}>Карточек: {matching}{matching !== folder.count && <span> / {folder.count}</span>}</button>
        <span className="kb-folder-state">{state}</span>
        <ProjectTimer folder={folder} compact />
      </div>
    </header>
    <div id={contentId} hidden={!expanded}>
      {expanded && <div className="kb-folder-cards" role="group" aria-label={`Карточки проекта ${folder.name}`}>
        {children}{matching === 0 && <div className="kb-folder-empty">
          <p>{folder.count === 0 ? 'Пока нет карточек' : 'Нет карточек по текущим фильтрам'}</p>
          <span>{folder.count === 0 ? 'Перетащите сюда карточку из этого раздела.' : 'Измените фильтры, чтобы увидеть карточки проекта.'}</span>
          {folder.count === 0 && <button type="button" className="kb-folder-empty-action" disabled={creating} onClick={create}>{creating ? 'Создаю…' : 'Создать карточку'}</button>}
        </div>}
      </div>}
    </div>
    {drop.active && <span className="kb-folder-drop-hint" role="status">{drop.label}</span>}
  </article>;
}

export function CreateCardDialog({ sectionId, close, createIssue, created }: {
  sectionId: string; close: () => void; createIssue: (status: 'backlog' | 'todo') => Promise<unknown>; created: (folder: ProjectFolder) => void;
}) {
  const rpc = useRpc<typeof folderRpc>();
  const [type, setType] = useState('task');
  const [name, setName] = useState('');
  const [status, setStatus] = useState<'backlog' | 'todo'>('backlog');
  const [pending, setPending] = useState(false);
  const guard = useRef(false);
  const [error, setError] = useState('');
  async function save() {
    if (guard.current) return;
    guard.current = true; setPending(true); setError('');
    try {
      if (type === 'project') created(await rpc.call('folderCreate', { sectionId, name }));
      else if (await createIssue(status) === null) return;
      close();
    } catch (error) { setError(message(error)); } finally { guard.current = false; setPending(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !pending) close(); }}><DialogContent className="kb-scope kb-folder-dialog">
    <DialogHeader><DialogTitle>Создать в разделе</DialogTitle><DialogDescription>Карточку можно оставить в разделе или собрать карточки в проект.</DialogDescription></DialogHeader>
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label className="block text-sm">Тип<select className={control} aria-label="Тип новой карточки" value={type} disabled={pending} onChange={(event) => setType(event.target.value)}>
        <option value="task">Задача</option><option value="project">Проект-папка</option>
      </select></label>
      {type === 'project' ? <label className="block text-sm">Название проекта<Input autoFocus aria-label="Название проекта" value={name} maxLength={180} disabled={pending} onChange={(event) => setName(event.target.value)} /></label> :
        <label className="block text-sm">Этап<select className={control} aria-label="Этап новой задачи" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
          <option value="backlog">Бэклог</option><option value="todo">К выполнению</option>
        </select></label>}
      {error && <p role="alert">{error}</p>}
      <Button type="submit" disabled={pending || (type === 'project' && !name.trim())}>{pending ? 'Создаю…' : 'Создать'}</Button>
    </form>
  </DialogContent></Dialog>;
}

export function FolderAssignment({ issue, folders, changed }: { issue: Issue; folders: ProjectFolder[]; changed?: () => void }) {
  const { move, pending } = useCardRelocation([issue], () => changed?.());
  const [error, setError] = useState('');
  return <label className="block text-sm">Проект
    <select className={control} aria-label="Проект карточки" value={issue.folderId ?? ''} disabled={pending || !!issue.busy}
      onChange={(event) => {
        setError('');
        void move([issue.id], { folderId: event.target.value || null }).then(ok => { if (!ok) setError('Перенос не выполнен. Проверьте сообщение и повторите действие.'); });
      }}>
      <option value="">Без проекта · в разделе</option>
      {folders.filter((folder) => folder.sectionId === issue.projectId).map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
    </select>{error && <span role="alert">{error}</span>}
  </label>;
}

export function ProjectFolderDialog({ id, folders, issues, close, createIssue, initialTab = 'assistant', initialAction, openCard, refreshCards, returnFocus }: {
  id: string; folders: ProjectFolder[]; issues: Issue[]; close: () => void; createIssue: (folder: ProjectFolder) => Promise<unknown>;
  initialTab?: ProjectFolderTab; initialAction?: 'add' | 'rename' | 'delete'; openCard: (issue: Issue) => void; refreshCards: () => unknown; returnFocus?: HTMLElement | null;
}) {
  const dialogId = useId();
  const renameInput = useRef<HTMLInputElement>(null);
  const initialFocusHandled = useRef(false);
  const navigated = useRef(false);
  useCardDialogFocus(returnFocus, [], navigated);
  const [messageOffset, setMessageOffset] = useState(0);
  const detail = experimental_useRpcQuery({ contract: folderRpc, method: 'folderRead', input: { id, messageOffset } });
  const folder = detail.data ?? folders.find((folder) => folder.id === id);
  const rpc = useRpc<typeof folderRpc>();
  const [tab, setTab] = useState<ProjectFolderTab>(initialTab);
  const [pending, setPending] = useState(false);
  const guard = useRef(false);
  const [error, setError] = useState('');
  const [name, setName] = useState(folder?.name ?? '');
  const [prompt, setPrompt] = useState('');
  const [edit, setEdit] = useState<Partial<ProjectMaterial> | null>(null);
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<ProjectSearchHit[] | null>(null);
  const [deleting, setDeleting] = useState(initialAction === 'delete');
  useEffect(() => {
    if (!initialAction || tab !== 'cards' || initialFocusHandled.current) return;
    const frame = requestAnimationFrame(() => {
      const target = initialAction === 'rename' ? renameInput.current : initialAction === 'delete' ? document.getElementById(`${dialogId}-delete-cancel`) :
        document.getElementById(`${dialogId}-panel`)?.querySelector<HTMLInputElement>('input[type="search"]');
      target?.focus(); if (initialAction === 'rename') renameInput.current?.select(); initialFocusHandled.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [initialAction, tab]);
  const materialQuery = experimental_useRpcQuery({ contract: folderRpc, method: 'folderMaterials', input: { folderId: id } });
  const cardActions = useCardRelocation(issues, async () => { await refreshCards(); await detail.refetch(); });
  useRealtime(folderChanged, () => { void detail.refetch(); void materialQuery.refetch(); setHits(null); });
  async function run(action: () => Promise<unknown>) {
    if (guard.current || cardActions.pending) return;
    guard.current = true; setPending(true); setError('');
    try { await action(); } catch (error) { setError(message(error)); } finally { guard.current = false; setPending(false); }
  }
  if (!folder) return null;
  return <Dialog open onOpenChange={(open) => { if (!open && !pending && !cardActions.pending) close(); }}><DialogContent className="kb-scope kb-folder-dialog"
    onCloseAutoFocus={event => event.preventDefault()} onAfterCloseAutoFocus={() => { if (!navigated.current) restoreCardFocus(returnFocus); }}>
    <DialogHeader><DialogTitle>Проект · {folder.name}</DialogTitle><DialogDescription>{folder.count} карточек · <ProjectTimer folder={folder} /></DialogDescription></DialogHeader>
    <div className="kb-folder-tabs" role="tablist" aria-label="Разделы проекта" onKeyDown={event => {
      const keys: ProjectFolderTab[] = ['assistant', 'materials', 'cards'];
      const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      const next = event.key === 'Home' ? keys[0] : event.key === 'End' ? keys[2] : delta ? keys[(keys.indexOf(tab) + delta + keys.length) % keys.length] : null;
      if (!next || pending || cardActions.pending) return; event.preventDefault(); setTab(next); setDeleting(false); document.getElementById(`${dialogId}-${next}`)?.focus();
    }}>
      {([['assistant', 'Помощник'], ['materials', 'Материалы'], ['cards', 'Карточки']] as const).map(([key, label]) =>
        <Button key={key} id={`${dialogId}-${key}`} aria-controls={`${dialogId}-panel`} tabIndex={tab === key ? 0 : -1} disabled={pending || cardActions.pending}
          variant={tab === key ? 'secondary' : 'ghost'} role="tab" aria-selected={tab === key} onClick={() => { setTab(key); setDeleting(false); }}>{label}</Button>)}
    </div>
    <div className="kb-folder-dialog-scroll" id={`${dialogId}-panel`} aria-labelledby={`${dialogId}-${tab}`} role="tabpanel">
      {(error || cardActions.error || folder.error || materialQuery.error || detail.error) && <p role="alert">{error || cardActions.error || folder.error || message(materialQuery.error || detail.error)}</p>}
      {tab === 'assistant' && <div className="space-y-3">
        <p className="text-xs text-muted-foreground">Помощник проекта использует общие материалы с источниками. Попросите подготовить и сохранить материал, чтобы добавить его всем карточкам.</p>
        <div className="flex gap-2">
          {detail.data?.nextMessageOffset != null && <Button variant="ghost" size="sm" onClick={() => setMessageOffset(detail.data!.nextMessageOffset!)}>Ранние сообщения</Button>}
          {messageOffset > 0 && <Button variant="ghost" size="sm" onClick={() => setMessageOffset(0)}>Последние сообщения</Button>}
        </div>
        {folder.messages.map((entry, index) => <div key={index} className="kb-folder-message"><b>{entry.role === 'user' ? 'Вы' : 'Помощник'}</b><p>{entry.text}</p></div>)}
        {folder.assistant && <p role="status">Помощник готовит ответ…</p>}
        <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
          const updated = await rpc.call('folderAsk', { id, text: prompt }); if (!updated.error) { setPrompt(''); setMessageOffset(0); void detail.refetch(); }
        }); }} className="space-y-2">
          <textarea className={control} rows={4} aria-label="Сообщение помощнику проекта" value={prompt} maxLength={12000} onChange={(event) => setPrompt(event.target.value)} />
          <Button type="submit" disabled={pending || !!folder.assistant || !prompt.trim()}>Отправить</Button>
        </form>
      </div>}
      {tab === 'materials' && <div className="space-y-3">
        <p className="text-xs text-muted-foreground">Заметки и файлы UTF-8: TXT, MD, CSV, JSON, HTML, до 1 МБ каждый. Индекс доступен только карточкам текущего проекта.</p>
        {materialQuery.isLoading && <p role="status">Загрузка материалов…</p>}
        {(materialQuery.data ?? []).map((item) => <div key={item.id} className="kb-folder-material">
          <button type="button" disabled={pending} onClick={() => void run(async () => setEdit(await rpc.call('folderMaterialRead', { id: item.id })))}>{item.title}</button>
          <span>v{item.version} · {item.status === 'ready' ? `В индексе · ${item.chunks} фрагм.` : item.status === 'processing' ? 'Индексация…' : 'Ошибка индексации'}</span>
          {item.error && <span role="alert">{item.error}</span>}
        </div>)}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={pending} onClick={() => setEdit({ title: '', text: '', format: 'md' })}>Добавить заметку</Button>
          <label className="kb-folder-upload">Добавить файл<input type="file" aria-label="Добавить файл в проект" accept=".txt,.md,.csv,.json,.html,.htm" disabled={pending}
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
              void run(async () => {
                if (file.size > 1_000_000) throw new Error('Размер файла превышает 1 МБ.');
                const ext = file.name.split('.').at(-1)?.toLowerCase();
                const format = ext === 'htm' ? 'html' : ext;
                if (!['txt','md','csv','json','html'].includes(format ?? '')) throw new Error('Этот формат не поддерживается.');
                const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
                await rpc.call('folderMaterialSave', { folderId: id, title: file.name.slice(0,180), text, format: format as ProjectMaterial['format'] });
              });
            }} /></label>
        </div>
        {edit && <form className="space-y-2 rounded border p-2" onSubmit={(event) => { event.preventDefault(); void run(async () => {
          await rpc.call('folderMaterialSave', { folderId: id, title: edit.title ?? '', text: edit.text ?? '', format: edit.format ?? 'md', ...(edit.id ? { id: edit.id, version: edit.version } : {}) });
          setEdit(null);
        }); }}>
          <Input aria-label="Название материала" value={edit.title ?? ''} maxLength={180} onChange={(event) => setEdit({ ...edit, title: event.target.value })} />
          <textarea className={control} aria-label="Текст материала" rows={8} maxLength={1_000_000} value={edit.text ?? ''} onChange={(event) => setEdit({ ...edit, text: event.target.value })} />
          <div className="flex flex-wrap gap-2"><Button type="submit" disabled={pending || !edit.title?.trim()}>Сохранить и индексировать</Button>
            <Button variant="ghost" type="button" onClick={() => setEdit(null)} disabled={pending}>Отмена</Button>
            {edit.id && <Button variant="destructive" type="button" disabled={pending} onClick={() => void run(async () => {
              await rpc.call('folderMaterialDelete', { id: edit.id!, version: edit.version! }); setEdit(null);
            })}>Удалить материал</Button>}
          </div>
        </form>}
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void run(async () => setHits(await rpc.call('folderSearch', { folderId: id, query: search }))); }}>
          <Input aria-label="Поиск по материалам проекта" placeholder="Найти в материалах" value={search} maxLength={2000} onChange={(event) => setSearch(event.target.value)} />
          <Button type="submit" disabled={pending || !search.trim()}>Найти</Button>
        </form>
        {hits && !hits.length && <p role="status">Фрагменты не найдены.</p>}
        {hits?.map((hit) => <div key={`${hit.materialId}:${hit.chunk}`} className="kb-folder-message"><b>{hit.title} · v{hit.version} · фрагмент {hit.chunk}</b><p>{hit.text}</p></div>)}
      </div>}
      <div className="space-y-3" hidden={tab !== 'cards'}>
        <ProjectMembers folder={folder} issues={issues} folders={folders} initialAdd={initialAction === 'add'} openCard={issue => { navigated.current = true; openCard(issue); }}
          actions={cardActions} creating={pending}
          create={() => void run(async () => { const result = await createIssue(folder); if (result !== null) { navigated.current = true; close(); } })} />
        <details className="kb-project-settings" open={initialAction === 'rename' || initialAction === 'delete'}>
          <summary>Настройки проекта</summary>
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void run(() => rpc.call('folderRename', { id, name, version: folder.version })); }}>
          <Input ref={renameInput} aria-label="Новое название проекта" value={name} maxLength={180} onChange={(event) => setName(event.target.value)} />
          <Button type="submit" disabled={pending || !name.trim() || name === folder.name}>Переименовать</Button>
        </form>
        <div className="space-y-2" role="group" aria-label="Удаление проекта">
          {!deleting ? <Button variant="ghost" disabled={pending} onClick={() => setDeleting(true)}>Удалить проект…</Button> : <>
            <p>Удалить проект «{folder.name}»? Карточки ({folder.count}) останутся в разделе на своих этапах. Материалы проекта и диалог помощника будут удалены.</p>
            {folder.assistant && <p role="status">Помощник проекта готовит ответ. Удаление будет доступно после завершения.</p>}
            <div className="flex flex-wrap gap-2">
              <Button variant="destructive" disabled={pending || !!folder.assistant} onClick={() => void run(async () => {
                await rpc.call('folderDelete', { id, version: folder.version }); close();
              })}>Удалить проект, сохранив карточки</Button>
              <Button id={`${dialogId}-delete-cancel`} variant="ghost" disabled={pending} onClick={() => setDeleting(false)}>Отмена удаления</Button>
            </div>
          </>}
        </div>
        </details>
      </div>
    </div>
    {cardActions.canUndo && <div className="kb-project-undo" role="status"><span>Перенос выполнен</span><Button variant="outline" size="sm" disabled={cardActions.pending} onClick={() => void cardActions.undo()}>Отменить перенос</Button></div>}
  </DialogContent></Dialog>;
}
