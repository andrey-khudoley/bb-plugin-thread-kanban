import { useRef, useState } from 'react';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { CardMenu } from './kanban-ui';
import { issueStages, type Issue, type IssueStatus } from './issues';
import { type ProjectFolder } from './project-folders';
import { MoveCardsDialog, type useCardRelocation } from './project-card-actions';

export function ProjectMembers({ folder, issues, folders, initialAdd = false, openCard, create, actions, creating = false }: {
  folder: ProjectFolder; issues: Issue[]; folders: ProjectFolder[]; initialAdd?: boolean;
  openCard: (issue: Issue) => void; create: () => void; actions: ReturnType<typeof useCardRelocation>; creating?: boolean;
}) {
  const [adding, setAdding] = useState(initialAdd);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState<string[] | null>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const { move, pending } = actions;
  const members = issues.filter(issue => issue.folderId === folder.id);
  const candidates = issues.filter(issue => issue.projectId === folder.sectionId && (adding ? issue.folderId !== folder.id : issue.folderId === folder.id));
  const shown = candidates.filter(issue => `${issue.title} ${issueStages.find(stage => stage.id === issue.status)?.label ?? ''}`.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')));
  const chosen = candidates.filter(issue => selected.has(issue.id) && !issue.busy);
  const toggle = (id: string) => setSelected(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const changeMode = (next: boolean) => { setAdding(next); setSelected(new Set()); setQuery(''); };
  const transfer = async (ids: string[], folderId: string | null) => {
    if (await move(ids, { folderId })) { setSelected(new Set()); if (adding) changeMode(false); }
  };
  return <section className="kb-project-members" aria-label="Состав проекта">
    <div className="flex flex-wrap gap-2">
      <Button variant={!adding ? 'secondary' : 'ghost'} aria-pressed={!adding} onClick={() => changeMode(false)}>В проекте · {members.length}</Button>
      <Button variant={adding ? 'secondary' : 'outline'} aria-pressed={adding} onClick={() => changeMode(true)}>Добавить существующие</Button>
      <Button variant="outline" disabled={pending || creating} onClick={create}>{creating ? 'Создаю…' : 'Создать карточку'}</Button>
    </div>
    <p className="text-xs text-muted-foreground">{adding ? 'Выберите карточки этого раздела. При добавлении их этапы сохранятся.' : 'Откройте карточку, измените этап или выберите несколько для переноса. Чаты и история сохраняются.'}</p>
    <Input type="search" aria-label={adding ? 'Найти карточки для добавления' : 'Найти карточку в проекте'} placeholder="Поиск по названию или этапу" value={query} onChange={event => setQuery(event.target.value)} />
    <div className="kb-members-selection" role="group" aria-label="Выбор карточек проекта">
      <Button size="sm" variant="ghost" disabled={pending || !shown.some(issue => !issue.busy)} onClick={() => setSelected(new Set(shown.filter(issue => !issue.busy).slice(0, 200).map(issue => issue.id)))}>Выбрать показанные</Button>
      {!!chosen.length && <><span>Выбрано: {chosen.length}</span>
        {adding ? <Button size="sm" disabled={pending} onClick={() => void transfer(chosen.map(issue => issue.id), folder.id)}>Добавить в проект</Button> : <>
          <Button size="sm" variant="outline" disabled={pending} onClick={event => { returnFocus.current = event.currentTarget; setMoving(chosen.map(issue => issue.id)); }}>Переместить…</Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => void transfer(chosen.map(issue => issue.id), null)}>Убрать из проекта</Button>
        </>}
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setSelected(new Set())}>Снять выбор</Button>
      </>}
    </div>
    {!shown.length && <p role="status" className="kb-members-empty">{query ? 'Ничего не найдено. Измените запрос.' : adding ? 'Все карточки раздела уже в этом проекте.' : 'В проекте пока нет карточек. Создайте новую или добавьте существующие.'}</p>}
    <ul className="kb-members-list">
      {shown.map(issue => <li key={issue.id} className="kb-member-row">
        <input type="checkbox" aria-label={`Выбрать карточку: ${issue.title || 'Без названия'}`} disabled={pending || !!issue.busy || (!selected.has(issue.id) && chosen.length >= 200)} checked={selected.has(issue.id)} onChange={() => toggle(issue.id)} />
        <div className="kb-member-content"><button type="button" className="kb-member-title" onClick={() => openCard(issue)}>{issue.title || 'Без названия'}</button>
          {adding ? <span className="kb-member-context">{issueStages.find(stage => stage.id === issue.status)?.label} · {folders.find(item => item.id === issue.folderId)?.name ?? 'Без проекта'}</span> :
            <select aria-label={`Этап карточки: ${issue.title || 'Без названия'}`} className="kb-member-stage" value={issue.status} disabled={pending || !!issue.busy}
              onChange={event => { void move([issue.id], { status: event.target.value as IssueStatus }); }}>
              {issueStages.map(stage => <option key={stage.id} value={stage.id}>{stage.label}</option>)}
            </select>}
        </div>
        <CardMenu label={`Действия с карточкой проекта: ${issue.title || 'Без названия'}`} groups={[{ label: 'Карточка', items: [
          { label: 'Открыть карточку', action: () => openCard(issue) },
          { label: 'Переместить…', disabled: pending || !!issue.busy, action: trigger => { returnFocus.current = trigger; setMoving([issue.id]); } },
          ...(adding ? [{ label: 'Добавить в проект', disabled: pending || !!issue.busy, action: () => { void transfer([issue.id], folder.id); } }] :
            [{ label: 'Убрать из проекта', disabled: pending || !!issue.busy, action: () => { void transfer([issue.id], null); } }]),
        ] }]} />
      </li>)}
    </ul>
    {moving && <MoveCardsDialog cards={issues.filter(issue => moving.includes(issue.id))} folders={folders} move={move} returnFocus={returnFocus.current}
      onMoved={() => setSelected(new Set())} close={() => setMoving(null)} />}
  </section>;
}
