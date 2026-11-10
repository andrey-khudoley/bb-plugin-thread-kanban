import { useRef, type MouseEvent } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { usePortalScopeProps } from "./lib/portal-scope";
import { isTestTag, testTag } from "./planning";

export function TagBadge({ tag }: { tag: string }) {
  return isTestTag(tag)
    ? <span className="kb-badge bg-yellow-400 font-semibold text-yellow-950" title={testTag}>{testTag}</span>
    : <span className="kb-badge bg-muted" title={tag}>{tag}</span>;
}

const paths = {
  search: "m21 21-4.3-4.3M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  board: "M4 5h16v14H4zM9.3 5v14m5.4-14v14",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  filters: "M4 6h16M7 12h10m-7 6h4",
  merge: "M6 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 4v10m0 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM18 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 4a6 6 0 0 1-6 6H6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  check: "M5 12l4 4L19 6",
  close: "m6 6 12 12M18 6 6 18",
  chevronUp: "m6 15 6-6 6 6",
  plus: "M12 5v14M5 12h14",
  link: "M10 13a4 4 0 0 0 6 .4l4-4a4 4 0 0 0-5.7-5.7l-2 2m1.7 5.3a4 4 0 0 0-6-.4l-4 4a4 4 0 0 0 5.7 5.7l2-2",
  chat: "M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l1.8-3.6A7.5 7.5 0 1 1 20 11.5Z",
  tools: "m14 6 4 4m-9 4-5 5 1 1 5-5M14 3a6 6 0 0 0-7 7l7 7a6 6 0 0 0 7-7l-4 2-5-5 2-4Z",
} as const;

export function KanbanIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={name === "more" ? 3 : 1.75} strokeLinecap="round" strokeLinejoin="round"
      className="shrink-0" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

export type CardAction = { id?: string; label: string; action: (trigger: HTMLButtonElement | null) => void; destructive?: boolean; disabled?: boolean };
export type CardActionGroup = { label: string; items: readonly CardAction[] };

export function CardMenu({ label, triggerLabel, triggerIcon, groups }: {
  label: string;
  triggerLabel?: string;
  triggerIcon?: keyof typeof paths;
  groups: readonly CardActionGroup[];
}) {
  const scope = usePortalScopeProps();
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <button ref={trigger} type="button" className={triggerLabel ? "kb-detail-tools" : "kb-icon-button"} aria-label={label} title={label}>
          {triggerIcon && <span className="kb-mobile-tool-icon"><KanbanIcon name={triggerIcon} /></span>}
          {triggerLabel ? <span className={triggerIcon ? "kb-tool-label" : undefined}>{triggerLabel}</span> : <KanbanIcon name="more" />}
          {triggerLabel && <span className="kb-detail-caret" aria-hidden="true" />}
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content {...scope} align="end" sideOffset={5} collisionPadding={12}
          className="kb-menu z-[100] min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg">
          {groups.filter(({ items }) => items.length).map((group, index) => (
            <Dropdown.Group key={group.label}>
              {index > 0 && <Dropdown.Separator className="mx-1 my-1 border-t border-border" />}
              <Dropdown.Label className="px-2 py-1 text-xs text-muted-foreground">{group.label}</Dropdown.Label>
              {group.items.map((item) => (
                <Dropdown.Item key={item.id ?? item.label} onSelect={() => item.action(trigger.current)} disabled={item.disabled}
                  className={`cursor-default rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:opacity-50 ${item.destructive ? "text-destructive" : ""}`}>
                  {item.label}
                </Dropdown.Item>
              ))}
            </Dropdown.Group>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

export function isCardBackgroundClick({ target, currentTarget, defaultPrevented }: MouseEvent<HTMLElement>) {
  return !defaultPrevented && target instanceof Element && currentTarget.contains(target) &&
    !target.closest("button, a, input, label, select, textarea, summary, [data-no-card-open]");
}

export function ViewSwitch({ label, options, variant }: {
  label: string;
  options: readonly { name: string; icon?: "board" | "list"; accent?: boolean; selected: boolean; select: () => void; disabled?: boolean }[];
  variant?: "sections" | "subsections";
}) {
  return (
    <div role="group" aria-label={label} className={variant ? `kb-detail-${variant}` : "kb-switch"}>
      {options.map((option) => (
        <button key={option.name} type="button" aria-pressed={option.selected} data-accent={option.accent}
          disabled={option.disabled} onClick={option.select}>
          {option.icon && <KanbanIcon name={option.icon} />}
          {option.name}
        </button>
      ))}
    </div>
  );
}
