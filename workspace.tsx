import { useEffect, useState, useSyncExternalStore } from "react";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  ThreadChat,
  experimental_copyToClipboard,
  experimental_Diff as Diff,
  experimental_useRpcQuery,
  experimental_useRpcKeyedQuery,
  experimental_useSidebarThreads,
  experimental_useAppPanel,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSdk,
  type ExperimentalPanelController,
  type ReadonlyJsonValue,
} from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { CardMenu, ViewSwitch } from "./kanban-ui";
import { useOpenMerge, WorktreeBadge } from "./merge-ui";
import { mergeRpc, worktreeChanged } from "./merge-contract";
import { issueRpc, issuesChanged } from "./issues";
import { emptyPlan, planChanged, planRpc, planSchema, priorities, type Plan } from "./planning";
import { workDiffChanged, workDiffRpc } from "./work-diff-contract";
import { useVisibleChat } from "./open-chats-ui";
import { focusOpenCard, openPanelContext } from "./panel-context-actions";
import { createDraftStore } from "./panel-drafts";
import { sectionStore } from "./panel-context";
import { usePanelSection } from "./panel-section-ui";
import { usePanelState } from "./panel-view-state";
import { PanelHeading } from "./panel-heading";

export const workspaceTab = {
  id: "workspace",
  context: { kind: "nav-panel", panelId: "board" },
  availability: "action",
} as const;

export function openChatWorkspace(panel: ExperimentalPanelController, threadId: string, title: string, reuse = false) {
  if (reuse) {
    const result = focusOpenCard(panel, {kind: 'chat', threadId});
    if (result === 'focused') return true;
    if (result === 'failed') { toast.error("Не удалось переключить вкладку чата."); return false; }
  }
  const opened = openPanelContext(panel, { kind: "chat", threadId, title });
  if (!opened) toast.error("Не удалось открыть рабочую область.");
  return opened;
}

export const workspaceViews = [
  { name: "Чат", view: "chat" },
  { name: "Изменения", view: "changes" },
  { name: "Заметки", view: "plan" },
] as const;

export type WorkspaceView = (typeof workspaceViews)[number]["view"];

const unavailable = z.object({ outcome: z.literal("unavailable"), failure: z.object({ message: z.string() }) });
const nonGit = z.object({ outcome: z.literal("not_applicable") });

const git = defineRpcContract({
  workspaceStatus: {
    input: z.object({ environmentId: z.string() }),
    output: z.discriminatedUnion("outcome", [
      z.object({
        outcome: z.literal("available"),
        workspace: z.object({
          branch: z.object({ currentBranch: z.string().nullable() }),
          checkout: z.object({ headSha: z.string().nullable().optional() }).optional(),
        }),
      }),
      unavailable,
      nonGit,
    ]),
  },
  diff: {
    input: z.object({
      environmentId: z.string(),
      target: z.object({ type: z.literal("uncommitted") }),
    }),
    output: z.discriminatedUnion("outcome", [
      z.object({
        outcome: z.literal("available"),
        diff: z.object({ diff: z.string(), truncated: z.boolean(), shortstat: z.string() }),
      }),
      unavailable,
      nonGit,
    ]),
  },
});

const github = defineRpcContract({
  pullRequests: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(z.string(), z.discriminatedUnion("outcome", [
      z.object({
        outcome: z.literal("available"),
        pullRequest: z.object({
          number: z.number(), title: z.string(), url: z.string(), state: z.string(),
          checks: z.object({ state: z.string() }),
        }),
      }),
      z.object({ outcome: z.literal("absent") }),
      z.object({ outcome: z.literal("unavailable") }),
    ])),
  },
});

function PullRequest({ environmentId }: { environmentId: string }) {
  const navigate = useBbNavigate();
  const result = experimental_useRpcKeyedQuery({
    pluginId: "bb--github-pr-status", contract: github, method: "pullRequests", keys: [environmentId],
  });
  const row = result.data?.[environmentId];
  if (row?.outcome !== "available") return null;
  const pr = row.pullRequest;
  const prState: Record<string, string> = { draft: "черновик", open: "открыт", merged: "смёржен", closed: "закрыт" };
  return (
    <Button type="button" variant="ghost" size="sm" onClick={() => navigate.openUrl(pr.url)}>
      PR #{pr.number} · {prState[pr.state] ?? pr.state}
    </Button>
  );
}

function GitChanges({ environmentId, threadId, isWorktree, visible }: {
  environmentId: string | null; threadId: string; isWorktree?: boolean; visible: boolean;
}) {
  const panel = experimental_useAppPanel();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const issueClient = useRpc<typeof issueRpc>();
  const issueQuery = experimental_useRpcQuery({ contract: issueRpc, method: "issueList", input: null });
  const issue = issueQuery.data?.find((item) => item.threadIds.includes(threadId));
  useRealtime(issuesChanged, () => { void issueQuery.refetch(); });
  const worktrees = experimental_useRpcQuery({ contract: mergeRpc, method: "worktreeStates", input: { keys: [threadId] } });
  const worktree = worktrees.data?.[threadId];
  const canMerge = !!worktree || !!isWorktree;
  const openMerge = useOpenMerge();
  const [mode, setMode] = usePanelState<"git" | "chat" | "working">(`${threadId}:diff-mode`, "git");
  const [commitSha, setCommitSha] = usePanelState(`${threadId}:diff-commit`, "");
  const [runId, setRunId] = usePanelState(`${threadId}:diff-run`, "");
  const [selection, setSelection] = usePanelState(`${threadId}:diff-selection`, "");
  const [sideBySide, setSideBySide] = usePanelState(`${threadId}:diff-side-by-side`, false);
  const [comments, setComments] = usePanelState<ReadonlyMap<string, string>>(`${threadId}:diff-comments`, new Map());
  const [sending, setSending] = useState(false);
  const [reviewStatus, setReviewStatus] = useState("");
  const [approving, setApproving] = useState(false);
  const [approval, setApproval] = useState<{ message: string; error?: boolean } | null>(null);
  const status = experimental_useRpcQuery({
    pluginId: "bb--git", contract: git, method: "workspaceStatus",
    input: { environmentId: environmentId ?? "" }, enabled: !!environmentId,
  });
  const workspace = status.data?.outcome === "available" ? status.data.workspace : null;
  const gitHistory = experimental_useRpcQuery({
    contract: workDiffRpc, method: "workGitHistory", input: { threadId, environmentId }, enabled: visible && mode === "git",
  });
  const commits = gitHistory.data?.commits ?? [];
  const range = gitHistory.data?.range;
  const selectedCommit = commits.find(({ sha }) => sha === commitSha);
  const wholeRange = !!range && !selectedCommit;
  const commit = selectedCommit ?? (wholeRange ? undefined : commits[0]);
  const commitPatch = experimental_useRpcQuery({
    contract: workDiffRpc, method: "workGitPatch", input: { threadId, environmentId, sha: commit?.sha ?? null },
    enabled: visible && mode === "git" && (wholeRange || !!commit),
  });
  const work = experimental_useRpcQuery({
    contract: workDiffRpc, method: "workDiff", input: { threadId, environmentId }, enabled: visible && mode === "chat",
  });
  const runWork = experimental_useRpcQuery({
    contract: workDiffRpc, method: "workDiff", input: { threadId, environmentId, ...(runId && { runId }) },
    enabled: visible && mode === "chat" && !!runId,
  });
  const workingCopy = experimental_useRpcQuery({
    pluginId: "bb--git", contract: git, method: "diff",
    input: { environmentId: environmentId ?? "", target: { type: "uncommitted" } },
    enabled: visible && mode === "working" && !!environmentId,
  });
  const history = runId ? runWork : work;
  const runs = work.data && "runs" in work.data ? work.data.runs ?? [] : [];
  const changes = mode === "chat" ? history : workingCopy;
  const snapshot = mode === "chat" && history.data?.outcome === "available" ? history.data.snapshot : null;
  const diff = mode === "working" && workingCopy.data?.outcome === "available" ? workingCopy.data.diff : null;
  const files = (mode === "git" ? commitPatch.data?.files : snapshot?.files) ??
    (diff?.diff.split(/(?=^diff --git )/m) ?? []).filter((patch) => patch.trim()).map((patch) => {
    const marker = /^\+\+\+ (?:b\/)?(.+)$/m.exec(patch)?.[1];
    const old = /^--- (?:a\/)?(.+)$/m.exec(patch)?.[1];
    const name = marker && marker !== "/dev/null" ? marker : old ?? patch.split("\n", 1)[0].replace(/^diff --git /, "");
    return { name, patch };
  });
  const file = files.find(({ name }) => name === selection) ?? files[0];
  const review = [...comments].filter(([, comment]) => comment.trim());
  const approvalError = issue?.status !== "done" && (issue?.error || approval?.error && approval.message);
  const approvalMessage = approvalError || (!approval?.error && approval?.message);
  const refresh = () => {
    if (environmentId) void status.refetch();
    if (mode === "git") {
      void gitHistory.refetch();
      if (wholeRange || commit) void commitPatch.refetch();
    } else {
      if (mode === "chat" && runId) void work.refetch();
      void changes.refetch();
    }
  };
  useRealtime(worktreeChanged, () => { void worktrees.refetch(); if (visible) refresh(); });
  useRealtime(workDiffChanged, (payload) => {
    if (visible && payload && typeof payload === "object" && "threadId" in payload && payload.threadId === threadId) refresh();
  });
  async function approveReview() {
    const branch = workspace?.branch.currentBranch;
    if (!issue || !branch || !environmentId || approving || issue.busy) return;
    setApproving(true);
    setApproval(null);
    try {
      const { issue: updated, commit, remaining, blocked } = await issueClient.call("issueReview", {
        id: issue.id, threadId, environmentId, expectedBranch: branch, expectedHead: workspace.checkout?.headSha ?? null,
      });
      if (blocked) {
        setApproval({ message: updated.error ?? "Не удалось отделить правки карточки.", error: true });
        return;
      }
      const summary = commit ? `Коммит ${commit.head.slice(0, 8)} · ${commit.subject}` : "Новый коммит для карточки не потребовался.";
      setApproval({ message: updated.status === "done" ? `Карточка завершена. ${summary}`
        : remaining ? `${summary} Остались правки в других рабочих папках карточки.` : `${summary} Проверь текущий статус карточки.` });
    } catch (cause) {
      setApproval({ message: cause instanceof Error ? cause.message : String(cause), error: true });
    } finally {
      refresh();
      void issueQuery.refetch();
      setApproving(false);
    }
  }
  async function sendReview() {
    if (!review.length || sending) return;
    setSending(true);
    setReviewStatus("");
    try {
      const text = ["Замечания по Git-изменениям", ...review.map(([path, comment]) =>
        `Файл ${path}\n${comment.trim()}`)].join("\n\n");
      const result = await sdk.threads.send({
        threadId, input: [{ type: "text", text, mentions: [] }], mode: "queue-if-active",
      });
      setComments(new Map());
      setReviewStatus(result.delivery === "queued" ? "Замечания поставлены в очередь чата." : "Замечания отправлены в чат.");
    } catch (cause) {
      setReviewStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }
  return (
    <div data-kanban-scroll="diff-content" className="min-h-0 flex-1 overflow-auto px-3 pb-4">
      <div className="kb-diff-toolbar sticky top-0 z-10 flex flex-wrap items-center gap-1 border-b border-border bg-background py-2" role="group" aria-label="Просмотр изменений">
        <ViewSwitch label="Источник изменений" variant="subsections" options={[
          { name: "История Git", selected: mode === "git", select: () => setMode("git") },
          { name: "Сводка правок", selected: mode === "chat", select: () => setMode("chat") },
          { name: "Рабочая копия", selected: mode === "working", select: () => setMode("working"), disabled: !workspace },
        ]} />
        <div className="kb-diff-actions">
        <Button size="sm" variant="ghost" onClick={refresh}
          disabled={mode === "git" ? gitHistory.isFetching || commitPatch.isFetching : changes.isFetching}>Обновить</Button>
        {environmentId && <PullRequest environmentId={environmentId} />}
        {issue?.status === "review" &&
          <Button size="sm" disabled={approving || !!issue.busy || !workspace?.branch.currentBranch}
            onClick={() => void approveReview()}>{approving ? "Сохраняю…" : "Проверено"}</Button>}
        {canMerge && worktree?.state !== "merged" && worktree?.state !== "unavailable" && worktree?.state !== "empty" &&
          <Button size="sm" variant="outline" onClick={() => void openMerge({ mode: "single", threadId })}>Слить в main</Button>}
        <WorktreeBadge status={worktree} />
        </div>
      </div>
      {mode === "git" && (range || commits.length > 0) && (
        <ol data-kanban-scroll="diff-commits" aria-label="Коммиты чата" className="mt-2 max-h-44 space-y-1 overflow-auto">
          {range && (
            <li>
              <button type="button" aria-pressed={wholeRange} onClick={() => { setCommitSha(""); setSelection(""); }}
                className="flex w-full flex-wrap items-baseline gap-x-2 rounded px-2 py-1 text-left text-sm hover:bg-muted aria-pressed:bg-muted">
                <span>Все изменения ветки</span>
                <span className="font-mono text-xs text-muted-foreground">{range.base.slice(0, 8)}…{range.head.slice(0, 8)}</span>
              </button>
            </li>
          )}
          {commits.map((item) => (
            <li key={item.sha}>
              <button type="button" aria-pressed={item.sha === commit?.sha}
                onClick={() => { setCommitSha(item.sha); setSelection(""); }}
                className="flex w-full flex-wrap items-baseline gap-x-2 rounded px-2 py-1 text-left text-sm hover:bg-muted aria-pressed:bg-muted">
                <span className="font-mono text-xs" title={item.sha}>{item.sha.slice(0, 8)}</span>
                <span>{item.subject}</span>
                <time dateTime={new Date(item.committedAt).toISOString()} className="text-xs text-muted-foreground">
                  {new Date(item.committedAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}
                </time>
              </button>
            </li>
          ))}
        </ol>
      )}
      {mode === "git" && commit?.files && commit.fileCount !== undefined && commit.files.length < commit.fileCount &&
        <p className="mt-2 text-xs text-muted-foreground">Файлы карточки · {commit.files.length} из {commit.fileCount} в коммите</p>}
      {mode === "chat" && (runs.length > 1 || (runs.length > 0 && work.data?.outcome === "unavailable")) && (
        <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          Правки по запускам
          <select value={runId} onChange={(event) => { setRunId(event.target.value); setSelection(""); }}
            className="min-w-0 rounded-md border border-input bg-background p-1.5 text-foreground">
            <option value="">Общий diff</option>
            {runs.map(({ id, startedAt }, index) => (
              <option key={id} value={id}>
                Запуск {index + 1} · {new Date(startedAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}
              </option>
            ))}
          </select>
        </label>
      )}
      {mode !== "git" && (snapshot || workspace?.branch.currentBranch) && <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
        {snapshot?.branch ?? workspace?.branch.currentBranch}{snapshot && !runId && ` ← ${snapshot.base.slice(0, 8)}`}
      </p>}
      {mode === "chat" && history.data?.outcome === "available" && history.data.saved &&
        <p className="mt-2 text-xs text-muted-foreground">{snapshot?.shared
          ? runId ? "Патч из журнала запуска" : "Сводный патч из журнала чата"
          : "Сохранённый diff работы"}</p>}
      {approvalMessage && <p role={approvalError ? "alert" : "status"}
        className={`mt-2 break-words text-sm ${approvalError ? "text-destructive" : "text-muted-foreground"}`}>
        {approvalMessage}
      </p>}
      {issue?.status === "review" && issue.reviewWorker && <Button type="button" size="sm" variant="outline"
        className="mt-2" onClick={() => openChatWorkspace(panel, issue.reviewWorker!, "Разбор правок")}>Открыть разбор правок</Button>}
      {mode === "git" && (gitHistory.error || commitPatch.error) ?
        <p role="alert" className="py-3 text-sm text-destructive">{(gitHistory.error ?? commitPatch.error)?.message}</p>
        : mode === "git" && (gitHistory.data?.message || commitPatch.data?.message) ?
          <p className="py-3 text-sm text-muted-foreground">{gitHistory.data?.message ?? commitPatch.data?.message}</p>
        : mode !== "git" && changes.data?.outcome === "not_applicable" ?
        <p className="py-3 text-sm text-muted-foreground">Окружение без Git.</p>
        : mode !== "git" && changes.error ? <p role="alert" className="py-3 text-sm text-destructive">{changes.error.message}</p>
        : mode !== "git" && changes.data?.outcome === "unavailable" ? <p role="alert" className="py-3 text-sm text-destructive">
          {"message" in changes.data ? changes.data.message : changes.data.failure.message}</p>
        : (mode === "git" ? gitHistory.isLoading || ((wholeRange || !!commit) && commitPatch.isLoading) : changes.isLoading) ?
          <p role="status" className="py-3 text-sm text-muted-foreground">Загружаю изменения…</p>
        : !file ? <p className="py-3 text-sm text-muted-foreground">Изменений в этом режиме нет.</p>
        : (
          <>
            <div className="flex flex-wrap items-center gap-2 py-2 text-xs text-muted-foreground">
              <span>Файлов · {files.length}</span>
              <label className="min-w-0 flex-1">
                <span className="sr-only">Файл</span>
                <select value={file.name} onChange={(event) => setSelection(event.target.value)}
                  className="w-full rounded-md border border-input bg-background p-1.5 text-foreground">
                  {files.map(({ name }, i) => <option key={`${i}:${name}`} value={name}>{name}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={sideBySide} onChange={(event) => setSideBySide(event.target.checked)} /> Две панели
              </label>
            </div>
            {diff?.truncated && <p className="pb-2 text-xs text-muted-foreground">BB ограничил размер diff.</p>}
            <Diff patch={file.patch} path={file.name} view={sideBySide ? "split" : "unified"} overflow="scroll" />
            <label className="mt-3 block space-y-1 text-sm">
              <span>Замечания по файлу</span>
              <textarea rows={3} maxLength={4000} value={comments.get(file.name) ?? ""} disabled={sending}
                onChange={(event) => {
                  const value = event.target.value;
                  setComments((previous) => new Map(previous).set(file.name, value));
                  setReviewStatus("");
                }}
                placeholder="Укажи строку и что нужно изменить"
                className="block w-full rounded-md border border-input bg-background p-2" />
            </label>
          </>
        )}
      {review.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={sending} onClick={() => void sendReview()}>
            {sending ? "Отправляю…" : `Отправить агенту · ${review.length}`}
          </Button>
          <span className="text-xs text-muted-foreground">Все замечания уйдут одним сообщением.</span>
        </div>
      )}
      {reviewStatus && <p role="status" className="mt-2 break-words text-xs text-muted-foreground">{reviewStatus}</p>}
    </div>
  );
}

const planDraftFor = createDraftStore("chat-plan", null as (Omit<Plan, "tags"> & { tags: string }) | null,
  planSchema.extend({ tags: z.string() }).nullable().parse);

function TaskPlan({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof planRpc>();
  const result = experimental_useRpcKeyedQuery({ contract: planRpc, method: "planList", keys: [threadId] });
  useRealtime(planChanged, (payload) => {
    if (payload && typeof payload === "object" && "threadId" in payload && payload.threadId === threadId) {
      void result.refetchKeys([threadId]);
    }
  });
  const saved = result.data?.[threadId] ?? emptyPlan;
  const draftStore = planDraftFor(threadId);
  const draft = useSyncExternalStore(draftStore.subscribe, draftStore.get);
  const setDraft = (next: NonNullable<typeof draft>) => draftStore.update(() => next);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const current = draft ?? { ...saved, tags: saved.tags.join(", ") };

  return (
    <form data-kanban-scroll="plan-content" className="min-h-0 flex-1 space-y-3 overflow-auto p-3 text-sm" onSubmit={async (event) => {
      event.preventDefault();
      if (!draft || busy) return;
      const tags = [...new Set(draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean))];
      const parsed = planSchema.safeParse({ ...draft, tags });
      if (!parsed.success) {
        setFeedback("Допустимо до 12 меток длиной до 40 символов.");
        return;
      }
      setBusy(true);
      setFeedback("");
      try {
        await rpc.call("planSave", { threadId, plan: parsed.data });
        await result.refetchKeys([threadId]);
        draftStore.clear(draft);
        setFeedback("Сохранено.");
      } catch (cause) {
        setFeedback(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    }}>
      {result.error && <p role="alert" className="text-destructive">{result.error.message}</p>}
      <label className="block space-y-1">
        <span>Описание и заметки</span>
        <textarea rows={9} maxLength={12000} value={current.notes} disabled={busy || result.isLoading}
          onChange={(event) => { setFeedback(""); setDraft({ ...current, notes: event.target.value }); }}
          placeholder="Что нужно сделать, как проверить результат"
          className="block w-full rounded-md border border-input bg-background p-2" />
      </label>
      <label className="block space-y-1">
        <span>Приоритет</span>
        <select value={current.priority ?? ""} disabled={busy || result.isLoading}
          onChange={(event) => {
            const priority = event.target.value;
            if (!priority || Object.hasOwn(priorities, priority)) {
              setFeedback("");
              setDraft({ ...current, priority: (priority || null) as Plan["priority"] });
            }
          }}
          className="block w-full rounded-md border border-input bg-background p-2">
          <option value="">Без приоритета</option>
          {Object.entries(priorities).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="block space-y-1">
        <span>Метки через запятую</span>
        <Input value={current.tags} disabled={busy || result.isLoading}
          onChange={(event) => { setFeedback(""); setDraft({ ...current, tags: event.target.value }); }} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={!draft || busy || !!result.error}>{busy ? "Сохраняю…" : "Сохранить"}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={!current.notes.trim()}
          onClick={async () => {
            try {
              if (!await experimental_copyToClipboard({ text: current.notes })) throw new Error();
              setFeedback("Заметки скопированы.");
            } catch {
              setFeedback("Не удалось скопировать заметки.");
            }
          }}>Скопировать заметки</Button>
      </div>
      {feedback && <p role="status" className="break-words text-xs text-muted-foreground">{feedback}</p>}
    </form>
  );
}

export function WorkspaceTools({ threadId }: { threadId: string }) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const live = experimental_useSidebarThreads().threads.find((thread) => thread.id === threadId);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState("");
  const [showPreview, setShowPreview] = useState(false);

  async function openTerminal() {
    setOpening(true);
    try {
      const terminal = await sdk.terminals.create({
        scope: { kind: "thread", threadId }, rows: 30, cols: 100, title: "Терминал задачи",
      });
      if (!await navigate.experimental_openTerminal({ terminalId: terminal.id })) {
        await sdk.terminals.close({ terminalId: terminal.id, mode: "if-clean" });
        throw new Error("BB не смог открыть вкладку терминала.");
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpening(false);
    }
  }

  return (
    <>
      <CardMenu label="Инструменты рабочего чата" triggerLabel="Инструменты" triggerIcon="tools" groups={[
        { label: "Рабочая среда", items: [
          { label: "Открыть терминал", disabled: opening || (!!live && !live.environment?.id), action: () => void openTerminal() },
          { label: "Открыть превью по ссылке", action: () => { setError(""); setShowPreview(true); } },
        ] },
        { label: "Навигация", items: [
          { label: "Открыть ветку чата", action: () => navigate.toPluginPanel("board", { subPath: `branch/${threadId}` }) },
        ] },
      ]} />
      {showPreview && <Dialog open onOpenChange={setShowPreview}>
        <DialogContent className="kb-dialog">
          <DialogHeader>
            <DialogTitle>Открыть превью</DialogTitle>
            <DialogDescription>Вставь ссылку на запущенное приложение или страницу.</DialogDescription>
          </DialogHeader>
          <form className="space-y-3" onSubmit={(event) => {
            event.preventDefault();
            try {
              const url = new URL(preview.trim());
              if (!["http:", "https:"].includes(url.protocol) || !navigate.openUrl(url.href)) throw new Error();
              setShowPreview(false);
            } catch {
              setError("Укажи ссылку, которая начинается с http:// или https://.");
            }
          }}>
            <Input type="url" value={preview} onChange={(event) => { setPreview(event.target.value); setError(""); }}
              placeholder="https://…" aria-label="Ссылка на превью" />
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowPreview(false)}>Отмена</Button>
              <Button type="submit" disabled={!preview.trim()}>Открыть</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>}
    </>
  );
}

export function Workspace({ threadId, view }: { threadId: string; view: WorkspaceView | null }) {
  useVisibleChat(threadId, view === "chat");
  const sdk = useSdk();
  const live = experimental_useSidebarThreads().threads.find((thread) => thread.id === threadId);
  const section = usePanelSection();
  useEffect(() => {
    if (!section || !live?.displayTitle) return;
    const context = sectionStore.get(section).context;
    if (context?.kind === 'chat' && context.threadId === threadId && context.title !== live.displayTitle)
      sectionStore.replace(section, { ...context, title: live.displayTitle });
  }, [section, threadId, live?.displayTitle]);
  const [environment, setEnvironment] = useState<string | null>(null);
  const [visited, setVisited] = useState<ReadonlySet<WorkspaceView>>(new Set());
  const environmentId = live?.environment?.id ?? environment;
  if (view && view !== "chat" && !visited.has(view)) {
    setVisited(new Set(visited).add(view));
  }

  useEffect(() => {
    if (live) return;
    const controller = new AbortController();
    void sdk.threads.get({ threadId, signal: controller.signal }).then((thread) => {
      if (!controller.signal.aborted) setEnvironment(thread?.environmentId ?? null);
    }, () => {});
    return () => controller.abort();
  }, [live, sdk, threadId]);

  return (
    <div className={view ? "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" : "hidden"}
      data-kanban-panel="workspace" data-kanban-id={threadId} data-kanban-tab={view ?? ""} data-kanban-project={live?.projectId}>
      {visited.has("plan") && (
        <div className={view === "plan" ? "flex min-h-0 flex-1 flex-col" : "hidden"}><TaskPlan threadId={threadId} /></div>
      )}
      {visited.has("changes") && (
        <div className={view === "changes" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <GitChanges key={environmentId} environmentId={environmentId} threadId={threadId}
            isWorktree={live?.environment?.isWorktree ?? undefined} visible={view === "changes"} />
        </div>
      )}
      {view === "chat" && (
        <ThreadChat key={threadId} threadId={threadId} variant="compact" className="min-h-0 flex-1" />
      )}
    </div>
  );
}

function StandaloneWorkspace({ threadId }: { threadId: string }) {
  const sidebar = experimental_useSidebarThreads();
  const live = sidebar.threads.find((thread) => thread.id === threadId);
  const section = usePanelSection();
  const restored = section ? sectionStore.get(section).context : null;
  const [view, setView] = usePanelState<WorkspaceView>(`${threadId}:workspace-view`,
    restored?.kind === 'chat' ? restored.view ?? 'chat' : 'chat');
  useEffect(() => {
    if (!section) return;
    const context = sectionStore.get(section).context;
    if (context?.kind === 'chat' && context.threadId === threadId && context.view !== view)
      sectionStore.replace(section, { ...context, view });
  }, [section, threadId, view]);
  return (
    <div className="kb-detail flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="shrink-0" data-kanban-heading="compact">
      <PanelHeading standalone title={live?.displayTitle || restored?.title || "Рабочий чат"}
        context={`Чат${live ? ` · ${sidebar.projects.find((project) => project.id === live.projectId)?.name ?? "Personal"}` : ""}`}
        actions={<WorkspaceTools threadId={threadId} />} />
      <div className="kb-detail-nav-row">
        <select className="kb-mobile-section-picker" aria-label="Раздел рабочего чата" value={view}
          onChange={(event) => setView(event.target.value as WorkspaceView)}>
          {workspaceViews.map((option) => <option key={option.view} value={option.view}>{option.name}</option>)}
        </select>
        <ViewSwitch label="Рабочая область" variant="sections" options={workspaceViews.map((option) => ({
          name: option.name, selected: view === option.view, select: () => setView(option.view),
        }))} />
      </div>
      </header>
      <Workspace threadId={threadId} view={view} />
    </div>
  );
}

export function WorkspaceTab({ params }: { params: ReadonlyJsonValue | null }) {
  const parsed = z.object({ threadId: z.string().regex(/^thr_[a-z0-9]+$/i) }).safeParse(params);
  return parsed.success ? <StandaloneWorkspace key={parsed.data.threadId} threadId={parsed.data.threadId} />
    : <p className="p-4 text-sm text-muted-foreground">Выбери чат на доске.</p>;
}
