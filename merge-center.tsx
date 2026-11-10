import { useEffect, useRef, useState } from "react";
import { experimental_useAppPanel, experimental_useRpcQuery, experimental_useSidebarThreads, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
import { mergeRpc, worktreeChanged, type MergePlan, type MergePreparation } from "./merge-contract";
import { CardMenu, KanbanIcon } from "./kanban-ui";
import { useOpenMerge } from "./merge-ui";
import { openChatWorkspace } from "./workspace";

const labels: Record<MergePlan["state"], string> = {
  planning: "Проверка веток", ready: "Готов к слиянию", merging: "Слияние", resolving: "Разбор конфликтов",
  awaiting: "Нужен твой выбор", done: "Слито в main", failed: "Ошибка", blocked: "Нужна подготовка",
};
const busy = (state?: MergePlan["state"]) => state === "planning" || state === "merging" || state === "resolving";
const waitsFor = (plan: MergePlan) => plan.state === "ready" ? plan.waitingFor ?? []
  : plan.state === "blocked" ? plan.preparations[0]?.waitingFor ?? [] : [];
const tracksCheckout = (plan: MergePlan) => plan.state === "ready" || (plan.state === "blocked" && !!plan.preparations.length);

function PlanStatus({ plan }: { plan: MergePlan }) {
  const waiters = waitsFor(plan);
  let label = labels[plan.state];
  let tone = "neutral";
  if (waiters.length) {
    label = waiters.every(({ reason }) => reason === "input") ? "Ждёт ответа в чате" : "Ждёт агента";
    tone = "wait";
  } else if (plan.state === "awaiting") {
    tone = "wait";
  } else if (plan.state === "done") {
    tone = "success";
  } else if (plan.state === "failed") {
    label = plan.results.some(({ head }) => head) ? "Частично слито" : label;
    tone = "error";
  } else if (plan.state === "blocked" && plan.preparations.length) {
    label = "Нужен коммит";
  } else if (busy(plan.state) || plan.state === "ready") {
    tone = "progress";
  }
  return <span className="kb-merge-status" data-tone={tone}><span className="sr-only">Статус </span>{label}</span>;
}
type Action = "apply" | "answer" | "explain" | "refresh" | "retry" | "dismiss" | "commit";
const canDismiss = (plan: MergePlan) => !busy(plan.state) && !plan.explaining && !plan.results.some(({ head }) => head);
const canRefresh = (plan: MergePlan) => ["blocked", "ready", "failed"].includes(plan.state) && !plan.results.some(({ head }) => head);
const branchName = (preparation: MergePreparation) => preparation.kind === "main" ? "main" : "worktree";

function MergeSteps({ plan }: { plan: MergePlan }) {
  const step = plan.state === "done" ? 2
    : plan.state === "planning" || plan.state === "blocked" ? 0
      : plan.branches.length > 0 || plan.results.length > 0 ? 1 : 0;
  return <ol className="kb-merge-steps" aria-label="Этапы слияния">
    {["Подготовка", "Слияние", "Результат"].map((label, index) => (
      <li key={label} aria-current={step === index ? "step" : undefined} data-complete={index < step}>
        <span aria-hidden="true">{index < step ? <KanbanIcon name="check" /> : index + 1}</span>{label}
      </li>
    ))}
  </ol>;
}

function PreparationFiles({ item, expanded }: { item: MergePreparation; expanded?: boolean }) {
  return <details open={expanded} className="kb-merge-files text-xs">
    <summary className="cursor-pointer">{item.branch} · файлов {item.count}</summary>
    <ul className="mt-1 max-h-32 space-y-1 overflow-auto text-muted-foreground">
      {item.files.map((file, index) => <li key={index} className="break-all">{file}</li>)}
    </ul>
  </details>;
}

function NextStep({ plan, sending, send, check, openThread }: {
  plan: MergePlan; sending: boolean; send: (action: Action, preparationId?: string) => void;
  check: () => void; openThread: (id: string) => void;
}) {
  const preparation = plan.state === "blocked" ? plan.preparations[0] : undefined;
  const waiters = waitsFor(plan);
  const hasResult = plan.results.some(({ head }) => head);
  let heading: string;
  let description: string;
  let action: Action | undefined;
  let label = "";
  if (busy(plan.state)) {
    heading = labels[plan.state];
    description = plan.message;
  } else if (waiters.length) {
    heading = "Рабочая папка занята";
    const next = preparation ? `Закоммитить ${branchName(preparation)}` : "Слить в main";
    description = `Кнопка «${next}» появится автоматически, когда работа в этих чатах закончится.`;
  } else if (plan.state === "failed") {
    heading = hasResult ? "Часть веток требует повторной проверки" : "Повтори проверку";
    description = plan.message;
    action = hasResult ? "retry" : "refresh";
    label = hasResult ? "Подготовить оставшиеся" : "Проверить заново";
  } else if (preparation) {
    heading = `Сохрани изменения в ${branchName(preparation)}`;
    description = preparation.commitAvailable ? "Проверь файлы, которые войдут в коммит."
      : "Создай коммит в рабочей папке, затем проверь готовность здесь.";
    action = preparation.commitAvailable ? "commit" : "refresh";
    label = preparation.commitAvailable ? `Закоммитить ${branchName(preparation)}` : "Проверить готовность";
  } else if (plan.state === "ready" && plan.branches.length) {
    heading = "Можно сливать";
    description = plan.message;
    action = "apply";
    label = "Слить в main";
  } else if (plan.state === "awaiting") {
    heading = "Выбери варианты для конфликтов";
    description = plan.explaining ? "Агент уточняет последствия сохранённых вариантов." : plan.message;
    if (!plan.explaining && plan.questions.some(({ explained }) => !explained)) {
      action = "explain";
      label = "Уточнить пояснения";
    }
  } else if (plan.state === "done") {
    heading = "Слияние завершено";
    description = "Результаты по проектам показаны ниже.";
  } else {
    heading = "Пока нечего сливать";
    description = plan.message;
    action = "refresh";
    label = "Проверить готовность";
  }

  return <section className="kb-merge-next" aria-label="Следующий шаг"
    data-tone={plan.state === "failed" ? "error" : waiters.length || plan.state === "awaiting" ? "wait" : "normal"}>
    <h3 aria-live="polite" className="text-sm font-semibold">{heading}</h3>
    {description && <p role={busy(plan.state) || plan.explaining ? "status" : plan.state === "failed" ? "alert" : undefined}
      className="break-words text-xs text-muted-foreground">{description}</p>}
    {!!waiters.length && <ul className="space-y-1 text-xs">
      {waiters.map(({ id, title, reason }) => <li key={id} className="flex flex-wrap items-baseline gap-x-2">
        <button type="button" className="break-words text-left text-foreground underline underline-offset-2" onClick={() => openThread(id)}>{title}</button>
        <span className="text-muted-foreground">{reason === "input" ? "Ждёт ответа" : reason === "queued" ? "Есть работа в очереди" : "Агент работает"}</span>
      </li>)}
    </ul>}
    {preparation && <PreparationFiles item={preparation} expanded={!waiters.length} />}
    {waiters.length ? <Button variant="outline" size="sm" onClick={check}>Проверить сейчас</Button>
      : action && <Button size="sm" disabled={sending} onClick={() => send(action, preparation?.id)}>{label}</Button>}
  </section>;
}

export function MergeCenter({ id, initialProjectId }: { id?: string; initialProjectId: string }) {
  const panel = experimental_useAppPanel();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof mergeRpc>();
  const projects = experimental_useSidebarThreads().projects;
  const openMerge = useOpenMerge();
  const [projectId, setProjectId] = useState(initialProjectId);
  const [starting, setStarting] = useState(false);
  const list = experimental_useRpcQuery({ contract: mergeRpc, method: "mergeHistory", input: null });
  const current = experimental_useRpcQuery({ contract: mergeRpc, method: "mergeStatus", input: { id: id ?? "" }, enabled: !!id });
  const plan = current.data?.id === id ? current.data : undefined;
  const skipped = plan?.skipped.filter(({ title, message }) => !plan.preparations.some((item) =>
    (item.kind === "worktree" && item.title === title && message === "Есть незакоммиченные изменения в worktree.") ||
    (item.kind === "main" && plan.state === "blocked" && message === "Сначала подготовь основную рабочую папку проекта."))) ?? [];
  const pending = busy(plan?.state) || !!plan?.explaining;
  const trackCurrent = !!plan && (pending || tracksCheckout(plan));
  const listPending = !!list.data?.some((job) => job.id !== id && busy(job.state));
  const trackList = listPending || !!list.data?.some((job) => job.id !== id && tracksCheckout(job));
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const refresh = useRef({ current: current.refetch, list: list.refetch });
  refresh.current = { current: current.refetch, list: list.refetch };
  useRealtime(worktreeChanged, () => {
    void refresh.current.list();
    if (id) void refresh.current.current();
  });
  useEffect(() => {
    if (!trackCurrent && !trackList) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      if (trackCurrent) void refresh.current.current();
      if (trackList) void refresh.current.list();
    }, pending || listPending ? 1100 : 3500);
    return () => clearInterval(timer);
  }, [trackCurrent, trackList, pending, listPending]);
  useEffect(() => { if (plan && !pending) void refresh.current.list(); }, [plan?.id, plan?.state, pending]);

  async function send(action: Action, preparationId?: string) {
    if (!id || !plan || sending) return;
    setSending(true);
    setError("");
    try {
      if (action === "apply") await rpc.call("applyMerge", { id });
      else if (action === "explain") await rpc.call("explainMerge", { id });
      else if (action === "refresh") await rpc.call("refreshMerge", { id });
      else if (action === "retry") {
        const next = await rpc.call("retryMerge", { id });
        if (next.id !== id) {
          navigate.toPluginPanel("board", { subPath: `merges/${next.id}` });
          return;
        }
      }
      else if (action === "commit" && preparationId) await rpc.call("commitMergeChanges", { id, preparationId });
      else if (action === "dismiss") {
        await rpc.call("dismissMerge", { id });
        await list.refetch();
        navigate.toPluginPanel("board", { subPath: "merges" });
        return;
      } else if (action === "answer") await rpc.call("answerMerge", {
        id, answers: plan.questions.map(({ id: questionId }) => ({ questionId, choiceId: answers[questionId] })),
      });
      if (action !== "explain") setAnswers({});
      await current.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }
  const open = (id: string) => navigate.toPluginPanel("board", { subPath: `merges/${id}` });
  const jobs = [...(list.data ?? [])].sort((a, b) => Number(b.state === "awaiting") - Number(a.state === "awaiting"));

  async function planReadyBranches() {
    if (starting) return;
    setStarting(true);
    try {
      await openMerge({ mode: "all", ...(projectId ? { projectId } : {}) });
    } finally {
      setStarting(false);
    }
  }

  return (
    <main className="kb-shell flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="kb-merge-header border-b border-border">
        <div className="kb-board-title">
          <span title="К доске"><Button variant="ghost" size="icon" className="size-8" aria-label="К доске" onClick={() => navigate.toPluginPanel("board")}>
            <Icon name="ArrowLeft" />
          </Button></span>
          <h1 className="font-semibold">Слияния</h1>
        </div>
        <div className="kb-merge-actions" role="group" aria-label="Подготовить слияние готовых задач">
          <select aria-label="Проект для слияния" className="rounded-md border border-input bg-background px-2 text-xs"
            value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">Все проекты</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <Button variant="outline" size="sm" disabled={starting} onClick={() => void planReadyBranches()}>
            <KanbanIcon name="merge" /> {starting ? "Проверяю…" : "Слить готовые"}
          </Button>
        </div>
      </header>
      <div className="kb-scroll kb-merge-scroll">
        <div className="kb-merge-layout">
          <nav aria-label="Операции слияния" className="kb-merge-history space-y-1 rounded-lg border border-border p-2">
            <h2 className="px-2 py-1 text-xs font-medium text-muted-foreground">Планы слияния</h2>
            {list.error && <p role="alert" className="text-xs text-destructive">{list.error.message}</p>}
            {!jobs.length && <p className="px-1 py-2 text-xs text-muted-foreground">{list.isLoading ? "Загружаю…" : "Планов слияния пока нет."}</p>}
            {jobs.map((job) => (
              <button key={job.id} type="button" aria-current={job.id === id ? "page" : undefined}
                className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-muted aria-[current=page]:bg-muted"
                onClick={() => open(job.id)}>
                <span className="block truncate text-sm font-medium" title={job.title}>{job.title || job.branches[0]?.title || "План слияния"}
                  {job.branches.length > 1 ? ` +${job.branches.length - 1}` : ""}</span>
                <PlanStatus plan={plan?.id === job.id ? plan : job} />
              </button>
            ))}
          </nav>
          <section aria-label="План и вопросы" className="kb-merge-plan rounded-lg border border-border">
            {current.error && <p role="alert" className="break-words text-sm text-destructive">{current.error.message}</p>}
            {!plan && !current.error && <p className="text-sm text-muted-foreground">
              {id ? "Загружаю план слияния…" : "Выбери план слева или нажми «Слить готовые» для задач на этапах «На проверке» и «Завершён»."}
            </p>}
            {plan && <>
              <div className="kb-merge-plan-heading">
                <div className="min-w-0 space-y-1">
                  <PlanStatus plan={plan} />
                  <h2 className="break-words text-base font-semibold">{plan.title || "План слияния"}</h2>
                </div>
                {!sending && (canRefresh(plan) || canDismiss(plan)) && <CardMenu label="Действия с планом" groups={[
                  { label: "План слияния", items: [
                    ...(canRefresh(plan) ? [{ label: "Обновить план", action: () => void send("refresh") }] : []),
                    ...(canDismiss(plan) ? [{ label: "Удалить план", destructive: true, action: () => void send("dismiss") }] : []),
                  ] },
                ]} />}
              </div>
              <MergeSteps plan={plan} />
              <NextStep plan={plan} sending={sending} send={(action, item) => void send(action, item)}
                check={() => { void current.refetch(); }} openThread={(id) => openChatWorkspace(panel, id, "Чат слияния")} />
              {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
              {plan.preparations.length > (plan.state === "blocked" ? 1 : 0) && <div className="space-y-2">
                <h3 className="text-sm font-medium">Другие папки с правками</h3>
                {plan.preparations.slice(plan.state === "blocked" ? 1 : 0).map((item) => (
                  <section key={item.id} className="space-y-2 rounded-lg border border-border p-2.5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{item.kind === "worktree" ? "Ветка задачи" : "Основная папка проекта"}</p>
                        <p className="break-all text-xs text-muted-foreground">{item.branch} · файлов {item.count}</p>
                      </div>
                      {item.commitAvailable && plan.state === "ready" && !item.waitingFor?.length &&
                        <Button size="sm" variant="outline" disabled={sending}
                          onClick={() => void send("commit", item.id)}>{`Закоммитить ${branchName(item)}`}</Button>}
                    </div>
                    <PreparationFiles item={item} />
                    {!item.commitAvailable && <p className="text-xs text-muted-foreground">Создай коммит в рабочей папке и нажми «Обновить план».</p>}
                  </section>
                ))}
              </div>}
              {!!plan.commits.length && <ul className="space-y-1 text-xs text-muted-foreground">
                {plan.commits.map(({ head, branch, subject }) => <li key={head} className="break-words">
                  Коммит создан · {branch} · {head.slice(0, 8)} · {subject}
                </li>)}
              </ul>}
              {!!plan.questions.length && <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void send("answer"); }}>
                {plan.questions.map(({ id, path, branch, question, choices, previews, explained }) => (
                  <fieldset key={id} disabled={sending || plan.explaining} className="min-w-0 space-y-1.5 rounded-lg border border-border px-2.5 pb-2.5">
                    <legend className="max-w-full px-1 text-sm font-medium [overflow-wrap:anywhere]">
                      {question.includes(path) ? question : `${path} · ${question}`}
                    </legend>
                    <p className="break-all text-xs text-muted-foreground">Входящая ветка · {branch}</p>
                    {!explained && <p className="text-xs text-muted-foreground">Агент ещё не уточнил последствия всех вариантов.</p>}
                    {previews && (previews.current !== null || previews.incoming !== null) && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground">Посмотреть версии файла</summary>
                        <div className="grid gap-2 py-1.5 sm:grid-cols-2">
                          {([["Текущая", previews.current], ["Из ветки", previews.incoming]] as const).map(([label, content]) => (
                            <div key={label} className="min-w-0">
                              <p className="font-medium">{label}</p>
                              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-1.5">{content ?? "Текст недоступен."}</pre>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                    {choices.map(({ id: choiceId, label, description }) => (
                      <label key={choiceId} className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 hover:bg-muted">
                        <input type="radio" name={id} value={choiceId} checked={answers[id] === choiceId}
                          onChange={() => setAnswers((previous) => ({ ...previous, [id]: choiceId }))} className="mt-1 shrink-0" />
                        <span className="min-w-0 text-sm [overflow-wrap:anywhere]">
                          <span className="font-medium">{label}</span>
                          <span className="mt-1 block whitespace-pre-wrap leading-relaxed">{description || "Пояснение к этому варианту недоступно."}</span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                ))}
                <Button type="submit" size="sm" disabled={sending || plan.explaining || plan.questions.some(({ id }) => !answers[id])}>Продолжить слияние</Button>
              </form>}
              {!!plan.branches.length && <details open={plan.state === "ready"}>
                <summary className="cursor-pointer text-sm">Порядок веток · {plan.branches.length}</summary>
                <ol className="mt-1 list-decimal space-y-1 rounded-md border border-border py-2 pl-8 pr-2 text-sm">
                  {plan.branches.map(({ id, title, project, branch, head }) => <li key={id} className="break-words">
                    {title} <span className="block break-all text-xs text-muted-foreground">{project} · {branch} · {head.slice(0, 8)}</span>
                  </li>)}
                </ol>
              </details>}
              {!!plan.resolved.length && <details open>
                <summary className="cursor-pointer text-sm">Разрешённые конфликты · {plan.resolved.length}</summary>
                <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                  {plan.resolved.map(({ path, branch, by, message }, index) => <li key={index} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {path} · {branch} · {by === "agent" ? "Агент" : "Твой выбор"} · {message}
                  </li>)}
                </ul>
              </details>}
              {!!skipped.length && <details open={!plan.branches.length}>
                <summary className="cursor-pointer text-sm">Пропущено · {skipped.length}</summary>
                <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                  {skipped.map(({ title, message }, index) => <li key={index} className="break-words">{title} · {message}</li>)}
                </ul>
              </details>}
              {!!plan.results.length && <ul className="space-y-1 text-sm">
                {plan.results.map(({ project, head, message }, index) => <li key={index}
                  className={`whitespace-pre-wrap break-words ${head ? "" : "text-destructive"}`}>
                  {project} · {message} {head?.slice(0, 8)}
                </li>)}
              </ul>}
            </>}
          </section>
        </div>
      </div>
    </main>
  );
}
