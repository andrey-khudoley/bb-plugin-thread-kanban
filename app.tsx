import { useEffect, useMemo, useRef, useState } from "react";
import { KanbanAgentBridge, setAgentGeneration, useAgentView } from "./agent-ui";
import { registerSettingsUi } from "./settings-ui";
import {
  definePluginApp,
  experimental_useAppPanel,
  experimental_useRpcKeyedQuery,
  experimental_useRpcQuery,
  experimental_useSidebarThreads,
  experimental_useThreadActions,
  useBbNavigate,
  useSdk,
  useRealtime,
  useRpc,
  type PluginSidebarThread as Thread,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import * as Popover from "@radix-ui/react-popover";
import { z } from "zod";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
import { Input } from "./components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "./components/ui/dialog";
import { ancestorsOf, columns, descendantIds, indexThreads, stageOf, type ThreadIndex } from "./board";
import { openChatWorkspace, workspaceTab } from "./workspace";
import { planChanged, planRpc, priorities, type Plan } from "./planning";
import { initialIssueStatus, issueRpc, issueStages, issueStatus, personalProjectId, type Issue, type IssueStatus } from "./issues";
import { issueTab, openIssue, useIssues } from "./issue-panel";
import { DeleteIssueDialog } from "./delete-issue-dialog";
import { CardMenu, isCardBackgroundClick, KanbanIcon, TagBadge, ViewSwitch, type CardAction, type CardActionGroup } from "./kanban-ui";
import { contextActions, DeriveDialog, type DeriveDialogRequest, type OpenDerivation } from "./derive-dialog";
import { useDerivationActivity } from "./derive-activity";
import { StatusContribution } from "./status-contribution";
import { GlobalStatusBar } from './status-bar';
import { IssueTree, issueTitle } from "./issue-tree";
import { useChatTree, type ChatNode } from "./chat-tree";
import { archiveChanged, archiveRpc } from "./chat-archive";
import { useOpenMerge, useWorktreeStates, WorktreeBadge, type WorktreeStatuses } from "./merge-ui";
import { MergeCenter } from "./merge-center";
import { usePortalScopeProps } from "./lib/portal-scope";
import { useChatHighlight } from "./open-chats-ui";
import { ContextPanel, LegacyIssuePanel, LegacyWorkspacePanel, PanelContextBridge, mountPanelStyles } from "./panel-context-ui";
import { contextTab, createPanelTab, setContextPluginId } from "./panel-context-actions";
import { orderProjects } from "./project-order";
import { projectRpc, projectsChanged } from "./projects";
import { ProjectDialog, type ProjectDialogTarget } from "./project-dialog";
import { CreateProjectDialog, type CreatedProject } from "./create-project-dialog";
import { WindowPlacementBridge } from "./window-placement-ui";
import "./kanban.css";
import "./mobile-headers.css";
import "./desktop-headers.css";
import "./side-panel-headers.css";
import "./stage-heading.css";
import { StageHeading } from "./stage-heading";
import { MobileStageNavigation } from "./mobile-stage-navigation";
import { TaskListRow } from "./task-list-row";
import { compareListItems } from "./task-list-order";
import { useListViewContext } from "./list-view-context";
import "./task-list.css";
import "./artifact-tabs.css";

type Operation = { kind: "fork" | "move"; thread: ChatNode };
type StartOperation = (kind: Operation["kind"], thread: ChatNode) => void;
type ArchiveTarget = Pick<ChatNode, "id" | "isArchived">;
type ChangeArchive = (thread: ArchiveTarget) => void;
type Index = ThreadIndex<Thread>;

const noArchiveParents: Readonly<Record<string, string>> = {};
const panelPath = "board";
const issueDragType = "application/x-bb-kanban-issue";
const columnPreferencesKey = "thread-kanban:collapsed-stages";
const viewPreferencesKey = "thread-kanban:board-view";
const foldedColumnWidth = 2.625;
const openColumnMinWidth = 12.5;
const columnGap = 0.5;
const headingByStage = new Map(columns.map((column) => [column.id, column]));
const legacyStage = { new: "backlog", working: "working", waiting: "working", done: "done" } as const;
const viewPreferences = z.object({
  listView: z.boolean().default(false),
  focusedStage: issueStatus.nullable().default(null),
  projectId: z.string().default(""),
  query: z.string().default(""),
  tagFilter: z.string().default(""),
  assigneeFilter: z.string().default(""),
  priorityFilter: z.string().default(""),
  sort: z.string().default("updated"),
  showSubtasks: z.boolean().default(true),
  hideBlocked: z.boolean().default(false),
  showCancelled: z.boolean().default(false),
  attentionOnly: z.boolean().default(false),
  archive: z.boolean().default(false),
  hidden: z.boolean().default(false),
});

function readViewPreferences() {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(viewPreferencesKey) ?? "{}");
    const parsed = viewPreferences.safeParse(saved);
    if (parsed.success) return parsed.data;
  } catch {
    // The board also works where browser storage is unavailable.
  }
  return viewPreferences.parse({});
}

function readCollapsedStages(): ReadonlySet<IssueStatus> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(columnPreferencesKey) ?? "[]");
    const parsed = issueStatus.array().safeParse(saved);
    if (parsed.success) return new Set(parsed.data);
  } catch {
    // The board also works where browser storage is unavailable.
  }
  return new Set();
}

function StageLabel({ thread }: { thread: ChatNode }) {
  const column = headingByStage.get(stageOf(thread))!;
  const failed = thread.status === "error" || thread.queuedWork === "failed";
  return (
    <span className={`shrink-0 text-xs ${failed ? "text-destructive" : column.color}`}>
      {failed ? "Ошибка" : column.label}
    </span>
  );
}

function archiveAction(thread: ArchiveTarget, changeArchive: ChangeArchive, suffix = ""): CardAction {
  return {
    id: thread.id,
    label: (thread.isArchived ? "Разархивировать чат" : "Архивировать чат") + suffix,
    action: () => changeArchive(thread),
  };
}

function archiveActions(thread: ChatNode, changeArchive: ChangeArchive): CardAction[] {
  return stageOf(thread) === "done" ? [archiveAction(thread, changeArchive)] : [];
}

function useDeleteChatActions(thread: ChatNode) {
  const [entry] = experimental_useThreadActions({
    ...thread,
    environment: thread.environment?.id ? { id: thread.environment.id, path: thread.environment.path } : null,
  }, { keys: ["bb--core/delete"] });
  if (!entry || entry.action.disabled) return [];
  return [{ label: "Удалить чат", destructive: true, action: () => void entry.action.run() }];
}

function ThreadCard({ thread, index, start, plan, createIssue, derive, selection, toggle, worktrees, changeArchive, listView = false }: {
  thread: Thread; index: Index; start: StartOperation; plan?: Plan; createIssue: () => void; derive: OpenDerivation;
  listView?: boolean; selection: ReadonlySet<string> | null; toggle: (id: string) => void; worktrees: WorktreeStatuses; changeArchive: ChangeArchive;
}) {
  const { chatOpen, chatActive } = useChatHighlight([thread.id]);
  const panel = experimental_useAppPanel();
  const navigate = useBbNavigate();
  const deleteActions = useDeleteChatActions(thread);
  const branchCount = index.children.has(thread.id) ? descendantIds(thread.id, index).size : 0;
  const ancestors = ancestorsOf(thread, index);
  const path = ancestors.map((parent) => parent.displayTitle).join(" / ");
  const parent = ancestors.at(-1);
  const failed = thread.status === "error" || thread.queuedWork === "failed";
  const openBranch = () => navigate.toPluginPanel(panelPath, { subPath: `branch/${thread.id}` });
  const open = () => openChatWorkspace(panel, thread.id, thread.displayTitle, true);
  const groups: CardActionGroup[] = [
    { label: "Навигация", items: [
      { label: "Открыть чат отдельно", action: () => navigate.toThread(thread.id) },
      { label: "Открыть ветку чата", action: openBranch },
    ] },
    contextActions({ kind: "thread", id: thread.id }, thread.displayTitle, derive),
    { label: "Управление чатом", items: [
      { label: "Создать форк чата", action: () => start("fork", thread) },
      { label: "Переместить чат в ветку", action: () => start("move", thread) },
      { label: "Создать карточку для этого чата", action: createIssue },
      ...archiveActions(thread, changeArchive),
      ...deleteActions,
    ] },
  ];
  if (listView) return <TaskListRow id={thread.id} kind="thread" projectId={thread.projectId} title={thread.displayTitle}
    stage={legacyStage[stageOf(thread)]} stageLabel={issueStages.find((stage) => stage.id === legacyStage[stageOf(thread)])!.label}
    summary={parent ? "Дочерний чат" : "Чат"} updatedAt={thread.updatedAt} selected={selection?.has(thread.id)} chatOpen={chatOpen} chatActive={chatActive}
    open={open} toggle={() => toggle(thread.id)} groups={groups}
    signals={<>{failed && <span className="text-destructive">Ошибка</span>}{thread.hasPendingInteraction && <span>Ожидает ввод</span>}
      {thread.isUnread && <span>Непрочитанное</span>}{thread.isArchived && <span>Архив</span>}{thread.isHidden && <span>Скрытый</span>}</>}
    details={<>
      {parent && <button type="button" className="kb-list-link" onClick={() => navigate.toPluginPanel(panelPath, { subPath: `branch/${parent.id}` })}>Родительский чат: {path}</button>}
      {branchCount > 0 && <button type="button" className="kb-list-link" onClick={openBranch}>Открыть ветку · {branchCount}</button>}
      <div className="kb-list-metadata"><WorktreeBadge status={worktrees[thread.id]} branch={thread.environment?.isWorktree ? thread.environment.branchName : null} />
        {plan?.priority && <span>Приоритет: {priorities[plan.priority]}</span>}{plan?.tags.map((tag) => <TagBadge key={tag} tag={tag} />)}</div>
      {!parent && !branchCount && !plan?.priority && !plan?.tags.length && !thread.environment?.isWorktree && <p>Дополнительных сведений нет.</p>}
    </>} />;
  return (
    <article className="kb-card bg-card" data-selected={selection?.has(thread.id)} data-chat-open={chatOpen} data-chat-active={chatActive}
      data-kanban-card-id={thread.id} data-kanban-kind="thread" data-kanban-project={thread.projectId}
      data-kanban-stage={legacyStage[stageOf(thread)]}
      onClick={(event) => { if (isCardBackgroundClick(event)) open(); }}
      onClickCapture={(event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        event.stopPropagation();
        toggle(thread.id);
      }}>
      {parent && (
        <button type="button" title={path} className="mb-1 block max-w-full truncate text-left text-xs text-muted-foreground"
          onClick={() => navigate.toPluginPanel(panelPath, { subPath: `branch/${parent.id}` })}>
          {path}
        </button>
      )}
      <button type="button" title={thread.displayTitle} onClick={open}
        className="kb-card-title font-medium text-foreground">{thread.displayTitle}</button>
      <div className="kb-card-footer">
        <div className="kb-card-meta text-muted-foreground">
          {selection && <input type="checkbox" aria-label={`Выбрать чат: ${thread.displayTitle}`}
            checked={selection.has(thread.id)} onChange={() => toggle(thread.id)} />}
          <span className="kb-card-kind" title="Чат BB"><KanbanIcon name="chat" /> Чат</span>
          <WorktreeBadge status={worktrees[thread.id]} branch={thread.environment?.isWorktree ? thread.environment.branchName : null} />
          {thread.isUnread && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Непрочитанное" />}
          {branchCount > 0 && <button type="button" className="kb-badge bg-muted hover:text-foreground" onClick={openBranch}>
            Ветка · {branchCount}
          </button>}
          {plan?.priority && <span className="kb-badge bg-muted text-foreground">{priorities[plan.priority]}</span>}
          {plan?.tags.map((tag) => <TagBadge key={tag} tag={tag} />)}
          {thread.isArchived && <span className="kb-badge bg-muted">Архив</span>}
          {thread.isHidden && <span className="kb-badge bg-muted">Скрытый</span>}
          {failed && <span className="kb-badge text-destructive">Ошибка</span>}
          {thread.hasPendingInteraction && <span className="kb-badge bg-muted">Ожидает ввод</span>}
        </div>
        <div className="kb-card-tools">
          <CardMenu label={`Действия с чатом: ${thread.displayTitle}`} groups={groups} />
        </div>
      </div>
    </article>
  );
}

function IssueCard({ issue, issues, index, move, selection, toggle, derive, worktrees, remove, chatActions, archived, listView = false }: {
  listView?: boolean; issue: Issue; issues: Issue[]; index: Index; move: (id: string, status: IssueStatus, beforeId?: string) => void;
  selection: ReadonlySet<string> | null; toggle: (id: string) => void; derive: OpenDerivation; worktrees: WorktreeStatuses;
  remove: (issue: Issue) => void; chatActions: (issue: Issue) => CardAction[]; archived: boolean;
}) {
  const panel = experimental_useAppPanel();
  const navigate = useBbNavigate();
  const threads = issue.threadIds.flatMap((id) => index.byId.get(id) ?? []);
  const { chatOpen, chatActive } = useChatHighlight(issue.threadIds);
  const branchId = issue.threadIds.at(-1);
  const waiting = threads.some((thread) => stageOf(thread) === "waiting");
  const working = threads.some((thread) => stageOf(thread) === "working");
  const failed = threads.some((thread) => thread.status === "error" || thread.queuedWork === "failed");
  const parent = issue.parentId ? issues.find((item) => item.id === issue.parentId) : undefined;
  const childCount = issues.filter((item) => item.parentId === issue.id).length;
  const blocked = issue.blockedBy.some((id) => issues.some((item) => item.id === id && !["done", "cancelled"].includes(item.status)));
  const title = issueTitle(issue);
  const tree = (id: string) => navigate.toPluginPanel(panelPath, { subPath: `issue-tree/${id}` });
  const open = () => openIssue(panel, issue, { reuse: true });
  const groups: CardActionGroup[] = [
    { label: "Навигация", items: [
      { label: "Открыть карточку", action: open },
      { label: "Открыть ветку задачи", action: () => tree(issue.id) },
      ...(branchId ? [{ label: "Открыть ветку чата", action: () => navigate.toPluginPanel(panelPath, { subPath: `branch/${branchId}` }) }] : []),
    ] },
    contextActions({ kind: "issue", id: issue.id }, title, derive),
    { label: "Связанные чаты", items: chatActions(issue) },
    { label: "Управление карточкой", items: [{ label: "Удалить карточку", destructive: true, action: () => remove(issue) }] },
  ];
  if (listView) return <TaskListRow id={issue.id} kind="issue" projectId={issue.projectId} title={title}
    stage={issue.status} stageLabel={issueStages.find((stage) => stage.id === issue.status)!.label}
    summary={`${parent ? "Подзадача" : "Задача"} · ${issue.assignee || (issue.threadIds.length ? `Чатов: ${issue.threadIds.length}` : "Без чата")}`}
    updatedAt={issue.updatedAt} selected={selection?.has(issue.id)} chatOpen={chatOpen} chatActive={chatActive}
    open={open} toggle={() => toggle(issue.id)} groups={groups}
    drag={{ onDragStart: (event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(issueDragType, issue.id); },
      onDragOver: (event) => { if (event.dataTransfer.types.includes(issueDragType)) event.preventDefault(); },
      onDrop: (event) => {
        const id = event.dataTransfer.getData(issueDragType);
        if (id) { event.preventDefault(); event.stopPropagation(); move(id, issue.status, issue.id); }
      } }}
    signals={<>{waiting ? <span>Ожидает ввод</span> : working ? <span>Агент работает</span> : null}
      {(failed || issue.error) && <span className="text-destructive">Ошибка</span>}{blocked && <span>Заблокирована</span>}
      {archived && <span>Архив</span>}{(issue.priority === "high" || issue.priority === "urgent") && <span>{priorities[issue.priority]}</span>}</>}
    details={<>
      {parent && <button type="button" className="kb-list-link" onClick={() => tree(parent.id)}>Родительская задача: {issueTitle(parent)}</button>}
      {childCount > 0 && <button type="button" className="kb-list-link" onClick={() => tree(issue.id)}>Открыть ветку · {childCount}</button>}
      <div className="kb-list-metadata">
        {issue.priority && <span>Приоритет: {priorities[issue.priority]}</span>}{issue.assignee && <span>Исполнитель: {issue.assignee}</span>}
        {issue.tags.map((tag) => <TagBadge key={tag} tag={tag} />)}
        {issue.threadIds.map((id) => <WorktreeBadge key={id} status={worktrees[id]} branch={index.byId.get(id)?.environment?.isWorktree ? index.byId.get(id)?.environment?.branchName : null} />)}
      </div>
      {issue.error && <p className="text-destructive">{issue.error}</p>}
      {!parent && !childCount && !issue.priority && !issue.assignee && !issue.tags.length && !issue.threadIds.length && <p>Дополнительных сведений нет.</p>}
    </>} />;
  return (
    <article draggable data-selected={selection?.has(issue.id)} data-chat-open={chatOpen} data-chat-active={chatActive}
      data-kanban-card-id={issue.id} data-kanban-kind="issue" data-kanban-project={issue.projectId} data-kanban-stage={issue.status}
      onClick={(event) => { if (isCardBackgroundClick(event)) open(); }}
      onClickCapture={(event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        event.stopPropagation();
        toggle(issue.id);
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(issueDragType, issue.id);
      }}
      onDragOver={(event) => { if (event.dataTransfer.types.includes(issueDragType)) event.preventDefault(); }}
      onDrop={(event) => {
        const id = event.dataTransfer.getData(issueDragType);
        if (!id) return;
        event.preventDefault();
        event.stopPropagation();
        move(id, issue.status, issue.id);
      }}
      className="kb-card bg-card">
      {parent && (
        <button type="button" onClick={() => tree(parent.id)} title={`Родительская задача · ${issueTitle(parent)}`}
          className="mb-1 block max-w-full truncate text-left text-xs text-muted-foreground">
          ↳ {issueTitle(parent)}
        </button>
      )}
      <button type="button" title={title} onClick={open}
        className="kb-card-title font-medium text-foreground">{title}</button>
      <div className="kb-card-footer">
        <div className="kb-card-meta text-muted-foreground">
          {selection && <input type="checkbox" aria-label={`Выбрать задачу: ${title}`}
            checked={selection.has(issue.id)} onChange={() => toggle(issue.id)} />}
          {issue.threadIds.map((id) => {
            const environment = index.byId.get(id)?.environment;
            return <WorktreeBadge key={id} status={worktrees[id]} branch={environment?.isWorktree ? environment.branchName : null} />;
          })}
          {issue.priority && <span className="kb-badge bg-muted text-foreground">{priorities[issue.priority]}</span>}
          {issue.assignee && <span className="kb-badge" title={issue.assignee}>{issue.assignee}</span>}
          {issue.tags.map((tag) => <TagBadge key={tag} tag={tag} />)}
          {archived && <span className="kb-badge bg-muted">Архив</span>}
          {childCount > 0 && <button type="button" className="kb-badge bg-muted hover:text-foreground" onClick={() => tree(issue.id)}>
            Ветка · {childCount}
          </button>}
          {issue.threadIds.length > 0 && <span>Чатов · {issue.threadIds.length}</span>}
          {blocked && <span className="text-amber-700 dark:text-amber-400">Заблокирована</span>}
          {issue.busy?.kind === "planning" && <span>Готовится план</span>}
          {waiting ? <span className="text-amber-700 dark:text-amber-400">Ожидает ввод</span>
            : working ? <span className="text-blue-600 dark:text-blue-400">Агент работает</span> : null}
          {(failed || issue.error) && <span className="text-destructive">Ошибка</span>}
        </div>
        <div className="kb-card-tools">
          <CardMenu label={`Действия с задачей: ${title}`} groups={groups} />
        </div>
      </div>
    </article>
  );
}

function BranchNode({ thread, index, path, start, derive, issueOwners, openTree, focus, folded, toggle, selection, select, worktrees, changeArchive }: {
  thread: ChatNode; index: ThreadIndex<ChatNode>; path: readonly string[]; start: StartOperation; derive: OpenDerivation;
  issueOwners: ReadonlyMap<string, Issue>; openTree: (id: string) => void; focus: (id: string) => void;
  folded: ReadonlySet<string>; toggle: (id: string) => void;
  selection: ReadonlySet<string> | null; select: (id: string) => void; worktrees: WorktreeStatuses; changeArchive: ChangeArchive;
}) {
  const { chatOpen, chatActive } = useChatHighlight([thread.id]);
  const panel = experimental_useAppPanel();
  const navigate = useBbNavigate();
  const deleteActions = useDeleteChatActions(thread);
  const expanded = !folded.has(thread.id);
  const nextPath = [...path, thread.id];
  const children = (index.children.get(thread.id) ?? []).filter((child) => !nextPath.includes(child.id));
  const issue = issueOwners.get(thread.id);
  const open = () => issue ? openIssue(panel, issue, { threadId: thread.id, reuse: true }) : openChatWorkspace(panel, thread.id, thread.displayTitle, true);
  return (
    <li>
      <div className="kb-tree-node rounded-md p-1 hover:bg-state-hover" data-selected={selection?.has(thread.id)} data-chat-open={chatOpen} data-chat-active={chatActive}
        data-kanban-card-id={thread.id} data-kanban-kind="thread" data-kanban-project={thread.projectId}
        data-kanban-stage={legacyStage[stageOf(thread)]} data-kanban-title={thread.displayTitle}
        onClick={(event) => { if (isCardBackgroundClick(event)) open(); }}
        onClickCapture={(event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          event.stopPropagation();
          select(thread.id);
        }}>
        {selection && <input type="checkbox" className="mt-1.5" aria-label={`Выбрать чат: ${thread.displayTitle}`}
          checked={selection.has(thread.id)} onChange={() => select(thread.id)} />}
        {children.length > 0 ? (
          <Button variant="ghost" size="icon" className="size-6 shrink-0" aria-expanded={expanded}
            aria-label={`${expanded ? "Свернуть" : "Раскрыть"} ветку: ${thread.displayTitle}`}
            onClick={() => toggle(thread.id)}>
            <Icon name={expanded ? "ChevronDown" : "ChevronRight"} />
          </Button>
        ) : <span className="w-6 shrink-0" />}
        <div className="min-w-0 flex-1">
          <button type="button" className="kb-card-title text-left font-medium"
            title={thread.displayTitle} onClick={open}>{thread.displayTitle}</button>
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <StageLabel thread={thread} />
            <WorktreeBadge status={worktrees[thread.id]} />
            {children.length > 0 && <span>Дочерних · {children.length}</span>}
            {thread.isArchived && <span>Архив</span>}
            {thread.isHidden && <span>Скрытый</span>}
            {issue && <button type="button" className="text-primary" onClick={() => openTree(issue.id)}>Ветка задачи</button>}
          </div>
        </div>
        <div className="kb-card-tools">
        <CardMenu label={`Действия с чатом: ${thread.displayTitle}`} groups={[
          { label: "Навигация", items: [
            { label: "Открыть чат отдельно", action: () => navigate.toThread(thread.id) },
            ...(path.length ? [{ label: "Открыть ветку чата", action: () => focus(thread.id) }] : []),
            ...(issue ? [{ label: "Открыть ветку задачи", action: () => openTree(issue.id) }] : []),
          ] },
          contextActions({ kind: "thread", id: thread.id }, thread.displayTitle, derive),
          { label: "Управление чатом", items: [
            { label: "Создать форк чата", action: () => start("fork", thread) },
            { label: "Переместить чат в ветку", action: () => start("move", thread) },
            ...archiveActions(thread, changeArchive),
            ...deleteActions,
          ] },
        ]} />
        </div>
      </div>
      {expanded && children.length > 0 && (
        <ul className="kb-tree-children border-l border-border">
          {children.map((child) => (
            <BranchNode key={child.id} thread={child} index={index} path={nextPath} start={start}
              derive={derive} issueOwners={issueOwners} openTree={openTree} focus={focus} folded={folded} toggle={toggle}
              selection={selection} select={select} worktrees={worktrees} changeArchive={changeArchive} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ChatBranch({ id, index, hidden, projects, start, derive, issueOwners, openTree, revision, selection, select, archiveParents, changeArchive }: {
  id: string; index: Index; hidden: boolean; projects: ReadonlyMap<string, string>; start: StartOperation; derive: OpenDerivation;
  issueOwners: ReadonlyMap<string, Issue>; openTree: (id: string) => void; revision: number;
  selection: ReadonlySet<string> | null; select: (id: string) => void;
  archiveParents: Readonly<Record<string, string>>; changeArchive: ChangeArchive;
}) {
  const navigate = useBbNavigate();
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const liveIds = descendantIds(id, index);
  const live = [...liveIds].flatMap((id) => index.byId.get(id) ?? []);
  const topology = live.map((thread) => `${thread.id}:${thread.parentThreadId}`).sort().join(",");
  const snapshot = useChatTree(id, `${revision}:${topology}`, archiveParents);
  const nodes = new Map<string, ChatNode>(snapshot?.nodes.map((thread) => [thread.id, thread]));
  for (const thread of live) nodes.set(thread.id, thread);
  const worktrees = useWorktreeStates([...nodes.keys()]);
  const root = nodes.get(id);
  if (!root) return <p className="text-sm text-muted-foreground">
    {snapshot?.error || (snapshot ? "Ветка чата не найдена." : "Загружаю дерево чатов…")}
  </p>;
  const ancestors = (snapshot?.ancestorIds ?? ancestorsOf(root, index).map((parent) => parent.id))
    .flatMap((ancestorId) => index.byId.get(ancestorId) ?? nodes.get(ancestorId) ?? [])
    .filter((thread) => hidden || !thread.isHidden);
  const ancestorIds = new Set(snapshot?.ancestorIds ?? []);
  const descendants = [...nodes.values()].filter((thread) => thread.id !== id && !ancestorIds.has(thread.id) && (hidden || !thread.isHidden));
  const included = new Set([id, ...descendants.map((thread) => thread.id)]);
  const branchIndex = indexThreads([root, ...descendants.map((thread) => {
    let parentId = thread.parentThreadId;
    const seen = new Set([thread.id]);
    while (parentId && !included.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId);
      parentId = nodes.get(parentId)?.parentThreadId ?? null;
    }
    return { ...thread, parentThreadId: parentId && included.has(parentId) ? parentId : id };
  })]);
  const focus = (threadId: string) => navigate.toPluginPanel(panelPath, { subPath: `branch/${threadId}` });
  const toggle = (threadId: string) => setFolded((previous) => {
    const next = new Set(previous);
    if (next.has(threadId)) next.delete(threadId);
    else next.add(threadId);
    return next;
  });
  return (
    <section className="mx-auto max-w-4xl space-y-3">
      <div className="kb-tree-heading flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Дерево чатов</h2>
          <p className="text-xs text-muted-foreground">{projects.get(root.projectId)} · Дочерних чатов {descendants.length}</p>
        </div>
        {descendants.length > 0 && <div className="flex flex-wrap gap-1">
          <Button variant="ghost" size="sm" onClick={() => setFolded(new Set())}>Развернуть все</Button>
          <Button variant="ghost" size="sm" onClick={() => setFolded(new Set(branchIndex.children.keys()))}>Свернуть все</Button>
        </div>}
      </div>
      {ancestors.length > 0 && (
        <nav aria-label="Путь в дереве чатов" className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
          {ancestors.map((thread) => (
            <span key={thread.id} className="flex min-w-0 max-w-full items-center gap-1.5">
              <button type="button" title={thread.displayTitle} className="truncate text-muted-foreground"
                onClick={() => focus(thread.id)}>{thread.displayTitle}</button>
              <span aria-hidden="true" className="text-muted-foreground">/</span>
            </span>
          ))}
          <span aria-current="page" className="truncate" title={root.displayTitle}>{root.displayTitle}</span>
        </nav>
      )}
      {snapshot?.error && <p role="alert" className="text-xs text-destructive">Не удалось загрузить всю ветку. {snapshot.error}</p>}
      <ul className="rounded-lg border border-border p-1.5">
        <BranchNode thread={root} index={branchIndex} path={[]} start={start} derive={derive}
          issueOwners={issueOwners} openTree={openTree} focus={focus} folded={folded} toggle={toggle}
          selection={selection} select={select} worktrees={worktrees} changeArchive={changeArchive} />
      </ul>
    </section>
  );
}

function OperationDialog({ operation, index, close, changed }: { operation: Operation; index: Index; close: () => void; changed: () => void }) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  const [title, setTitle] = useState("");
  const [forkWorkspace, setForkWorkspace] = useState("reuse");
  const [parentId, setParentId] = useState(operation.thread.parentThreadId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { kind, thread } = operation;
  const isFork = kind === "fork";
  const descendants = descendantIds(thread.id, index);
  const candidates = index.sorted
    .filter((candidate) => candidate.projectId === thread.projectId && candidate.id !== thread.id &&
      !candidate.isArchived && !descendants.has(candidate.id))
    .sort((a, b) => a.displayTitle.localeCompare(b.displayTitle, "ru"));

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) close(); }}>
      <DialogContent className="kb-dialog">
        <DialogHeader>
          <DialogTitle>{isFork ? "Форк чата" : "Переместить в ветку"}</DialogTitle>
          <DialogDescription>{thread.displayTitle}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            if (isFork) {
              const fork = await sdk.threads.fork({
                sourceThreadId: thread.id,
                title: title.trim() || undefined,
                environment: forkWorkspace === "worktree"
                  ? { type: "host", hostId: thread.host?.id, workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } }
                  : forkWorkspace === "personal"
                    ? { type: "host", hostId: thread.host?.id, workspace: { type: "personal" } }
                    : undefined,
              });
              changed();
              close();
              if (!openChatWorkspace(panel, fork.id, fork.title ?? "Новый форк")) {
                navigate.toThread(fork.id);
              }
            } else {
              await sdk.threads.update({ threadId: thread.id, parentThreadId: parentId || null });
              changed();
              close();
            }
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            setBusy(false);
          }
        }}>
          {isFork ? (
            <div className="space-y-3">
            <label className="block space-y-1.5 text-sm">
              <span>Название подзадачи</span>
              <Input value={title} onChange={(event) => setTitle(event.target.value)}
                placeholder="BB предложит название" disabled={busy} />
              <span className="block text-xs text-muted-foreground">
                Форк унаследует контекст исходного чата и откроется для нового сообщения.
              </span>
            </label>
            <label className="block space-y-1.5 text-sm">
              <span>Окружение форка</span>
              <select value={forkWorkspace} onChange={(event) => setForkWorkspace(event.target.value)}
                disabled={busy} className="block w-full rounded-md border border-input bg-background px-2 py-2">
                <option value="reuse">Окружение исходного чата</option>
                <option value="worktree">Отдельный Git worktree</option>
                <option value="personal">Отдельное личное окружение</option>
              </select>
            </label>
            </div>
          ) : (
            <label className="block space-y-1.5 text-sm">
              <span>Родительский чат</span>
              <select value={parentId} onChange={(event) => setParentId(event.target.value)}
                disabled={busy} className="block w-full rounded-md border border-input bg-background px-2 py-2">
                <option value="">Верхний уровень</option>
                {parentId && !candidates.some((candidate) => candidate.id === parentId) &&
                  <option value={parentId} disabled>Текущий родитель</option>}
                {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.displayTitle}</option>)}
              </select>
            </label>
          )}
          {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>Отмена</Button>
            <Button type="submit" disabled={busy || (!isFork && parentId === (thread.parentThreadId ?? ""))}>
              {busy ? "Сохраняю…" : isFork ? "Создать форк" : "Переместить"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function KanbanPage({ subPath }: { subPath: string }) {
  const surface = useRef<HTMLDivElement>(null);
  const issues = useIssues();
  const merge = /^merges(?:\/([\da-f-]{36}))?$/i.exec(subPath);
  return <div ref={surface} data-kanban-board-surface className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
    <WindowPlacementBridge surface={surface} />
    <PanelContextBridge surface={surface} issues={issues.data} />
    {merge
    ? <MergeCenter key={merge[1] ?? "history"} id={merge[1]} initialProjectId={readViewPreferences().projectId} />
    : <KanbanBoard subPath={subPath} issueQuery={issues} />}
  </div>;
}

function KanbanBoard({ subPath, issueQuery }: { subPath: string; issueQuery: ReturnType<typeof useIssues> }) {
  const filterSearch = useRef<HTMLInputElement>(null);
  const navigate = useBbNavigate();
  const openMerge = useOpenMerge();
  const panel = experimental_useAppPanel();
  const portalScope = usePortalScopeProps();
  const rpc = useRpc<typeof issueRpc>();
  const issues = issueQuery.data ?? [];
  const [preferences] = useState(readViewPreferences);
  const surface = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  const [focusedStage, setFocusedStage] = useState(preferences.focusedStage);
  const [creating, setCreating] = useState(false);
  const [showCancelled, setShowCancelled] = useState(preferences.showCancelled);
  const [listView, setListView] = useState(preferences.listView);
  const [collapsedStages, setCollapsedStages] = useState(readCollapsedStages);
  const [tagFilter, setTagFilter] = useState(preferences.tagFilter);
  const [assigneeFilter, setAssigneeFilter] = useState(preferences.assigneeFilter);
  const [priorityFilter, setPriorityFilter] = useState(preferences.priorityFilter);
  const [showSubtasks, setShowSubtasks] = useState(preferences.showSubtasks);
  const [hideBlocked, setHideBlocked] = useState(preferences.hideBlocked);
  const [selection, setSelection] = useState<ReadonlySet<string> | null>(null);
  const [bulkPending, setBulkPending] = useState(false);
  const visibleStages = issueStages.filter((stage) => stage.id !== "cancelled" || showCancelled);
  const showColumns = !listView && !compact;
  const grid = showColumns ? "grid gap-2" : "grid grid-cols-1 gap-2";
  const gridStyle = !showColumns ? undefined : {
    gridTemplateColumns: visibleStages.map((stage) => collapsedStages.has(stage.id)
      ? `${foldedColumnWidth}rem`
      : `minmax(${openColumnMinWidth}rem,1fr)`).join(" "),
  };
  const boardMinWidth = visibleStages.reduce((width, stage) => width +
    (collapsedStages.has(stage.id) ? foldedColumnWidth : openColumnMinWidth),
    (visibleStages.length - 1) * columnGap);
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const update = (width: number) => setCompact(width < 740);
    update(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => update(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(columnPreferencesKey, JSON.stringify([...collapsedStages]));
    } catch {
      // Persistence is optional.
    }
  }, [collapsedStages]);
  const [archive, setArchive] = useState(preferences.archive);
  const [hidden, setHidden] = useState(preferences.hidden);
  const [query, setQuery] = useState(preferences.query);
  const [projectId, setProjectId] = useState(preferences.projectId);
  const [attentionOnly, setAttentionOnly] = useState(preferences.attentionOnly);
  const [sort, setSort] = useState(preferences.sort);
  useEffect(() => {
    try {
      sessionStorage.setItem(viewPreferencesKey, JSON.stringify({
        listView, focusedStage, projectId, query, tagFilter, assigneeFilter, priorityFilter, sort,
        showSubtasks, hideBlocked, showCancelled, attentionOnly, archive, hidden,
      }));
    } catch {
      // Preferences are still available while this view is mounted.
    }
  }, [listView, focusedStage, projectId, query, tagFilter, assigneeFilter, priorityFilter, sort,
    showSubtasks, hideBlocked, showCancelled, attentionOnly, archive, hidden]);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [branchRevision, setBranchRevision] = useState(0);
  const archiveApi = useRpc<typeof archiveRpc>();
  const archiveLinks = experimental_useRpcQuery({ contract: archiveRpc, method: "archiveParents", input: null });
  const archiveParents = archiveLinks.data ?? noArchiveParents;
  useRealtime(archiveChanged, () => {
    void archiveLinks.refetch();
    setBranchRevision((value) => value + 1);
  });
  const changeArchive: ChangeArchive = (thread) => {
    void archiveApi.call("archiveChat", { threadId: thread.id, archived: !thread.isArchived })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
  };
  const [derivation, setDerivation] = useState<DeriveDialogRequest | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const deleteIssue = issues.find((issue) => issue.id === deleteId);
  const requestDelete = (issue: Issue) => setDeleteId(issue.id);
  const derivationActivity = useDerivationActivity("board");
  const { projectExpansion, setProjectExpansion, scrollRef, saveScroll } = useListViewContext({ listView, subPath, query, projectId, tagFilter, assigneeFilter, priorityFilter, sort, showSubtasks, hideBlocked, attentionOnly, showCancelled, archive, hidden, ready: !issueQuery.isLoading });
  const projectApi = useRpc<typeof projectRpc>();
  const projectOrder = experimental_useRpcQuery({ contract: projectRpc, method: "projectOrder", input: null });
  const personalGroups = experimental_useRpcQuery({ contract: projectRpc, method: "projectPersonalGroups", input: null });
  const inPersonal = useMemo(() => new Set(personalGroups.data ?? []), [personalGroups.data]);
  const groupOf = (id: string) => inPersonal.has(id) ? personalProjectId : id;
  const [projectTarget, setProjectTarget] = useState<ProjectDialogTarget | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [createdProject, setCreatedProject] = useState<CreatedProject | null>(null);
  const [movingProject, setMovingProject] = useState(false);
  const refreshProjects = () => { void projectOrder.refetch(); void personalGroups.refetch(); };
  useRealtime(projectsChanged, refreshProjects);
  useEffect(() => {
    if (inPersonal.has(projectId)) setProjectId(personalProjectId);
  }, [inPersonal, projectId]);
  const data = experimental_useSidebarThreads({
    experimental_lifecycles: archive ? ["active", "archived"] : ["active"],
  });
  const index = useMemo(() => indexThreads(data.threads
    .filter((thread) => hidden || !thread.isHidden)
    .map((thread) => {
      const parentThreadId = archiveParents[thread.id];
      return !thread.parentThreadId && parentThreadId ? { ...thread, parentThreadId } : thread;
    })), [data.threads, hidden, archiveParents]);
  const issueOwners = new Map(issues.flatMap((issue) => issue.threadIds.map((id) => [id, issue] as const)));
  const archivedThreads = experimental_useRpcKeyedQuery({
    contract: archiveRpc, method: "archivedThreads", keys: [...issueOwners.keys()],
  }).data ?? {};
  const isIssueArchived = (issue: Issue) =>
    issue.threadIds.length > 0 && issue.threadIds.every((id) => archivedThreads[id] != null);
  const linkedChatActions = (issue: Issue) => {
    const threads = issue.threadIds.flatMap((id) => {
      const title = archivedThreads[id];
      if (title != null) return archive ? [{ id, isArchived: true, displayTitle: title }] : [];
      const thread = index.byId.get(id);
      return thread && stageOf(thread) === "done" ? [thread] : [];
    });
    return threads.map((thread) => {
      if (issue.threadIds.length === 1) return archiveAction(thread, changeArchive);
      const duplicateTitle = threads.some((other) => other.id !== thread.id && other.displayTitle === thread.displayTitle);
      const title = duplicateTitle ? `${thread.displayTitle} (${thread.id})` : thread.displayTitle;
      return archiveAction(thread, changeArchive, ` · ${title}`);
    });
  };
  const worktrees = useWorktreeStates([...new Set([
    ...index.sorted.filter((thread) => thread.environment?.isWorktree).map((thread) => thread.id),
    ...issues.flatMap((issue) => issue.threadIds.filter((id) => !index.byId.has(id))),
  ])]);
  const planning = experimental_useRpcKeyedQuery({
    contract: planRpc, method: "planList", keys: index.sorted.map((thread) => thread.id),
  });
  useRealtime(planChanged, (payload) => {
    if (payload && typeof payload === "object" && "threadId" in payload && typeof payload.threadId === "string" &&
      index.byId.has(payload.threadId)) void planning.refetchKeys([payload.threadId]);
  });
  const plans = planning.data ?? {};
  const branchId = /^branch\/(thr_[a-z0-9]+)$/i.exec(subPath)?.[1];
  const issueTreeId = /^issue-tree\/([\da-f-]{36})$/i.exec(subPath)?.[1];
  const branchView = !!branchId || !!issueTreeId;
  const search = query.trim().toLocaleLowerCase("ru");
  // Show the successful response immediately while BB's shared sidebar catches up.
  const orderedProjects = orderProjects(createdProject && !data.projects.some(({ id }) => id === createdProject.id)
    ? [...data.projects, { ...createdProject, isPersonal: false, href: "/", settingsHref: "/" }]
    : data.projects, projectOrder.data ?? []);
  useEffect(() => {
    if (createdProject && data.projects.some(({ id }) => id === createdProject.id)) setCreatedProject(null);
  }, [createdProject, data.projects]);
  const projectNames = new Map(orderedProjects.map(({ id, name }) => [id, name]));
  const restoreProjects = orderedProjects.filter(({ id }) => inPersonal.has(id));
  const projects = new Map(orderedProjects.filter(({ id }) => !inPersonal.has(id)).map(({ id, name }) => [id, name]));
  if (inPersonal.size && !projects.has(personalProjectId)) projects.set(personalProjectId, "Personal");
  const projectIds = [...projects.keys()];
  async function changeProjectOrder(id: string, direction: "up" | "down") {
    if (movingProject || !projectOrder.data) return;
    setMovingProject(true);
    try {
      await projectApi.call("projectMove", { projectId: id, direction, baseline: projectIds });
      await projectOrder.refetch();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMovingProject(false);
    }
  }
  const claimedThreads = new Set(issueOwners.keys());
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const issueTreeRoot = issueTreeId ? issueById.get(issueTreeId) : undefined;
  const filterOptions = issues.filter((issue) => !projectId || projectId === groupOf(issue.projectId));
  const tags = [...new Set(filterOptions.flatMap((issue) => issue.tags))].sort();
  const assignees = [...new Set(filterOptions.map((issue) => issue.assignee).filter(Boolean))].sort();
  const isFiltered = Boolean(search || attentionOnly || tagFilter || assigneeFilter || priorityFilter || !showSubtasks || hideBlocked);
  const issueMatches = issues.filter((issue) =>
    (!projectId || projectId === groupOf(issue.projectId)) &&
    (archive || !isIssueArchived(issue)) &&
    (!attentionOnly || issue.threadIds.some((id) => {
      const thread = index.byId.get(id);
      return thread && !thread.isArchived && thread.hasPendingInteraction;
    })) &&
    (showCancelled || issue.status !== "cancelled") &&
    (!tagFilter || issue.tags.includes(tagFilter)) &&
    (!assigneeFilter || issue.assignee === assigneeFilter) &&
    (!priorityFilter || issue.priority === priorityFilter) &&
    (showSubtasks || !issue.parentId) &&
    (!hideBlocked || !issue.blockedBy.some((id) => {
      const blocker = issueById.get(id);
      return blocker && blocker.status !== "done" && blocker.status !== "cancelled";
    })) &&
    [issue.title, issue.description, issue.notes, issue.assignee, ...issue.tags].join(" ").toLocaleLowerCase("ru").includes(search),
  );
  const priorityOrder = Object.keys(priorities);
  const rank = (priority: Plan["priority"]) => priority ? priorityOrder.indexOf(priority) : priorityOrder.length;
  issueMatches.sort((a, b) => {
    if (sort === "updated") return b.updatedAt - a.updatedAt;
    if (sort === "created") return b.createdAt - a.createdAt;
    if (sort === "priority") return rank(a.priority) - rank(b.priority) || b.updatedAt - a.updatedAt;
    return a.order - b.order || a.id.localeCompare(b.id);
  });
  const matches = index.sorted.filter((thread) => {
    const plan = plans[thread.id];
    const searchable = [thread.displayTitle, plan?.notes ?? "", ...(plan?.tags ?? [])].join(" ").toLocaleLowerCase("ru");
    return (archive || !thread.isArchived) && (!issueQuery.isLoading && !claimedThreads.has(thread.id)) &&
      (!projectId || projectId === groupOf(thread.projectId)) &&
      (!tagFilter || plan?.tags.includes(tagFilter)) && !assigneeFilter &&
      (!priorityFilter || plan?.priority === priorityFilter) && (showSubtasks || !thread.parentThreadId) &&
      (!attentionOnly || stageOf(thread) === "waiting") && searchable.includes(search);
  });
  if (sort === "priority") {
    const rank = Object.keys(priorities);
    const priorityOf = (id: string) => {
      const value = plans[id]?.priority;
      return value ? rank.indexOf(value) : rank.length;
    };
    matches.sort((a, b) => priorityOf(a.id) - priorityOf(b.id) || b.updatedAt - a.updatedAt);
  } else if (sort === "created") matches.sort((a, b) => b.createdAt - a.createdAt);
  const grouped = new Map<string, Thread[]>();
  const stageCounts = new Map<IssueStatus, number>();
  for (const issue of issueMatches) stageCounts.set(issue.status, (stageCounts.get(issue.status) ?? 0) + 1);
  for (const thread of matches) {
    const groupId = groupOf(thread.projectId);
    if (!projects.has(groupId)) projects.set(groupId, groupId === personalProjectId ? "Personal" : "Проект");
    const cards = grouped.get(groupId) ?? [];
    cards.push(thread);
    grouped.set(groupId, cards);
    const stage = legacyStage[stageOf(thread)];
    stageCounts.set(stage, (stageCounts.get(stage) ?? 0) + 1);
  }
  const currentStage = visibleStages.find((stage) => stage.id === focusedStage) ??
    visibleStages.find((stage) => (stageCounts.get(stage.id) ?? 0) > 0) ?? visibleStages[0];
  const shownStages = compact && !listView ? [currentStage] : visibleStages;
  useAgentView(surface, () => ({
    subPath, layout: listView ? "list" : compact ? "stage" : "board",
    filters: { projectId, query, tagFilter, assigneeFilter, priorityFilter, sort, showSubtasks, hideBlocked,
      showCancelled, attentionOnly, archive, hidden },
    collapsedStages: [...collapsedStages], shownStages: shownStages.map(({ id }) => id),
    stageCounts: Object.fromEntries(stageCounts), projectExpansion: Object.fromEntries(projectExpansion),
    projectGroups: Array.from(projects, ([id, name]) => ({ id, name })), personalProjectGroups: [...inPersonal],
    selectedIds: [...(selection ?? [])].slice(0, 500), selectedCount: selection?.size ?? 0,
    loading: issueQuery.isLoading || projectOrder.isLoading || personalGroups.isLoading,
    error: [issueQuery.error, projectOrder.error, personalGroups.error].filter(Boolean).map(String).join("; ") || null,
  }));
  const filterCount = [
    attentionOnly, tagFilter, assigneeFilter, priorityFilter, !showSubtasks, hideBlocked,
    showCancelled, archive, hidden, sort !== "updated",
  ].filter(Boolean).length;
  const activeFilters = [
    query.trim() && `Поиск: ${query.trim()}`, tagFilter && `Метка: ${tagFilter}`,
    assigneeFilter && `Исполнитель: ${assigneeFilter}`, priorityFilter && `Приоритет: ${priorities[priorityFilter as keyof typeof priorities]}`,
    attentionOnly && "Требуется ввод", !showSubtasks && "Без подзадач", hideBlocked && "Без заблокированных",
    showCancelled && "С отменёнными", archive && "С архивными", hidden && "Со скрытыми",
    sort !== "updated" && `Порядок: ${{ created: "по созданию", priority: "по приоритету", manual: "вручную" }[sort as string] ?? sort}`,
  ].filter(Boolean).join(" · ");
  const filterSelect = "h-9 min-w-0 w-full rounded-md border border-input bg-background px-2 text-sm";
  function toggleStage(stage: IssueStatus) {
    setCollapsedStages((previous) => {
      const next = new Set(previous);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
  }
  const start: StartOperation = (kind, thread) => setOperation({ kind, thread });
  async function createIssue(id: string, status: IssueStatus, threadId?: string) {
    if (creating) return;
    setCreating(true);
    try {
      const issue = await rpc.call("issueCreate", { projectId: id, status, ...(threadId ? { threadId } : {}) });
      setFocusedStage(status);
      setProjectExpansion((previous) => new Map(previous).set(id, true));
      openIssue(panel, issue, { startWithAssistant: !threadId });
      await issueQuery.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  }
  async function moveIssue(id: string, status: IssueStatus, beforeId?: string) {
    const source = issues.find((item) => item.id === id);
    const destination = beforeId ? issues.find((item) => item.id === beforeId) : undefined;
    if (!source || (destination && groupOf(destination.projectId) !== groupOf(source.projectId))) return;
    try {
      await rpc.call("issueMove", {
        id, status, ...(sort === "manual" && beforeId ? { beforeId } : {}), atEnd: sort === "manual" && !beforeId,
      });
      await issueQuery.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }
  function toggleSelection(id: string) {
    setSelection((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else if (next.size < 200) next.add(id);
      return next;
    });
  }
  async function moveSelected(status: IssueStatus) {
    const ids = issueMatches.filter((issue) => selection?.has(issue.id)).map((issue) => issue.id);
    if (!ids.length || bulkPending) return;
    setBulkPending(true);
    try {
      await rpc.call("issueMoveMany", { ids, status });
      setSelection(null);
      await issueQuery.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBulkPending(false);
    }
  }
  function resetFilters() {
    setQuery("");
    setProjectId("");
    setAttentionOnly(false);
    setTagFilter("");
    setAssigneeFilter("");
    setPriorityFilter("");
    setShowSubtasks(true);
    setHideBlocked(false);
    setShowCancelled(false);
    setArchive(false);
    setHidden(false);
    setSort("updated");
  }
  const back = () => navigate.toPluginPanel(panelPath);
  const openTree = (id: string) => navigate.toPluginPanel(panelPath, { subPath: `issue-tree/${id}` });
  const archiveState = data.experimental_archived;
  const archiveMore = archiveState && (archiveState.hasNextPage || archiveState.isFetchNextPageError);
  const selectedIssues = [...(selection ?? [])].filter((id) => issueById.has(id));
  const selectedThreads = [...(selection ?? [])].filter((id) => id.startsWith("thr_"));
  const toggleSelectionMode = () => setSelection(selection ? null : new Set());

  return (
    <main ref={surface} data-kanban-layout={listView ? "list" : compact ? "stage" : "board"}
      className="kb-shell flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      {branchView ? (
        <div className="kb-toolbar kb-tree-toolbar border-b border-border">
          <div className="kb-tree-toolbar-row flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={back}><Icon name="ArrowLeft" /> К доске</Button>
            <span className="kb-tree-caption">{issueTreeId ? "Дерево подзадач" : "Дерево чатов"}</span>
            <Button variant="ghost" size="sm" aria-pressed={selection !== null} onClick={toggleSelectionMode}>Выбрать</Button>
            {branchId && <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} /> Скрытые
            </label>}
          </div>
        </div>
      ) : (
        <div className="kb-toolbar border-b border-border">
          <div className="kb-toolbar-heading">
            <div className="kb-board-title">
              <h1 className="text-xl font-semibold tracking-tight">Задачи</h1>
              <span className="kb-badge bg-muted tabular-nums text-muted-foreground" title="Карточек на доске">
                <span className="sr-only">Карточек </span>{matches.length + issueMatches.length}
              </span>
            </div>
            <Button variant="outline" size="sm" className="kb-merge-nav"
              onClick={() => navigate.toPluginPanel(panelPath, { subPath: "merges" })}>
              <KanbanIcon name="merge" /> Слияния
            </Button>
            <ViewSwitch label="Вид задач" options={[
              { name: "Доска", icon: "board", selected: !listView, select: () => setListView(false) },
              { name: "Список", icon: "list", selected: listView, select: () => setListView(true) },
            ]} />
          </div>
          <div className="kb-toolbar-controls">
            <div className="kb-search text-muted-foreground">
              <KanbanIcon name="search" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)}
                className="h-9 w-full bg-background text-foreground" placeholder="Поиск по задачам, чатам и меткам" aria-label="Найти задачу" />
            </div>
            <select aria-label="Проект" value={projectId} onChange={(event) => {
              setProjectId(event.target.value);
              setTagFilter("");
              setAssigneeFilter("");
            }} className={filterSelect}>
              <option value="">Все проекты</option>
              {Array.from(projects, ([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <Button variant="outline" size="sm" className="kb-create-project" aria-label="Создать проект"
              onClick={() => setCreatingProject(true)}>
              <Icon name="FolderPlus" /><span className="kb-create-project-label">Создать проект</span>
            </Button>
            <Popover.Root>
              <Popover.Trigger asChild title={activeFilters ? `Поиск и фильтры: ${activeFilters}` : "Поиск и фильтры"}>
                <Button variant="outline" size="sm" className="kb-filter-trigger h-9 gap-1.5 px-2.5"
                  aria-label={`Поиск и фильтры${activeFilters ? `: ${activeFilters}` : ""}`}>
                  <KanbanIcon name="filters" /><span className="kb-desktop-filter-label"
                    title={activeFilters || "Найти задачи и настроить фильтры"}>{listView ? "Фильтры" : "Поиск и фильтры"}</span>
                  <span className="kb-mobile-filter-caption"><span>{listView ? "Фильтры" : "Поиск и фильтры"}</span>
                    <span>{activeFilters || `${matches.length + issueMatches.length} задач${listView ? "" : " · Доска"}`}</span>
                  </span>
                  {(filterCount > 0 || !!query.trim()) && <span className="kb-badge bg-muted text-foreground">{filterCount + Number(!!query.trim())}</span>}
                </Button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content {...portalScope} align="end" sideOffset={8} collisionPadding={12}
                  onOpenAutoFocus={(event) => {
                    if (window.matchMedia?.("(min-width: 761px) and (pointer: fine), (min-width: 951px)")?.matches) {
                      event.preventDefault(); filterSearch.current?.focus();
                    }
                  }}
                  className="kb-filter-popover z-[100] w-80 space-y-3 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold">Поиск и фильтры</h2>
                    <Popover.Close asChild>
                      <button type="button" aria-label="Закрыть фильтры" className="kb-icon-button"><KanbanIcon name="close" /></button>
                    </Popover.Close>
                  </div>
                  <div className="kb-mobile-search kb-search text-muted-foreground">
                    <KanbanIcon name="search" />
                    <Input ref={filterSearch} value={query} onChange={(event) => setQuery(event.target.value)}
                      placeholder="Найти задачу" aria-label="Найти задачу" />
                  </div>
                  {activeFilters && <p className="kb-active-filters text-xs text-muted-foreground">{activeFilters}</p>}
                  <div className="grid grid-cols-2 gap-2">
                    <select aria-label="Метка" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} className={filterSelect}>
                      <option value="">Все метки</option>
                      {tags.map((tag) => <option key={tag}>{tag}</option>)}
                    </select>
                    <select aria-label="Исполнитель" value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.target.value)} className={filterSelect}>
                      <option value="">Все исполнители</option>
                      {assignees.map((assignee) => <option key={assignee}>{assignee}</option>)}
                    </select>
                    <select aria-label="Приоритет" value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)} className={filterSelect}>
                      <option value="">Все приоритеты</option>
                      {Object.entries(priorities).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                    </select>
                    <select aria-label="Сортировка" value={sort} onChange={(event) => setSort(event.target.value)} className={filterSelect}>
                      <option value="updated">По активности</option>
                      <option value="created">По созданию</option>
                      <option value="priority">По приоритету</option>
                      <option value="manual">Вручную</option>
                    </select>
                  </div>
                  <div className="space-y-2 border-t border-border pt-2 text-sm">
                    {[
                      { label: "Требуется ввод", checked: attentionOnly, set: setAttentionOnly },
                      { label: "Показывать подзадачи", checked: showSubtasks, set: setShowSubtasks },
                      { label: "Скрывать заблокированные", checked: hideBlocked, set: setHideBlocked },
                      { label: "Отменённые", checked: showCancelled, set: setShowCancelled },
                      { label: "Показывать архивные чаты", checked: archive, set: setArchive },
                      { label: "Скрытые", checked: hidden, set: setHidden },
                    ].map((filter) => (
                      <label key={filter.label} className="flex min-h-6 cursor-pointer items-center gap-2">
                        <input type="checkbox" checked={filter.checked} onChange={(event) => filter.set(event.target.checked)} />
                        {filter.label}
                      </label>
                    ))}
                  </div>
                  <Button variant="ghost" size="sm" onClick={resetFilters}>Сбросить фильтры</Button>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
            <Button variant={selection ? "secondary" : "ghost"} size="sm" className="kb-select-tasks h-9 px-2.5" aria-label="Выбрать задачи"
              aria-pressed={selection !== null} disabled={bulkPending} onClick={toggleSelectionMode}>
              <KanbanIcon name="check" /><span className="kb-select-label">Выбрать</span>
            </Button>
            <div className="kb-mobile-board-menu">
              <CardMenu label={`Действия доски · ${listView ? "Список" : "Доска"}`} groups={[
                { label: "Вид задач", items: [
                  { label: `${!listView ? "✓ " : ""}Доска`, action: () => setListView(false) },
                  { label: `${listView ? "✓ " : ""}Список`, action: () => setListView(true) },
                ] },
                { label: "Действия", items: [
                  { label: selection ? "Выйти из выбора" : "Выбрать задачи", disabled: bulkPending, action: toggleSelectionMode },
                  { label: "Слияния", action: () => navigate.toPluginPanel(panelPath, { subPath: "merges" }) },
                ] },
              ]} />
            </div>
          </div>
        </div>
      )}
      {!branchView && listView && <div className="kb-list-controls">
        <div className="kb-search text-muted-foreground"><KanbanIcon name="search" />
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти задачу или чат" aria-label="Поиск в списке" />
        </div>
        <label className="kb-list-sort"><span>Порядок</span><select aria-label="Порядок списка" value={sort} onChange={(event) => setSort(event.target.value)}>
          <option value="updated">По активности</option><option value="created">По созданию</option>
          <option value="priority">По приоритету</option><option value="manual">Вручную</option>
        </select></label>
        <Button variant={selection ? "secondary" : "outline"} aria-pressed={selection !== null} disabled={bulkPending} onClick={toggleSelectionMode}>
          <KanbanIcon name="check" />{selection ? "Отменить выбор" : "Выбрать"}
        </Button>
      </div>}
      {!branchView && listView && activeFilters && <div className="kb-list-filter-summary">
        <span>{activeFilters}</span><button type="button" onClick={resetFilters}>Сбросить</button>
      </div>}
      {selection && (
        <div className="kb-selection-bar border-b border-border text-xs" role="group" aria-label="Действия с выбранными карточками">
          <span className="tabular-nums text-muted-foreground">Выбрано · {selectedIssues.length + selectedThreads.length}</span>
          {!branchView && <select aria-label="Переместить выбранные задачи" value="" disabled={bulkPending || !issueMatches.some((issue) => selection.has(issue.id))}
            onChange={(event) => { if (event.target.value) void moveSelected(issueStatus.parse(event.target.value)); }}
            className="rounded-md border border-input bg-background px-2 py-1">
            <option value="">Переместить в…</option>
            {issueStages.map((stage) => <option key={stage.id} value={stage.id}>{stage.label}</option>)}
          </select>}
          <Button size="sm" variant="outline" disabled={!selectedIssues.length && !selectedThreads.length}
            onClick={() => void openMerge({ mode: "selected", issueIds: selectedIssues, threadIds: selectedThreads })}>
            <KanbanIcon name="merge" /> Слить выбранные
          </Button>
          <Button size="icon" variant="ghost" className="size-7" aria-label="Выйти из выбора" onClick={() => setSelection(null)}>
            <KanbanIcon name="close" />
          </Button>
        </div>
      )}
      {issueQuery.error && <div role="alert" className="kb-list-error"><span>Не удалось обновить задачи. {issueQuery.error.message}</span>
        <Button variant="outline" onClick={() => void issueQuery.refetch()}>Повторить</Button></div>}
      {!branchView && compact && !listView && <>
        <MobileStageNavigation stages={visibleStages.map((stage) => ({ ...stage, count: stageCounts.get(stage.id) ?? 0 }))}
          value={currentStage.id} onChange={(id) => setFocusedStage(issueStatus.parse(id))} onDropStage={(stage, event) => {
            const id = event.dataTransfer.getData(issueDragType);
            if (!id) return;
            event.preventDefault();
            const status = issueStatus.parse(stage);
            void moveIssue(id, status);
            setFocusedStage(status);
          }} />
        <div role="group" aria-label="Этапы доски" className="kb-stage-picker border-b border-border">
          {visibleStages.map((stage) => (
            <button key={stage.id} type="button" className="kb-stage-tab kb-stage-heading" data-stage={stage.id}
              title={stage.label}
              aria-label={`Этап: ${stage.label}, карточек ${stageCounts.get(stage.id) ?? 0}`}
              aria-pressed={currentStage.id === stage.id} onClick={() => setFocusedStage(stage.id)}
              onDragOver={(event) => { if (event.dataTransfer.types.includes(issueDragType)) event.preventDefault(); }}
              onDrop={(event) => {
                const id = event.dataTransfer.getData(issueDragType);
                if (!id) return;
                event.preventDefault();
                void moveIssue(id, stage.id);
                setFocusedStage(stage.id);
              }}>
              <StageHeading label={stage.label} count={stageCounts.get(stage.id) ?? 0} />
            </button>
          ))}
        </div>
      </>}
      {issueTreeId ? (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {issueTreeRoot ? (
            <section className="mx-auto max-w-4xl space-y-3">
              <div className="kb-tree-heading">
                <h2 className="text-base font-semibold">Дерево подзадач</h2>
                {projectNames.get(issueTreeRoot.projectId) && <p className="text-xs text-muted-foreground">{projectNames.get(issueTreeRoot.projectId)}</p>}
              </div>
              <IssueTree root={issueTreeRoot} issues={issues} openTask={(issue) => openIssue(panel, issue, { reuse: true })} openTree={openTree}
                derive={setDerivation} selection={selection} select={toggleSelection} worktrees={worktrees} remove={requestDelete}
                chatActions={linkedChatActions} />
            </section>
          ) : <p className="text-sm text-muted-foreground">{issueQuery.isLoading ? "Загружаю дерево…" : issueQuery.error?.message ?? "Ветка задачи не найдена."}</p>}
        </div>
      ) : branchId ? (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <ChatBranch key={branchId} id={branchId} index={index} hidden={hidden} projects={projectNames} start={start}
            derive={setDerivation} issueOwners={issueOwners} openTree={openTree} revision={branchRevision}
            selection={selection} select={toggleSelection} archiveParents={archiveParents} changeArchive={changeArchive} />
        </div>
      ) : data.status === "loading" || (listView && issueQuery.isLoading && !issueQuery.data) ? <p role="status" className="p-4 text-sm text-muted-foreground">Загружаю задачи и чаты…</p>
        : data.status === "error" ? <p role="alert" className="p-4 text-sm text-destructive">BB не смог загрузить чаты. Обновите страницу, чтобы повторить загрузку.</p>
        : (
          <div className="kb-scroll" ref={scrollRef} onScroll={saveScroll}>
            <div className={listView ? "kb-list-content" : undefined}
              style={showColumns ? { minWidth: `${boardMinWidth}rem` } : undefined}>
              {showColumns && (
                <div className={`sticky top-0 z-10 bg-background pb-2 pt-3 ${grid}`} style={gridStyle}>
                  {visibleStages.map((column) => {
                    const folded = collapsedStages.has(column.id);
                    const count = stageCounts.get(column.id) ?? 0;
                    return (
                      <button key={column.id} type="button" aria-expanded={!folded} data-folded={folded}
                        aria-label={`${folded ? "Развернуть" : "Свернуть"} колонку «${column.label}», карточек ${count}`}
                        title={`${column.label} · ${count}`}
                        onClick={() => toggleStage(column.id)}
                        className="kb-column-toggle kb-stage-heading" data-stage={column.id}>
                        <StageHeading label={column.label} count={count} folded={folded} />
                      </button>
                    );
                  })}
                </div>
              )}
              {Array.from(projects, ([id, name]) => {
                if (projectId && projectId !== id) return null;
                const cards = grouped.get(id) ?? [];
                const projectIssues = issueMatches.filter((issue) => groupOf(issue.projectId) === id);
                const renderIssue = (issue: Issue) => <IssueCard key={issue.id} issue={issue} issues={issues} index={index}
                  move={moveIssue} selection={selection} toggle={toggleSelection} derive={setDerivation}
                  worktrees={worktrees} remove={requestDelete} chatActions={linkedChatActions} archived={isIssueArchived(issue)} listView={listView} />;
                const renderThread = (thread: Thread) => <ThreadCard key={thread.id} thread={thread} index={index} start={start}
                  plan={plans[thread.id]} createIssue={() => void createIssue(thread.projectId, legacyStage[stageOf(thread)], thread.id)} derive={setDerivation}
                  selection={selection} toggle={toggleSelection} worktrees={worktrees} changeArchive={changeArchive} listView={listView} />;
                const listItems = listView ? [
                  ...projectIssues.map((issue) => ({ id: issue.id, updatedAt: issue.updatedAt, createdAt: issue.createdAt,
                    priority: issue.priority, order: issue.order, stage: issue.status, render: () => renderIssue(issue) })),
                  ...cards.map((thread) => ({ id: thread.id, updatedAt: thread.updatedAt, createdAt: thread.createdAt,
                    priority: plans[thread.id]?.priority, stage: legacyStage[stageOf(thread)], render: () => renderThread(thread) })),
                ].sort((a, b) => compareListItems(a, b, sort)) : [];
                if (isFiltered && !cards.length && !projectIssues.length) return null;
                const visibleCount = compact && !listView
                  ? cards.filter((card) => legacyStage[stageOf(card)] === currentStage.id).length +
                    projectIssues.filter((issue) => issue.status === currentStage.id).length
                  : cards.length + projectIssues.length;
                const expanded = projectExpansion.get(id) ?? visibleCount > 0;
                return (
                  <section key={id} className="kb-project" aria-label={name}>
                    <div className="kb-project-heading">
                      <div className="kb-project-title">
                        <Button variant="ghost" size="sm" aria-expanded={expanded}
                          className="min-w-0 justify-start gap-1.5 px-1.5 text-sm font-semibold"
                          onClick={() => setProjectExpansion((previous) => new Map(previous).set(id, !expanded))}>
                          <Icon name={expanded ? "ChevronDown" : "ChevronRight"} />
                          <span className="min-w-0 truncate" title={name}>{name}</span>
                          <span className="kb-badge bg-muted tabular-nums text-muted-foreground">{visibleCount}</span>
                        </Button>
                        <CardMenu label={`Действия с проектом: ${name}`} groups={[...(listView ? [{ label: "Создать", items: [
                          { label: "Задачу в бэклоге", disabled: creating || !!issueQuery.error, action: () => void createIssue(id, "backlog") },
                          { label: "Задачу к выполнению", disabled: creating || !!issueQuery.error, action: () => void createIssue(id, "todo") },
                          { label: "Новый чат", action: () => navigate.toCompose({ projectId: id, focusPrompt: true }) },
                        ] }] : []), {
                          label: data.projects.find((project) => project.id === id)?.isPersonal ? "Personal — системный проект" : "Управление проектом",
                          items: [
                            { label: "Переименовать", disabled: !data.projects.some((project) => project.id === id && !project.isPersonal),
                              action: () => setProjectTarget({ id, name, kind: "rename" }) },
                            ...(id === personalProjectId ? [{ label: "Вернуть проект в канбан…", disabled: !restoreProjects.length,
                              action: () => setProjectTarget({ id, name, kind: "restore" }) }] : [{
                              label: "Убрать проект…", disabled: !personalGroups.data || !data.projects.some((project) => project.id === id && !project.isPersonal),
                              action: () => setProjectTarget({ id, name, kind: "remove" }),
                            }]),
                            { label: "Поднять выше", disabled: movingProject || !projectOrder.data || !personalGroups.data || projectIds.indexOf(id) <= 0,
                              action: () => void changeProjectOrder(id, "up") },
                            { label: "Опустить ниже", disabled: movingProject || !projectOrder.data || !personalGroups.data || !projectIds.includes(id) || projectIds.indexOf(id) === projectIds.length - 1,
                              action: () => void changeProjectOrder(id, "down") },
                          ],
                        }]} />
                      </div>
                      <div className="kb-project-actions">
                        <Button variant="outline" size="sm" className="gap-1 px-2" disabled={creating || !!issueQuery.error}
                          aria-label="+ Задача" onClick={() => void createIssue(id, "backlog")}>
                          <KanbanIcon name="plus" /> Задача
                        </Button>
                        <Button variant="ghost" size="sm" className="gap-1 px-2 text-muted-foreground" aria-label="+ Чат"
                          onClick={() => navigate.toCompose({ projectId: id, focusPrompt: true })}>
                          <KanbanIcon name="chat" /> Чат
                        </Button>
                      </div>
                    </div>
                    {expanded && (
                      <div className={`kb-project-grid ${grid}`} style={gridStyle}>
                        {listView && visibleCount === 0 && <p className="kb-list-empty">В проекте пока нет задач. Создайте задачу или чат в заголовке проекта.</p>}
                        {listView ? listItems.map((item) => item.render()) : shownStages.map((column) => {
                          const lane = cards.filter((card) => legacyStage[stageOf(card)] === column.id);
                          const issueLane = projectIssues.filter((issue) => issue.status === column.id);
                          const folded = showColumns && collapsedStages.has(column.id);
                          const canCreate = initialIssueStatus.safeParse(column.id).success;
                          const count = lane.length + issueLane.length;
                          return (
                            <div key={column.id} role="group" aria-label={`${name} · ${column.label}`} data-folded={folded}
                              className={`kb-lane ${folded ? "bg-muted/20" : "flex flex-col gap-1.5 bg-muted/30"}`}
                              onDragOver={(event) => { if (event.dataTransfer.types.includes(issueDragType)) event.preventDefault(); }}
                              onDrop={(event) => {
                                const issueId = event.dataTransfer.getData(issueDragType);
                                if (issueId && issues.some((item) => item.id === issueId && groupOf(item.projectId) === id)) {
                                  event.preventDefault();
                                  void moveIssue(issueId, column.id);
                                }
                              }}>
                              {folded ? (
                                <button type="button" onClick={() => toggleStage(column.id)}
                                  aria-label={`Развернуть колонку «${column.label}» в проекте ${name}, карточек ${count}`}
                                  className="kb-rail text-xs text-muted-foreground">
                                  <span className="kb-rail-label text-[11px]">{column.label}</span>
                                  <span className="kb-badge bg-muted tabular-nums text-foreground">{count}</span>
                                </button>
                              ) : (
                                <>
                                  {issueLane.map(renderIssue)}
                                  {lane.map(renderThread)}
                                  {count === 0 && compact && !canCreate && <p className="px-2 py-1.5 text-xs text-muted-foreground">В этом этапе пока пусто.</p>}
                                  {canCreate && (
                                    <button type="button" className="kb-lane-add" data-empty={count === 0} disabled={creating || !!issueQuery.error}
                                      aria-label={`Создать задачу в колонке «${column.label}»`}
                                      title={`Создать задачу в колонке «${column.label}»`}
                                      onClick={() => void createIssue(id, column.id)}>
                                      <KanbanIcon name="plus" />
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              })}
              {isFiltered && !matches.length && !issueMatches.length && (
                <div className="mx-auto my-8 max-w-sm rounded-xl border border-dashed border-border p-5 text-center">
                  <h2 role="status" className="text-sm font-semibold">Карточки не найдены</h2>
                  <p className="mt-1 text-xs text-muted-foreground">Попробуй изменить запрос или сбросить фильтры.</p>
                  <Button variant="ghost" size="sm" className="mt-2" onClick={resetFilters}>Сбросить фильтры</Button>
                </div>
              )}
            </div>
          </div>
        )}
      {!branchView && archiveState && (archiveMore || archiveState.status !== "ready") && (
        <div className="flex items-center gap-2 border-t border-border px-4 py-2">
          {archiveState.status === "loading" && <span role="status" className="text-xs text-muted-foreground">Загружаю архив…</span>}
          {archiveState.status === "error" && <span role="alert" className="text-xs text-destructive">BB не смог загрузить архив.</span>}
          {archiveMore && (
            <Button variant="outline" size="sm" disabled={archiveState.isFetchingNextPage}
              onClick={() => { void archiveState.fetchNextPage().catch(() => {}); }}>
              {archiveState.isFetchingNextPage ? "Загружаю…" : archiveState.isFetchNextPageError ? "Повторить загрузку архива" : "Загрузить ещё из архива"}
            </Button>
          )}
        </div>
      )}
      {creatingProject && <CreateProjectDialog close={() => setCreatingProject(false)} created={(project) => {
        setCreatedProject(project);
        setProjectExpansion((previous) => new Map(previous).set(project.id, true));
        refreshProjects();
        toast.success(`Проект «${project.name}» создан`, { action: {
          label: "Показать проект",
          onClick: () => {
            setProjectId(project.id);
            setQuery("");
            setTagFilter("");
            setAssigneeFilter("");
            setPriorityFilter("");
            setAttentionOnly(false);
            setHideBlocked(false);
            setShowSubtasks(true);
          },
        } });
      }} />}
      {projectTarget && <ProjectDialog key={`${projectTarget.kind}:${projectTarget.id}`} target={projectTarget}
        restoreProjects={restoreProjects} close={() => setProjectTarget(null)} changed={(mode) => {
          refreshProjects();
          if (projectId === projectTarget.id && (mode === "personal" || mode === "delete")) setProjectId(personalProjectId);
          if (mode === "delete") void issueQuery.refetch();
        }} />}
      {operation && <OperationDialog key={`${operation.kind}:${operation.thread.id}`}
        operation={operation} index={index} close={() => setOperation(null)} changed={() => setBranchRevision((current) => current + 1)} />}
      {derivation && <DeriveDialog request={derivation} close={() => setDerivation(null)}
        start={derivationActivity.start} />}
      {deleteIssue && <DeleteIssueDialog issue={deleteIssue} close={() => setDeleteId(null)} deleted={(issue) => {
        setSelection((current) => {
          if (!current?.has(issue.id)) return current;
          const next = new Set(current);
          next.delete(issue.id);
          return next;
        });
        if (issueTreeId === issue.id) {
          if (issue.parentId) openTree(issue.parentId);
          else navigate.toPluginPanel(panelPath);
        }
        void issueQuery.refetch();
      }} />}
    </main>
  );
}

export default definePluginApp((app) => {
  registerSettingsUi(app);
  app.contentScripts.register({ id: "agent-generation", mount({ generation }) { setAgentGeneration(generation); } });
  app.contentScripts.register({ id: "panel-context", mount({ pluginId }) {
    setContextPluginId(pluginId);
    return mountPanelStyles();
  } });
  app.slots.experimental_appOverlay({ id: "agent-observer", component: KanbanAgentBridge });
  app.slots.experimental_appOverlay({ id: "status-contribution", component: StatusContribution });
  app.slots.experimental_appOverlay({ id: 'global-status-bar', component: GlobalStatusBar });
  app.slots.navPanel({
    id: "board",
    title: "Канбан",
    icon: "Columns",
    path: panelPath,
    component: KanbanPage,
  });
  app.slots.experimental_tab({
    ...workspaceTab,
    title: "Рабочая область",
    icon: "MessageSquare",
    layout: "flush",
    component: LegacyWorkspacePanel,
    run: ({ experimental_panel }) => {
      createPanelTab(experimental_panel);
    },
  });
  app.slots.experimental_tab({
    ...issueTab,
    title: "Карточка",
    icon: "FileText",
    layout: "flush",
    component: LegacyIssuePanel,
    run: ({ experimental_panel }) => {
      createPanelTab(experimental_panel);
    },
  });
  app.slots.experimental_tab({ ...contextTab, title: "Новая вкладка", icon: "MessageSquare", layout: "flush", component: ContextPanel,
    run: ({ experimental_panel }) => {
      createPanelTab(experimental_panel);
    },
  });
});
