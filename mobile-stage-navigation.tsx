import * as Dropdown from "@radix-ui/react-dropdown-menu";
import type { DragEvent } from "react";
import { KanbanIcon } from "./kanban-ui";
import { usePortalScopeProps } from "./lib/portal-scope";
import { StageHeading } from "./stage-heading";

export type MobileStage = { id: string; label: string; dot: string; count: number };

export function MobileStageNavigation({ stages, value, onChange, onDropStage }: {
  stages: readonly MobileStage[];
  value: string;
  onChange: (id: string) => void;
  onDropStage?: (id: string, event: DragEvent<HTMLElement>) => void;
}) {
  const scope = usePortalScopeProps();
  const index = Math.max(0, stages.findIndex((stage) => stage.id === value));
  const current = stages[index];
  if (!current) return null;
  const previous = stages[index - 1], next = stages[index + 1];
  const dropProps = (id: string) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (event.dataTransfer.types.includes("application/x-bb-kanban-issue")) event.preventDefault();
    },
    onDrop: (event: DragEvent<HTMLElement>) => onDropStage?.(id, event),
  });
  return <nav className="kb-mobile-stage-nav border-b border-border" aria-label="Переключение этапов доски">
    <button type="button" className="kb-stage-previous" disabled={!previous}
      aria-label={previous ? `Предыдущий этап: ${previous.label}` : "Предыдущий этап"}
      onClick={() => previous && onChange(previous.id)} {...(previous && dropProps(previous.id))}>
      <KanbanIcon name="chevronUp" />
    </button>
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <button type="button" className="kb-stage-current kb-stage-heading" data-stage={current.id}
          title={current.label} aria-label={`Этап доски: ${current.label}, карточек ${current.count}`}>
          <StageHeading label={current.label} count={current.count} />
          <span className="kb-stage-caret"><KanbanIcon name="chevronUp" /></span>
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content {...scope} className="kb-stage-menu" align="center" sideOffset={4} collisionPadding={12}>
          <Dropdown.Label className="kb-stage-menu-label">Этапы доски</Dropdown.Label>
          <Dropdown.RadioGroup value={current.id} onValueChange={onChange}>
            {stages.map((stage) => <Dropdown.RadioItem key={stage.id} value={stage.id}
              className="kb-stage-option kb-stage-heading" data-stage={stage.id} title={stage.label} {...dropProps(stage.id)}>
              <StageHeading label={stage.label} count={stage.count} />
              <span className="kb-stage-selected"><Dropdown.ItemIndicator><KanbanIcon name="check" /></Dropdown.ItemIndicator></span>
            </Dropdown.RadioItem>)}
          </Dropdown.RadioGroup>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
    <button type="button" className="kb-stage-next" disabled={!next}
      aria-label={next ? `Следующий этап: ${next.label}` : "Следующий этап"}
      onClick={() => next && onChange(next.id)} {...(next && dropProps(next.id))}>
      <KanbanIcon name="chevronUp" />
    </button>
  </nav>;
}
