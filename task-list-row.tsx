import { useId, useState, type HTMLAttributes, type ReactNode } from "react";
import { CardMenu, isCardBackgroundClick, type CardActionGroup } from "./kanban-ui";

/** The primary button and every secondary control are siblings, never nested. */
export function TaskListRow({ id, kind, projectId, title, stage, stageLabel, summary, updatedAt,
  signals, details, groups, selected, chatOpen, chatActive, open, toggle, drag }: {
  id: string; kind: "issue" | "thread"; projectId: string; title: string;
  stage: string; stageLabel: string; summary: string; updatedAt: number;
  signals?: ReactNode; details: ReactNode; groups: readonly CardActionGroup[];
  selected?: boolean; chatOpen: boolean; chatActive: boolean; open: () => void; toggle: () => void;
  drag?: Pick<HTMLAttributes<HTMLElement>, "onDragStart" | "onDragOver" | "onDrop">;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const selectionMode = selected !== undefined;
  const primary = selectionMode ? toggle : open;
  return (
    <article className="kb-card kb-list-row bg-card" data-selected={selected} draggable={!!drag} {...drag}
      data-chat-open={chatOpen} data-chat-active={chatActive}
      data-kanban-card-id={id} data-kanban-kind={kind} data-kanban-project={projectId} data-kanban-stage={stage}
      onClick={(event) => { if (isCardBackgroundClick(event)) primary(); }}
      onClickCapture={(event) => {
        if ((event.ctrlKey || event.metaKey) && (isCardBackgroundClick(event) ||
          (event.target instanceof Element && event.target.closest(".kb-list-open")))) {
          event.preventDefault(); event.stopPropagation(); toggle();
        }
      }}>
      <div className="kb-list-heading">
        {selectionMode && <label className="kb-list-select">
          <input type="checkbox" aria-label={`Выбрать ${kind === "issue" ? "задачу" : "чат"}: ${title}`}
            checked={selected} onChange={toggle} />
        </label>}
        <button type="button" className="kb-list-open" onClick={primary}
          aria-label={selectionMode ? `${selected ? "Снять выбор" : "Выбрать"}: ${title}` : `Открыть: ${title}`}>
          <span className="kb-card-title">{title}</span>
          <span className="kb-list-open-arrow" aria-hidden="true">›</span>
        </button>
      </div>
      <div className="kb-list-state">
        <span className="kb-list-status" data-stage={stage}>{stageLabel}</span>
        {signals && <div className="kb-list-signals">{signals}</div>}
      </div>
      <div className="kb-list-context">
        <span>{summary}</span>
        <time dateTime={new Date(updatedAt).toISOString()}>
          Обновлено {new Date(updatedAt).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}
        </time>
      </div>
      <div className="kb-list-actions">
        <button type="button" className="kb-list-disclosure" aria-expanded={expanded} aria-controls={detailsId}
          aria-label={`${expanded ? "Скрыть сведения" : "Подробнее"}: ${title}`} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Скрыть" : "Подробнее"}<span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
        </button>
        <CardMenu label={`Действия с ${kind === "issue" ? "задачей" : "чатом"}: ${title}`}
          triggerLabel="Действия" groups={groups} />
      </div>
      {expanded && <div id={detailsId} className="kb-list-details" data-no-card-open>{details}</div>}
    </article>
  );
}
