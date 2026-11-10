import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
import { CardMenu, isCardBackgroundClick, TagBadge, type CardAction } from "./kanban-ui";
import { contextActions, type OpenDerivation } from "./derive-dialog";
import { issueStages, type Issue } from "./issues";
import { WorktreeBadge, type WorktreeStatuses } from "./merge-ui";
import { isTestTag, testTag } from "./planning";
import { useChatHighlight } from "./open-chats-ui";

export function issueAncestors(issue: Issue, issues: ReadonlyMap<string, Issue>) {
  const path: Issue[] = [];
  const seen = new Set([issue.id]);
  let parentId = issue.parentId;
  while (parentId && !seen.has(parentId)) {
    const parent = issues.get(parentId);
    if (!parent) break;
    seen.add(parentId);
    path.push(parent);
    parentId = parent.parentId;
  }
  return path.reverse();
}

export const issueTitle = (issue: Issue) => issue.title || "Новая задача";

type TreeActions = {
  openTask: (issue: Issue) => void;
  openTree: (id: string) => void;
  derive: OpenDerivation;
  remove: (issue: Issue) => void;
  chatActions?: (issue: Issue) => CardAction[];
  selection?: ReadonlySet<string> | null;
  select?: (id: string) => void;
  worktrees?: WorktreeStatuses;
};

export function IssueTree({ root, issues, ...actions }: { root: Issue; issues: Issue[] } & TreeActions) {
  const children = new Map<string, Issue[]>();
  for (const issue of issues) {
    if (!issue.parentId) continue;
    const siblings = children.get(issue.parentId) ?? [];
    siblings.push(issue);
    children.set(issue.parentId, siblings);
  }
  const path = [...issueAncestors(root, new Map(issues.map((issue) => [issue.id, issue]))), root];
  return (
    <div className="min-w-0 space-y-2">
      {path.length > 1 && (
        <nav aria-label="Путь в дереве задач" className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
          {path.map((issue, index) => (
            <span key={issue.id} className="flex min-w-0 max-w-full items-center gap-1.5">
              {index > 0 && <span aria-hidden="true" className="text-muted-foreground">/</span>}
              {issue.id === root.id
                ? <span aria-current="page" className="truncate" title={issueTitle(issue)}>{issueTitle(issue)}</span>
                : <button type="button" className="truncate text-muted-foreground hover:text-foreground"
                  title={issueTitle(issue)} onClick={() => actions.openTree(issue.id)}>{issueTitle(issue)}</button>}
            </span>
          ))}
        </nav>
      )}
      <ul className="rounded-lg border border-border p-1.5">
        <TreeNode key={root.id} issue={root} depth={0} childrenById={children} {...actions} />
      </ul>
    </div>
  );
}

function TreeNode({ issue, depth, childrenById, ...actions }: {
  issue: Issue; depth: number; childrenById: ReadonlyMap<string, Issue[]>;
} & TreeActions) {
  const { openTask, openTree, derive, remove, chatActions, selection, select, worktrees } = actions;
  const navigate = useBbNavigate();
  const [expanded, setExpanded] = useState(depth < 3);
  const children = childrenById.get(issue.id) ?? [];
  const stage = issueStages.find(({ id }) => id === issue.status)!;
  const title = issueTitle(issue);
  const chatId = issue.threadIds.at(-1);
  const { chatOpen, chatActive } = useChatHighlight(issue.threadIds);
  return (
    <li className="min-w-0">
      <div className="kb-tree-node rounded-md p-1 hover:bg-state-hover" data-selected={selection?.has(issue.id)} data-chat-open={chatOpen} data-chat-active={chatActive}
        data-kanban-card-id={issue.id} data-kanban-kind="issue" data-kanban-project={issue.projectId}
        data-kanban-stage={issue.status} data-kanban-title={title}
        onClick={(event) => { if (isCardBackgroundClick(event)) openTask(issue); }}
        onClickCapture={(event) => {
          if (!select || (!event.ctrlKey && !event.metaKey)) return;
          event.preventDefault();
          event.stopPropagation();
          select(issue.id);
        }}>
        {selection && <input type="checkbox" className="mt-1.5" aria-label={`Выбрать задачу: ${title}`}
          checked={selection.has(issue.id)} onChange={() => select?.(issue.id)} />}
        {children.length ? (
          <Button size="icon" variant="ghost" className="size-6 shrink-0" aria-expanded={expanded}
            aria-label={`${expanded ? "Свернуть" : "Раскрыть"} подзадачи: ${title}`} onClick={() => setExpanded(!expanded)}>
            <Icon name={expanded ? "ChevronDown" : "ChevronRight"} />
          </Button>
        ) : <span className="w-6 shrink-0" />}
        <div className="min-w-0 flex-1">
          <button type="button" className="kb-card-title text-left font-medium"
            title={title} onClick={() => openTask(issue)}>{title}</button>
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><span className={`size-1.5 rounded-full ${stage.dot}`} />{stage.label}</span>
            {children.length > 0 && <span>Подзадач · {children.length}</span>}
            {issue.origin && <span>{issue.origin.mode === "decompose" ? "Декомпозиция" : "Порождена из контекста"}</span>}
            {issue.tags.some(isTestTag) && <TagBadge tag={testTag} />}
            {issue.threadIds.map((id) => <WorktreeBadge key={id} status={worktrees?.[id]} />)}
            {chatId && <button type="button" className="text-primary"
              onClick={() => navigate.toPluginPanel("board", { subPath: `branch/${chatId}` })}>Ветка чата</button>}
          </div>
        </div>
        <div className="kb-card-tools">
          <CardMenu label={`Действия с задачей: ${title}`} groups={[
            { label: "Навигация", items: [{ label: "Открыть ветку задачи", action: () => openTree(issue.id) }] },
            contextActions({ kind: "issue", id: issue.id }, title, derive),
            { label: "Связанные чаты", items: chatActions?.(issue) ?? [] },
            { label: "Управление карточкой", items: [{ label: "Удалить карточку", destructive: true, action: () => remove(issue) }] },
          ]} />
        </div>
      </div>
      {expanded && children.length > 0 && (
        <ul className="kb-tree-children border-l border-border">
          {children.map((child) => <TreeNode key={child.id} issue={child} depth={depth + 1} childrenById={childrenById}
            {...actions} />)}
        </ul>
      )}
    </li>
  );
}
