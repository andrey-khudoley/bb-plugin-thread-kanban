import { changed as settingsChanged } from "./settings-contract";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { z } from "zod";
import {
  experimental_useAppPanel,
  experimental_useProviders,
  experimental_useRpcQuery,
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
  useBbNavigate,
  type ExperimentalPanelController,
  type ReadonlyJsonValue,
} from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { DeleteIssueDialog } from "./delete-issue-dialog";
import { fieldsSchema, issueRpc, issuesChanged, issueStages, issueStatus, personalProjectId, type Issue, type IssueFields } from "./issues";
import { priorities } from "./planning";
import { openChatWorkspace, Workspace, WorkspaceTools, workspaceViews, type WorkspaceView } from "./workspace";
import { CardMenu, ViewSwitch } from "./kanban-ui";
import { contextActions, DeriveDialog, type DeriveDialogRequest } from "./derive-dialog";
import { useDerivationActivity } from "./derive-activity";
import { IssueTree, issueTitle } from "./issue-tree";
import { createDraftStore } from "./panel-drafts";
import { focusedSection, focusOpenCard, openPanelContext } from "./panel-context-actions";
import { usePanelSection } from "./panel-section-ui";
import { sectionStore } from "./panel-context";
import { usePanelState } from "./panel-view-state";
import { PanelHeading } from "./panel-heading";
import { TagColorEditor } from './tag-colors-ui';
import { FolderAssignment, useProjectFolders } from './project-folders-ui';

export const issueTab = {
  id: "issue",
  context: { kind: "nav-panel", panelId: "board" },
  availability: "action",
} as const;

// Explicit navigation starts a new request; selecting an open card leaves it intact.
let openRequest = Date.now();

export function openIssue(panel: ExperimentalPanelController, issue: Issue, { threadId, startWithAssistant = false, reuse = false }: {
  threadId?: string; startWithAssistant?: boolean; reuse?: boolean;
} = {}) {
  if (reuse) {
    const result = focusOpenCard(panel, {kind: 'issue', issueId: issue.id});
    if (result === 'focused') {
      if (threadId) {
        // Native selection is published after React commits; use the section just selected.
        const id = focusedSection;
        const context = id ? sectionStore.get(id).context : null;
        if (id && context?.kind === 'issue' && context.issueId === issue.id
          && (context.threadId !== threadId || context.view !== 'chat'))
          sectionStore.replace(id, { ...context, threadId, view: 'chat', request: ++openRequest });
      }
      return;
    }
    if (result === 'failed') { toast.error("Не удалось переключить вкладку карточки."); return; }
  }
  if (!openPanelContext(panel, { kind: 'issue', issueId: issue.id, request: ++openRequest,
    threadId: threadId ?? issue.threadIds.at(-1) ?? null, startWithAssistant, title: issueTitle(issue) })) {
    toast.error("Не удалось открыть карточку.");
  }
}

export function useIssues() {
  const query = experimental_useRpcQuery({ contract: issueRpc, method: "issueList", input: null });
  useRealtime(issuesChanged, () => { void query.refetch(); });
  return query;
}

const control = "min-w-0 w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm";
const heading = "text-sm font-semibold";
const messageText = (error: unknown) => error instanceof Error ? error.message : String(error);

const textFields = [
  { key: "title", label: "Название", rows: 2, maxLength: 180, auto: "autoTitle" },
  { key: "description", label: "Описание", rows: 3, maxLength: 12000 },
  { key: "notes", label: "План", rows: 5, maxLength: 12000, auto: "autoPlan" },
  { key: "executionPrompt", label: "Промпт запуска", rows: 5, maxLength: 12000 },
] as const;
type TextField = typeof textFields[number];
const textEditSchema = z.object({
  key: z.enum(["title", "description", "notes", "executionPrompt"]),
  value: z.string().max(12000),
});
type TextEdit = z.infer<typeof textEditSchema>;
const formDraftSchema = z.object({
  patch: fieldsSchema.pick({
    autoTitle: true, autoPlan: true,
    parentId: true, duplicateOf: true, blockedBy: true, related: true,
  }).partial().extend({
    priority: fieldsSchema.shape.priority.removeDefault().optional(),
    assignee: z.string().max(120).optional(),
    context: fieldsSchema.shape.context.removeDefault().optional(),
  }),
  tags: z.string().nullable(),
});
type FormDraft = z.infer<typeof formDraftSchema>;
const formDraftFor = createDraftStore<FormDraft>("issue-form", { patch: {}, tags: null }, formDraftSchema.parse);
const textDraftFor = createDraftStore<TextEdit | null>("issue-text", null, textEditSchema.parse);
const promptDraftFor = createDraftStore("issue-chat", { text: "" }, z.object({ text: z.string().max(12000) }).parse);

type TaskView = "overview" | "planning" | "relations" | "work" | "plan";
type IssueView = TaskView | WorkspaceView;

function LaunchSettings({ id, providerId, worktree, overrides, onChange, onReady }: {
  id: string; providerId: string; worktree: boolean;
  overrides: { reasoningLevel?: string; serviceTier?: string };
  onChange: (value: { reasoningLevel?: string; serviceTier?: string }) => void;
  onReady: (ready: boolean) => void;
}) {
  const query = experimental_useRpcQuery({ contract: issueRpc, method: "issueLaunchOptions",
    input: { id, ...(providerId ? { providerId } : {}), worktree } });
  useRealtime(settingsChanged, () => void query.refetch());
  useEffect(() => { onReady(Boolean(query.data && !query.error)); }, [query.data, query.error, onReady]);
  if (query.error) return <p role="alert">Не удалось загрузить настройки запуска. {messageText(query.error)}
    <button type="button" onClick={() => void query.refetch()}>Повторить</button></p>;
  if (!query.data) return <p role="status">Загрузка настроек запуска…</p>;
  const { selection, modelLabel, efforts, speeds, warning } = query.data;
  return <>
    <p className="text-xs text-muted-foreground">Модель · {modelLabel}</p>
    <label className="block text-sm">Уровень усилия
      <select aria-label="Усилие для запуска" className={control} value={overrides.reasoningLevel ?? ""}
        disabled={!efforts.length} onChange={(event) => onChange({ ...overrides, reasoningLevel: event.target.value || undefined })}>
        <option value="">Из настроек канбана · {selection.reasoningLevel ?? "по настройкам BB"}</option>
        {efforts.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
      </select>
    </label>
    <label className="block text-sm">Скорость
      <select aria-label="Скорость для запуска" className={control} value={overrides.serviceTier ?? ""}
        disabled={!speeds.length} onChange={(event) => onChange({ ...overrides, serviceTier: event.target.value || undefined })}>
        <option value="">Из настроек канбана · {speeds.find(({ id }) => id === selection.serviceTier)?.label ?? selection.serviceTier ?? "по настройкам BB"}</option>
        {speeds.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
      </select>
    </label>
    <p className="text-xs text-muted-foreground">Ручной выбор действует только для этого запуска.</p>
    {warning && <p role="alert">{warning}</p>}
  </>;
}

function isTaskView(view: IssueView): view is TaskView {
  return view !== "chat" && view !== "changes";
}

function IssueEditor({ issue: loadedIssue, issues, refresh, requestId, initialThreadId, startWithAssistant, restoredView }: {
  issue: Issue; issues: Issue[]; refresh: () => Promise<void>; requestId: number | null;
  initialThreadId: string | null; startWithAssistant: boolean;
  restoredView: IssueView | null;
}) {
  const panel = experimental_useAppPanel();
  const folders = useProjectFolders();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof issueRpc>();
  const providers = experimental_useProviders().providers;
  const sidebar = experimental_useSidebarThreads();
  const threads = sidebar.threads;
  const [savedIssue, setSavedIssue] = useState<Issue | null>(null);
  const issue = savedIssue && savedIssue.version > loadedIssue.version ? savedIssue : loadedIssue;
  const formDraft = formDraftFor(issue.id);
  const textDraft = textDraftFor(issue.id);
  const promptDraft = promptDraftFor(issue.id);
  const form = useSyncExternalStore(formDraft.subscribe, formDraft.get);
  const textEdit = useSyncExternalStore(textDraft.subscribe, textDraft.get);
  const prompt = useSyncExternalStore(promptDraft.subscribe, promptDraft.get);
  const { patch, tags } = form;
  const [textError, setTextError] = useState<{ edit: TextEdit; message: string } | null>(null);
  const returnFocus = useRef<TextField["key"] | null>(null);
  const [providerId, setProvider] = usePanelState(`${issue.id}:provider`, "");
  const [executionOverrides, setExecutionOverrides] = usePanelState<{ reasoningLevel?: string; serviceTier?: string }>(`${issue.id}:execution-overrides`, {});
  const [launchReady, setLaunchReady] = useState(false);
  const [worktree, setWorktree] = usePanelState(`${issue.id}:worktree`, false);
  const [sourceThreadId, setSource] = usePanelState(`${issue.id}:source-thread`, "");
  const [link, setLink] = usePanelState(`${issue.id}:link`, "");
  const [request, setRequest] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const deleteIssue = issues.find((candidate) => candidate.id === deleteId);
  const [derivation, setDerivation] = useState<DeriveDialogRequest | null>(null);
  const derivationActivity = useDerivationActivity(`issue:${issue.id}`);
  const [error, setError] = useState("");
  const taskView = startWithAssistant ? "planning" : "overview";
  const initialView = restoredView ?? (issue.threadIds.length > 0 ? "chat" : taskView);
  const initial = { requestId, view: initialView, taskView, threadId: initialThreadId } as const;
  const [active, setActive] = usePanelState<{
    requestId: number | null; view: IssueView; taskView: TaskView; threadId: string | null;
  }>(`${issue.id}:active`, initial);
  if (active.requestId !== requestId) {
    setActive(initial);
  }
  const threadId = active.threadId && issue.threadIds.includes(active.threadId)
    ? active.threadId : issue.threadIds.at(-1);
  const workspaceView = workspaceViews.find((option) => option.view === active.view)?.view;
  const section = usePanelSection();
  useEffect(() => {
    if (!section) return;
    const context = sectionStore.get(section).context;
    const openedThread = workspaceView ? threadId ?? null : null;
    const title = issueTitle(issue);
    if (context?.kind === 'issue' && context.issueId === issue.id && (context.threadId !== openedThread || context.view !== active.view || context.title !== title))
      sectionStore.replace(section, { ...context, threadId: openedThread, view: active.view, title });
  }, [section, issue.id, issue.title, threadId, workspaceView, active.view]);
  const view = !threadId && workspaceView ? "overview" : active.view;
  const setView = (next: IssueView) => setActive((previous) => ({
    ...previous, view: next, taskView: isTaskView(next) ? next : previous.taskView,
  }));
  const showChat = (id: string) => setActive((previous) => ({ ...previous, view: "chat", threadId: id }));
  const fields = { ...fieldsSchema.parse(issue), ...patch };
  const personal = issue.projectId === personalProjectId;
  const dirty = Object.keys(patch).length > 0 || tags !== null;
  const candidates = issues.filter((other) => other.projectId === issue.projectId && other.id !== issue.id);
  const children = candidates.filter((child) => child.parentId === issue.id);
  const origin = issue.origin && candidates.find((candidate) => candidate.id === issue.origin?.issueId);
  const openTree = (id: string) => navigate.toPluginPanel("board", { subPath: `issue-tree/${id}` });
  const incoming = candidates.filter((other) => other.blockedBy.includes(issue.id) || other.related.includes(issue.id) || other.duplicateOf === issue.id);
  const blocked = fields.blockedBy.some((id) => candidates.some((item) => item.id === id && !["done", "cancelled"].includes(item.status)));
  const linked = new Set(issues.flatMap((item) => item.threadIds));
  const available = threads.filter((thread) => thread.projectId === issue.projectId && !thread.isHidden && !linked.has(thread.id));
  const nameOf = (id: string) => threads.find((thread) => thread.id === id)?.displayTitle ?? id;

  function update<K extends keyof FormDraft["patch"]>(key: K, value: IssueFields[K]) {
    formDraft.update((current) => ({ ...current, patch: { ...current.patch, [key]: value } }));
  }
  async function run(action: () => Promise<void>, reportError: (message: string) => void = setError) {
    setRequest(true);
    setError("");
    try {
      await action();
      return true;
    } catch (cause) {
      reportError(messageText(cause));
      return false;
    } finally {
      await refresh();
      setRequest(false);
    }
  }
  async function saveFields(fields: IssueFields) {
    const checked = fieldsSchema.parse(fields);
    const updated = await rpc.call("issueSave", { id: issue.id, version: issue.version, fields: checked });
    setSavedIssue((current) => current && current.version > updated.version ? current : updated);
  }
  async function saveDraft() {
    const submitted = formDraft.get();
    if (Object.keys(submitted.patch).length === 0 && submitted.tags === null) return;
    await saveFields({
      ...fieldsSchema.parse(issue),
      ...submitted.patch,
      tags: submitted.tags === null ? issue.tags : [...new Set(submitted.tags.split(",").map((tag) => tag.trim()).filter(Boolean))],
    });
    formDraft.clear(submitted);
  }
  function closeTextEditor(edit: TextEdit) {
    if (textDraft.get() !== edit) return;
    returnFocus.current = edit.key;
    textDraft.clear(edit);
  }
  async function saveText(field: TextField, edit: TextEdit) {
    const auto = "auto" in field ? field.auto : undefined;
    const saved = await run(async () => {
      await saveFields({ ...issue, [field.key]: edit.value, ...(auto && { [auto]: false }) });
      if (auto) {
        formDraft.update((current) => {
          if (!(auto in current.patch) || current.patch[auto] !== patch[auto]) return current;
          const next = { ...current.patch };
          delete next[auto];
          return { ...current, patch: next };
        });
      }
    }, (message) => setTextError({ edit, message }));
    if (saved) closeTextEditor(edit);
  }
  function openOriginChat(id: string) {
    const owner = issues.find((item) => item.threadIds.includes(id));
    if (owner?.id === issue.id) showChat(id);
    else if (owner) openIssue(panel, owner, { threadId: id });
    else openChatWorkspace(panel, id, nameOf(id));
  }
  const selector = (value: string | null, change: (id: string | null) => void, label: string) => (
    <label className="block space-y-1 text-xs">
      <span>{label}</span>
      <select value={value ?? ""} className={control} onChange={(event) => change(event.target.value || null)}>
        <option value="">Нет</option>
        {candidates.map((item) => <option key={item.id} value={item.id}>{item.title || "Новая задача"}</option>)}
      </select>
    </label>
  );
  const multi = (key: "blockedBy" | "related", label: string) => (
    <label className="block space-y-1 text-xs">
      <span>{label}</span>
      <select multiple size={Math.min(4, Math.max(2, candidates.length))} value={fields[key]} className={control}
        onChange={(event) => update(key, Array.from(event.target.selectedOptions, (option) => option.value))}>
        {candidates.map((item) => <option key={item.id} value={item.id}>{item.title || "Новая задача"}</option>)}
      </select>
    </label>
  );

  return (
      <div className="kb-detail flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground"
        data-kanban-panel="issue" data-kanban-id={issue.id} data-kanban-tab={view} data-kanban-project={issue.projectId}>
      <header className="shrink-0" data-kanban-heading="compact">
        <PanelHeading title={fields.title || "Новая задача"}
          context={`Задача · ${sidebar.projects.find((project) => project.id === issue.projectId)?.name ?? "Personal"}`}
          status={
            <div className="kb-detail-status" title={`Этап задачи: ${issueStages.find((stage) => stage.id === issue.status)?.label}`}>
              <span className={`kb-detail-status-dot ${issueStages.find((stage) => stage.id === issue.status)?.dot}`} aria-hidden="true" />
              <select aria-label="Этап задачи" value={issue.status} disabled={request} onChange={(event) => {
                const status = issueStatus.parse(event.target.value);
                void run(async () => { await rpc.call("issueMove", { id: issue.id, status }); });
              }}>
                {issueStages.map((stage) => <option key={stage.id} value={stage.id}>{stage.label}</option>)}
              </select>
            </div>}
          actions={<>
            {threadId && <WorkspaceTools key={threadId} threadId={threadId} />}
            <CardMenu label="Действия с задачей" groups={[
              { label: "Навигация", items: [
                { label: "Открыть ветку задачи", action: () => openTree(issue.id) },
                { label: "Связи", action: () => setView("relations") },
              ] },
              ...(workspaceView && issue.threadIds.length > 1 ? [{ label: "Рабочие чаты", items: issue.threadIds.map((id) => ({
                id, label: `${id === threadId ? "✓ " : ""}${nameOf(id)}`, action: () => showChat(id),
              })) }] : []),
              contextActions({ kind: "issue", id: issue.id }, issueTitle(issue), setDerivation),
              { label: "Управление карточкой", items: [{ label: "Удалить карточку", destructive: true, action: () => setDeleteId(issue.id) }] },
            ]} />
          </>} />
        {(threadId || isTaskView(view)) && <div className={`kb-detail-nav-row${threadId ? "" : " kb-task-only-nav"}`} data-task-view={isTaskView(view)}>
          <select className={isTaskView(view) ? "kb-mobile-task-view" : "kb-mobile-section-picker"} aria-label="Раздел карточки" value={view}
            onChange={(event) => setView(event.target.value as typeof view)}>
            {threadId && <option value="chat">Чат</option>}
            <optgroup label="Задача">
              <option value="planning">Помощник</option><option value="overview">Описание</option>
              {threadId && <option value="plan">Заметки чата</option>}<option value="work">Запуск</option>
              <option value="relations">Связи</option>
            </optgroup>
            {threadId && <option value="changes">Изменения</option>}
          </select>
          {threadId && <ViewSwitch label="Разделы карточки" variant="sections" options={[
            { name: "Чат", selected: view === "chat", select: () => setView("chat") },
            { name: "Задача", selected: isTaskView(view), select: () => setView(active.taskView) },
            { name: "Изменения", selected: view === "changes", select: () => setView("changes") },
          ]} />}
        </div>}
        {isTaskView(view) && <div className="kb-detail-subnav">
          <ViewSwitch label="Разделы задачи" variant="subsections" options={[
            { name: "Помощник", selected: view === "planning", select: () => setView("planning") },
            { name: "Описание", selected: view === "overview", select: () => setView("overview") },
            ...(threadId ? [{ name: "Заметки чата", selected: view === "plan", select: () => setView("plan") }] : []),
            { name: "Связи", selected: view === "relations", select: () => setView("relations") },
            { name: "Запуск", accent: true, selected: view === "work", select: () => setView("work") },
          ]} />
        </div>}
        {workspaceView && issue.threadIds.length > 1 && (
          <label className="kb-detail-chat-picker">
            <span>Рабочий чат</span>
            <select className={control} value={threadId}
              onChange={(event) => { const id = event.target.value; setActive((previous) => ({ ...previous, threadId: id })); }}>
              {issue.threadIds.map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}
            </select>
          </label>
        )}
      </header>
      {threadId && <Workspace key={threadId} threadId={threadId} view={workspaceView ?? null} />}
      <div data-kanban-scroll="issue-content" hidden={!!threadId && !!workspaceView} className="min-h-0 flex-1 overflow-auto">
        <div className="kb-detail-content space-y-4">
        <fieldset hidden={view !== "overview"} aria-label="Поля задачи" disabled={request} className="min-w-0 space-y-3">
          <FolderAssignment issue={issue} folders={folders.data ?? []} changed={() => void refresh()} />
          {textFields.map((field) => {
            const { key, label, rows, maxLength } = field;
            const edit = textEdit?.key === key ? textEdit : null;
            const value = fields[key];
            return (
              <section key={key} aria-label={label} className="space-y-1 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <h3 className={heading}>{label}</h3>
                  {!edit && (
                    <Button type="button" variant="outline" size="sm" aria-label={`Изменить: ${label}`}
                      disabled={textEdit !== null}
                      ref={(button) => {
                        if (button && returnFocus.current === key) {
                          returnFocus.current = null;
                          button.focus();
                        }
                      }}
                      onClick={() => textDraft.update(() => ({ key, value }))}>Изменить</Button>
                  )}
                </div>
                {edit ? (
                  <form className="space-y-2" onSubmit={(event) => {
                    event.preventDefault();
                    if (!request && edit.value !== value) void saveText(field, edit);
                  }}>
                    <textarea autoFocus aria-label={label} className={control} rows={rows} maxLength={maxLength}
                      value={edit.value} onChange={(event) => textDraft.update(() => ({ key, value: event.target.value }))} />
                    {textError?.edit === edit && <p role="alert" className="kb-detail-text text-destructive">{textError.message}</p>}
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" size="sm" disabled={edit.value === value}>Сохранить</Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => closeTextEditor(edit)}>Отмена</Button>
                    </div>
                  </form>
                ) : value ? <p className="kb-detail-text">{value}</p>
                  : <p className="text-muted-foreground">Не заполнено</p>}
              </section>
            );
          })}
          {fields.context.length > 0 && (
            <details className="space-y-2 rounded-lg border border-border p-2.5">
              <summary className="cursor-pointer text-sm">Фрагменты контекста · {fields.context.length}</summary>
              {fields.context.map(({ label, text }, index) => (
                <div key={index} className="space-y-1 rounded-md bg-muted/30 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="break-words text-xs text-muted-foreground">{label}</span>
                    <Button type="button" variant="ghost" size="sm"
                      onClick={() => update("context", fields.context.filter((_, i) => i !== index))}>Убрать</Button>
                  </div>
                  <blockquote className="whitespace-pre-wrap break-words text-xs">{text}</blockquote>
                </div>
              ))}
            </details>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2 text-xs">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={fields.autoTitle} onChange={(event) => update("autoTitle", event.target.checked)} /> Обновлять название из чата
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={fields.autoPlan} onChange={(event) => update("autoPlan", event.target.checked)} /> Обновлять план из чата
            </label>
          </div>
          <div className="kb-detail-metadata">
            <label className="block space-y-1 text-xs">
              <span>Приоритет</span>
              <select value={fields.priority ?? ""} className={control}
                onChange={(event) => update("priority", (event.target.value || null) as IssueFields["priority"])}>
                <option value="">Без приоритета</option>
                {Object.entries(priorities).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
            <label className="block space-y-1 text-xs">
              <span>Исполнитель</span>
              <Input value={fields.assignee} maxLength={120} onChange={(event) => update("assignee", event.target.value)} />
            </label>
            <label className="block space-y-1 text-xs">
              <span>Метки через запятую</span>
              <Input value={tags ?? fields.tags.join(", ")}
                onChange={(event) => formDraft.update((current) => ({ ...current, tags: event.target.value }))} />
            </label>
            <TagColorEditor tags={(tags ?? fields.tags.join(',')).split(',')} />
          </div>
        </fieldset>

        <section hidden={view !== "planning"} aria-label="Чат постановки" className="space-y-3">
          <h3 className={heading}>Помощник по задаче</h3>
          {issue.messages.length === 0 && (
            <div className="rounded-xl border border-border bg-muted/30 px-3 py-3">
              <p className="text-sm font-medium">Что нужно сделать?</p>
              <p className="mt-1 text-sm text-muted-foreground">Опиши задачу помощнику, чтобы подготовить название и план перед запуском.</p>
            </div>
          )}
          <ol aria-label="Переписка" className="space-y-2 empty:hidden">
            {issue.messages.map((message, i) => (
              <li key={i} className={`whitespace-pre-wrap break-words rounded-md px-2.5 py-1.5 text-sm ${message.role === "user" ? "ml-6 bg-muted" : "mr-6 border border-border"}`}>
                <span className="block text-xs text-muted-foreground">{message.role === "user" ? "Ты" : "Помощник"}</span>
                {message.text}
              </li>
            ))}
          </ol>
          <form className="space-y-2" onSubmit={(event) => {
            event.preventDefault();
            const submitted = promptDraft.get();
            if (!submitted.text.trim() || request || issue.busy) return;
            void run(async () => {
              await saveDraft();
              const updated = await rpc.call("issueAsk", { id: issue.id, text: submitted.text });
              if (updated.error) throw new Error(updated.error);
              promptDraft.clear(submitted);
            });
          }}>
            <textarea aria-label="Сообщение о задаче" placeholder="Что нужно сделать?" rows={3} maxLength={12000} className={control}
              value={prompt.text} onChange={(event) => {
                const text = event.target.value;
                if (text) promptDraft.update(() => ({ text }));
                else promptDraft.clear();
              }} />
            <Button type="submit" size="sm" disabled={!prompt.text.trim() || request || !!issue.busy}>Отправить помощнику</Button>
            {prompt.text && <Button type="button" variant="ghost" size="sm" className="ml-1"
              onClick={() => promptDraft.clear()}>Сбросить черновик</Button>}
            {issue.notes && <Button type="button" variant="ghost" size="sm" className="ml-1" onClick={() => setView("overview")}>Открыть план</Button>}
            {issue.busy?.kind === "planning" && <p role="status" className="text-xs text-muted-foreground">Готовлю название и план…</p>}
          </form>
        </section>

        <fieldset hidden={view !== "relations"} aria-label="Связи задач" disabled={request} className="min-w-0 space-y-3">
          <h3 className={heading}>Подзадачи и связи</h3>
          {issue.origin && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{issue.origin.mode === "decompose" ? "Создана декомпозицией" : "Порождена из контекста"}</span>
            {origin && <button type="button" className="text-primary" onClick={() => openIssue(panel, origin)}>{issueTitle(origin)}</button>}
            {issue.origin.threadId && <button type="button" className="text-primary"
              onClick={() => openOriginChat(issue.origin!.threadId!)}>Исходный чат</button>}
          </div>}
          <div className="kb-detail-relations">
            {selector(fields.parentId, (value) => update("parentId", value), "Родительская задача")}
            {selector(fields.duplicateOf, (value) => update("duplicateOf", value), "Дубликат задачи")}
            {candidates.length > 0 && multi("blockedBy", "Заблокирована задачами")}
            {candidates.length > 0 && multi("related", "Связанные задачи")}
          </div>
          {(children.length > 0 || issue.parentId) && <IssueTree root={issue} issues={issues}
            openTask={(child) => openIssue(panel, child)} openTree={openTree} derive={setDerivation}
            remove={(child) => setDeleteId(child.id)} />}
          {incoming.map((other) => (
            <button type="button" key={other.id} className="block text-sm text-primary" onClick={() => openIssue(panel, other)}>
              {other.blockedBy.includes(issue.id) ? "Блокирует" : other.duplicateOf === issue.id ? "Дубликат" : "Связана"} · {other.title || "Новая задача"}
            </button>
          ))}
          <Button size="sm" variant="outline" disabled={request} onClick={() => void run(async () => {
            await saveDraft();
            const child = await rpc.call("issueCreate", { projectId: issue.projectId, status: "backlog", parentId: issue.id, test: false });
            openIssue(panel, child, { startWithAssistant: true });
          })}>+ Подзадача</Button>
        </fieldset>

        <section hidden={view !== "work"} aria-label="Рабочие области" className="space-y-3">
          <h3 className={heading}>Рабочие чаты</h3>
          {issue.threadIds.length === 0 && <p className="rounded-lg border border-border bg-muted/30 px-2.5 py-2 text-sm text-muted-foreground">У задачи ещё нет рабочего чата. Можно привязать существующий или запустить работу.</p>}
          {issue.threadIds.map((id) => (
            <div key={id} className="flex items-center gap-2">
              <button type="button" className="min-w-0 flex-1 truncate text-left text-sm text-primary"
                title={nameOf(id)} onClick={() => showChat(id)}>{nameOf(id)}</button>
              <Button variant="ghost" size="sm" disabled={request || !!issue.busy} onClick={() => void run(async () => {
                await rpc.call("issueLink", { id: issue.id, threadId: id, linked: false });
                if (sourceThreadId === id) setSource("");
              })}>Отвязать</Button>
            </div>
          ))}
          {available.length > 0 && (
            <div className="flex items-center gap-2">
              <select aria-label="Связать существующий чат" value={link} className={control} onChange={(event) => setLink(event.target.value)}>
                <option value="">Существующий чат…</option>
                {available.map((thread) => <option key={thread.id} value={thread.id}>{thread.displayTitle}</option>)}
              </select>
              <Button variant="outline" size="sm" disabled={!link || request || !!issue.busy} onClick={() => void run(async () => {
                await rpc.call("issueLink", { id: issue.id, threadId: link, linked: true });
                setLink("");
              })}>Связать</Button>
            </div>
          )}
          <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-2.5">
            <select aria-label="Исходный чат для форка" value={sourceThreadId} className={control} onChange={(event) => setSource(event.target.value)}>
              <option value="">Новый чат</option>
              {issue.threadIds.map((id) => <option key={id} value={id}>Форк · {nameOf(id)}</option>)}
            </select>
            {!sourceThreadId && (
              <select aria-label="Агент для запуска" value={providerId} className={control} onChange={(event) => {
                setProvider(event.target.value); setExecutionOverrides({}); setLaunchReady(false);
              }}>
                <option value="">Агент по умолчанию</option>
                {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.id}</option>)}
              </select>
            )}
            {view === "work" && !sourceThreadId && <LaunchSettings id={issue.id} providerId={providerId}
              worktree={!personal && worktree} overrides={executionOverrides} onChange={setExecutionOverrides} onReady={setLaunchReady} />}
            {sourceThreadId && <p className="text-xs text-muted-foreground">Форк наследует модель, усилие и скорость исходного чата.</p>}
            {personal ? (
              <p className="text-xs text-muted-foreground">
                {sourceThreadId || issue.origin?.threadId
                  ? "Рабочая папка исходного чата. Отдельный Git worktree доступен в Git-разделах."
                  : "Личная рабочая папка. Отдельный Git worktree доступен в Git-разделах."}
              </p>
            ) : <label className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={worktree} onChange={(event) => setWorktree(event.target.checked)} /> Отдельный Git worktree
            </label>}
          </div>
          <Button size="sm" disabled={request || !!issue.busy || !fields.title.trim() || !fields.notes.trim() || blocked || (!sourceThreadId && !launchReady)}
            onClick={() => void run(async () => {
              await saveDraft();
              const result = await rpc.call("issueStart", {
                id: issue.id, worktree: !personal && worktree,
                ...(providerId && !sourceThreadId ? { providerId } : {}),
                ...(!sourceThreadId ? Object.fromEntries(Object.entries(executionOverrides).filter(([, value]) => value !== undefined)) : {}),
                ...(sourceThreadId ? { sourceThreadId } : {}),
              });
              setExecutionOverrides({});
              showChat(result.threadId);
            })}>{issue.threadIds.length > 0 ? "Добавить запуск" : "Запустить работу"}</Button>
          {blocked && <p className="text-xs text-muted-foreground">Запуск станет доступен после закрытия блокирующих задач.</p>}
        </section>
        {(error || issue.error) && <p role="alert" className="break-words text-sm text-destructive">{error || issue.error}</p>}
        </div>
      </div>
      {derivation && <DeriveDialog request={derivation} close={() => setDerivation(null)}
        start={(selection, instruction) => void derivationActivity.start(selection, instruction,
          selection.source.id === issue.id ? saveDraft : undefined)} />}
      {deleteIssue && <DeleteIssueDialog issue={deleteIssue} close={() => setDeleteId(null)} deleted={() => void refresh()} />}
      {dirty && (
        <footer className="kb-detail-head shrink-0 border-t border-border bg-background">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Есть несохранённые правки</span>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" disabled={request} onClick={() => formDraft.clear()}>Сбросить правки</Button>
              <Button size="sm" disabled={request} onClick={() => void run(saveDraft)}>Сохранить правки</Button>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}

export function IssuePanel({ params }: { params: ReadonlyJsonValue | null }) {
  const { data, error, isLoading, refetch } = useIssues();
  const input = params && typeof params === "object" && "issueId" in params ? params : null;
  const issueId = input?.issueId;
  const issue = data?.find((candidate) => candidate.id === issueId);
  if (issue && data) return <IssueEditor key={issue.id} issue={issue} issues={data} refresh={refetch}
    requestId={typeof input?.openRequest === "number" ? input.openRequest : null}
    initialThreadId={typeof input?.threadId === "string" ? input.threadId : null}
    restoredView={(() => { const parsed = z.enum(['chat','changes','plan','overview','planning','relations','work']).safeParse(input?.view); return parsed.success ? parsed.data : null; })()}
    startWithAssistant={input?.startWithAssistant === true} />;
  return <p className="p-4 text-sm text-muted-foreground">{error?.message ?? (isLoading ? "Загружаю карточку…" : "Выбери задачу на доске.")}</p>;
}
