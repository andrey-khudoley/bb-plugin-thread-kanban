import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import { derivationRpc, type DeriveResult } from "./issues";
import type { DeriveSelection } from "./derive-dialog";
import { activityStore, type ActivityRun as Run } from "./activity-store";

export function useActivityRuns() {
  const store = activityStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useDerivationActivity(scope: string) {
  const rpc = useRpc<typeof derivationRpc>();
  const store = activityStore();

  async function start(selection: DeriveSelection, instruction: string, beforeStart?: () => Promise<void>) {
    const { source, mode, test } = selection;
    const { key, created } = store.add(scope, selection, instruction);
    window.dispatchEvent(new Event('kanban:show-notifications'));
    if (!created) return;
    window.dispatchEvent(new CustomEvent('bb:status-popup', { detail: {
      id: `derivation:${key}:${Date.now()}`, label: mode === 'single' ? 'Порождение задачи' : 'Декомпозиция', title: selection.title,
    } }));
    try {
      await beforeStart?.();
      const result = await rpc.call("deriveTasks", { source, mode, instruction, test });
      store.update(key, { jobId: result.id, result });
    } catch (cause) {
      const error = (cause instanceof Error ? cause.message : String(cause)) || "BB не смог запустить подготовку карточек.";
      store.update(key, { error });
    }
  }

  return { start };
}

const phases = [
  { id: "context", current: "Собираем исходный контекст…", complete: "Исходный контекст собран" },
  { id: "starting", current: "Запускаем агента…", complete: "Запрос передан агенту" },
  { id: "waiting", current: "Ожидаем ответ агента…", complete: "Ответ агента получен" },
  { id: "checking", current: "Проверяем ответ агента…", complete: "Ответ агента проверен" },
  { id: "saving", current: "Сохраняем результат в дереве…", complete: "Результат сохранён" },
] as const;

function runStatus({ result, error, pollError, jobId }: Run) {
  const done = result?.status === "done";
  const failed = !!error || result?.status === "failed";
  const pending = !done && !failed;
  const phaseIndex = phases.findIndex(({ id }) => id === (result?.phase ?? "context"));
  const summary = done ? `Создано карточек · ${result.children.length}` : failed ? "Ошибка подготовки" :
    pollError ? "Восстанавливаем связь с BB…" : result ? phases[phaseIndex].current :
      jobId ? "Получаем статус запуска…" : "Готовим запуск…";
  return { failed, pending, phaseIndex, summary };
}

function runTitle({ selection }: Run) {
  return selection.mode === "single" ? "Порождение задачи" : "Декомпозиция";
}

function ActivityPoll({ jobId, runKey, update }: {
  jobId: string; runKey: number; update: (key: number, result?: DeriveResult) => void;
}) {
  const rpc = useRpc<typeof derivationRpc>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll(id: string) {
      try {
        const current = await rpcRef.current.call("derivationStatus", { id });
        if (cancelled) return;
        update(runKey, current);
        if (current.status !== "running") return;
      } catch {
        if (cancelled) return;
        update(runKey);
      }
      timer = setTimeout(() => void poll(id), 1200);
    }
    timer = setTimeout(() => void poll(jobId), 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [jobId, runKey, update]);
  return null;
}

function ActivityRun({ run, expanded, toggle, dismiss, openTree }: {
  run: Run; expanded: boolean;
  toggle: () => void; dismiss: () => void; openTree: (id: string) => void;
}) {
  const detailsId = useId();
  const { result, error, selection } = run;
  const done = result?.status === "done";
  const { failed, pending, phaseIndex, summary } = runStatus(run);
  const completed = phases.slice(0, done ? phases.length : phaseIndex);
  const hasActivity = !!result?.activity?.length;
  const history = <>
    {!!completed.length && <ul aria-label="Завершённые этапы" className="text-muted-foreground">
      {completed.map(({ id, complete }) => <li key={id}>✓ {complete}</li>)}
    </ul>}
    {hasActivity && <ul aria-label="События агента" className="list-disc space-y-1 pl-4">
      {result.activity.map((text) => <li key={text}>{text}</li>)}
    </ul>}
  </>;

  return (
    <article className="rounded-md border border-border bg-background p-2">
      <header className="kb-activity-head">
        <div className="kb-activity-text">
          <div className="font-medium">{runTitle(run)} · {selection.title}</div>
          <p className={failed ? "text-destructive" : "text-muted-foreground"}>{summary}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button type="button" variant="outline" size="sm" className="h-7 px-2" aria-expanded={expanded}
            aria-controls={detailsId} onClick={toggle}>{expanded ? "Свернуть" : "Развернуть"}</Button>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2" aria-label={`Скрыть уведомление: ${selection.title}`}
            onClick={dismiss}>×</Button>
        </div>
      </header>
      <div id={detailsId} hidden={!expanded} className="kb-activity-text mt-2 space-y-2 border-t border-border pt-2">
        {pending && <p>Агент анализирует контекст и готовит карточки…</p>}
        {failed && <p role="alert" className="text-destructive">{error || result?.message || "Подготовка карточек прервана."}</p>}
        {pending && result?.phase === "waiting" && result.agentStarted && <p className="text-muted-foreground">Агент начал работу</p>}
        {done && result.children.length > 0 && <>
          <ul className="space-y-1">
            {result.children.map((issue) => <li key={issue.id}>
              <button type="button" className="text-left text-primary hover:underline" onClick={() => openTree(issue.id)}>
                {issue.title}
              </button>
            </li>)}
          </ul>
          {result.parentId && <Button type="button" size="sm" variant="outline" onClick={() => openTree(result.parentId!)}>Открыть дерево</Button>}
        </>}
        {done && result.message && <p>{result.message}</p>}
        {pending ? history : (!!completed.length || hasActivity) && <details>
          <summary className="cursor-pointer text-muted-foreground">Этапы и события</summary>
          <div className="mt-1 space-y-1">{history}</div>
        </details>}
      </div>
    </article>
  );
}

/** Mounted once by the app overlay, even when the notification list is closed. */
export function DerivationPolling() {
  const runs = useActivityRuns();
  const update = useCallback((key: number, result?: DeriveResult) => {
    activityStore().update(key, { ...(result && { result }), pollError: !result });
  }, []);
  return runs.map(run => run.jobId && runStatus(run).pending &&
    <ActivityPoll key={run.key} jobId={run.jobId} runKey={run.key} update={update} />);
}

export function DerivationNotifications({ openTree }: { openTree: (id: string) => void }) {
  const runs = useActivityRuns();
  return runs.filter(run => !run.hidden).map(run => <NotificationRun key={run.key} run={run} openTree={openTree} />);
}

function NotificationRun({ run, openTree }: { run: Run; openTree: (id: string) => void }) {
  const [expanded, setExpanded] = useState(true);
  return <ActivityRun run={run} expanded={expanded} toggle={() => setExpanded(value => !value)}
    dismiss={() => activityStore().hide(run.key)} openTree={openTree} />;
}
