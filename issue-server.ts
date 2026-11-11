import { kanbanDatabase } from './database';
import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { issueReviewInput, issueRpc, issueSchema, issuesChanged, personalProjectId, suggestionSchema, type Issue } from "./issues";
import { emptyPlan, planSchema, withTestTag } from "./planning";
import { registerDerivations } from "./derive-server";
import { mergeHostRpc, sharedReviewResolution, sharedReviewResult, worktreeChanged } from "./merge-contract";
import type { WorkDiffs } from "./work-diff-server";
import type { registerMerges } from "./merge-server";
import type { z } from "zod";
import { reviewAgentInstructions, reviewToolName } from "./review-agent";
import { resolveLaunchSettings } from "./launch-settings";
import { personalGroupsKey } from "./projects";

const timeoutMs = 120_000;
const activeStatuses = new Set(["active", "starting", "stopping", "pending"]);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2000);

export function registerIssues(bb: BbPluginApi, workDiffs: WorkDiffs,
  inspectEnvironments: (ids: string[]) => ReturnType<ReturnType<typeof registerMerges>["inspectEnvironments"]>) {
  const db = kanbanDatabase(bb);

  const read = db.prepare("SELECT payload FROM kanban_issues WHERE id = ?");
  const scan = db.prepare("SELECT payload FROM kanban_issues");
  const remove = db.prepare("DELETE FROM kanban_issues WHERE id = ?");
  const write = db.prepare(`INSERT INTO kanban_issues (id, payload) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`);
  const parse = (row: unknown) => issueSchema.parse(JSON.parse((row as { payload: string }).payload));
  const list = () => scan.all().map(parse);
  const removingProjects = new Set<string>();
  function checkProject(projectId: string) {
    if (removingProjects.has(projectId)) throw new Error("Проект удаляется. Дождись завершения действия.");
  }
  function get(id: string) {
    const row = read.get(id);
    if (!row) throw new Error("Карточка не найдена.");
    const issue = parse(row);
    checkProject(issue.projectId);
    return issue;
  }
  function save(issue: Issue, changes: Partial<Issue> = {}) {
    const updated = issueSchema.parse({
      ...issue, updatedAt: Date.now(), ...changes, version: issue.version + 1,
    });
    write.run(updated.id, JSON.stringify(updated));
    return updated;
  }
  const publish = () => bb.realtime.publish(issuesChanged, null);
  const gitHost = bb.hosts.experimental_client({ contract: mergeHostRpc });
  const lifetime = new AbortController();
  const workers = new Set<string>();
  const reviewChecks = new Map<string, symbol>();
  const deleting = new Set<string>();
  const reviewWorker = db.prepare("SELECT worker_id, request, revision FROM kanban_review_workers WHERE issue_id=?");
  const workerRequest = db.prepare("SELECT request, revision FROM kanban_review_workers WHERE worker_id=?");
  const saveReviewWorker = db.prepare(`INSERT INTO kanban_review_workers VALUES (?, ?, ?, ?)
    ON CONFLICT(issue_id) DO UPDATE SET worker_id=excluded.worker_id, request=excluded.request, revision=excluded.revision`);
  const removeReviewWorker = db.prepare("DELETE FROM kanban_review_workers WHERE issue_id=?");
  bb.onDispose(() => lifetime.abort());

  function issueForThread(threadId: string) {
    return list().find((issue) => issue.threadIds.includes(threadId));
  }
  function newIssue(fields: Partial<Issue> & Pick<Issue, "projectId" | "status">) {
    checkProject(fields.projectId);
    const now = Date.now();
    return issueSchema.parse({
      ...emptyPlan, id: randomUUID(), title: "", parentId: null,
      assignee: "", blockedBy: [], related: [], duplicateOf: null, autoTitle: true, autoPlan: true,
      threadIds: [], messages: [], order: now, createdAt: now, updatedAt: now, version: 0, busy: null, error: null,
      ...fields,
    });
  }
  function validateLinks(issue: Issue, links: Pick<Issue, "parentId" | "blockedBy" | "related" | "duplicateOf">) {
    for (const id of new Set([links.parentId, links.duplicateOf, ...links.blockedBy, ...links.related])) {
      if (!id) continue;
      if (id === issue.id || get(id).projectId !== issue.projectId) {
        throw new Error("Связь должна вести к другой карточке того же проекта.");
      }
    }
    const seen = new Set([issue.id]);
    let parent = links.parentId;
    while (parent) {
      if (seen.has(parent)) throw new Error("В дереве подзадач получится цикл.");
      seen.add(parent);
      parent = get(parent).parentId;
    }
    const blockers = [...links.blockedBy];
    const visited = new Set<string>();
    while (blockers.length) {
      const blocker = blockers.pop()!;
      if (blocker === issue.id) throw new Error("Зависимости задач образуют цикл.");
      if (visited.has(blocker)) continue;
      visited.add(blocker);
      blockers.push(...get(blocker).blockedBy);
    }
    let duplicate = links.duplicateOf;
    while (duplicate) {
      if (duplicate === issue.id) throw new Error("Дубликаты задач образуют цикл.");
      duplicate = get(duplicate).duplicateOf;
    }
  }
  async function inspectThread(threadId: string, projectId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.projectId !== projectId || thread.deletedAt) throw new Error("Выбери доступный чат из этого проекта.");
    return thread;
  }
  async function checkpointIssues(items: Issue[]) {
    const ids = [...new Set(items.flatMap(({ threadIds }) => threadIds))];
    await Promise.allSettled(ids.map(async (threadId) => workDiffs.checkpoint(await bb.sdk.threads.get({ threadId }))));
  }
  async function projectCheckoutEnvironment(projectId: string) {
    const project = await bb.sdk.projects.get({ projectId });
    const source = project.sources.find((candidate) => candidate.isDefault) ?? project.sources[0];
    if (!source) throw new Error("У проекта нет подключённой рабочей папки.");
    return {
      type: "provider",
      environmentProviderId: "project-checkout",
      machine: { type: "existing", hostId: source.hostId },
      inputs: { path: source.path },
    } as const;
  }
  async function worktreeEnvironment(projectId: string, environmentId: string | null | undefined) {
    const [project, source] = await Promise.all([
      bb.sdk.projects.get({ projectId }),
      environmentId ? bb.sdk.environments.get({ environmentId }) : null,
    ]);
    let hostId = source?.hostId ?? project.sources.find((candidate) => candidate.isDefault)?.hostId;
    if (!hostId) {
      const providers = await bb.sdk.environments.listProviders({ projectId });
      const availability = providers.find((provider) => provider.id === "git-worktree")?.machineAvailability ?? {};
      const hosts = Object.entries(availability).filter(([, state]) => state?.status === "available");
      if (hosts.length !== 1) throw new Error("Для Git worktree нужна машина с доступной Git-копией проекта.");
      hostId = hosts[0][0];
    }
    return { type: "host", hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } } as const;
  }
  function ensureAvailable(issue: Issue) {
    checkProject(issue.projectId);
    if (issue.busy || deleting.has(issue.id)) throw new Error("Дождись завершения текущего действия.");
  }
  function claim(issue: Issue, kind: NonNullable<Issue["busy"]>["kind"], changes: Partial<Issue> = {}) {
    ensureAvailable(issue);
    return save(issue, { ...changes, busy: { kind, token: randomUUID(), at: Date.now() }, error: null });
  }

  async function deletionPlan(issue: Issue) {
    const cascades: { threadId: string; cascadeThreadIds: string[] }[] = [];
    for (let i = 0; i < issue.threadIds.length; i += 200) {
      const result = await bb.sdk.threads.experimental_listCascade({
        threadIds: issue.threadIds.slice(i, i + 200), action: "delete", signal: lifetime.signal,
      });
      cascades.push(...result.threads);
    }
    const linked = new Set(issue.threadIds);
    if (cascades.some(({ cascadeThreadIds }) => cascadeThreadIds.some((id) => !linked.has(id)))) {
      throw new Error("У связанного чата есть дочерние чаты вне этой карточки. Сначала перенеси их в другую ветку.");
    }
    // Delete children first so BB can refuse if an unconfirmed child has appeared.
    const threadIds = cascades.sort((a, b) => a.cascadeThreadIds.length - b.cascadeThreadIds.length ||
      a.threadId.localeCompare(b.threadId)).map(({ threadId }) => threadId);
    const threads = await Promise.all(threadIds.map((threadId) => bb.sdk.threads.get({ threadId })));
    const candidates = [...new Set(threads.flatMap(({ environmentId }) => environmentId ? [environmentId] : []))];
    const environments = await Promise.all(candidates.map(async (environmentId) => {
      const env = await bb.sdk.environments.get({ environmentId });
      if (!env.isWorktree || !env.managed || env.status === "destroyed") return null;
      for (const archived of [false, true]) {
        for (let offset = 0; ; offset += 200) {
          const users = await bb.sdk.threads.list({ environmentId, includeHidden: true, archived, limit: 200, offset });
          if (users.some(({ id }) => !linked.has(id))) return null;
          if (users.length < 200) break;
        }
      }
      return env;
    }));
    const worktrees = environments.flatMap((env) => env ? [env] : []).sort((a, b) => a.id.localeCompare(b.id));
    const worktreeIds = worktrees.map(({ id }) => id);
    const states = worktreeIds.length ? (await inspectEnvironments(worktreeIds)).states : new Map();
    const git = worktrees.map(({ id, branchName }) => {
      const info = states.get(id)?.info;
      return { id, branch: info?.branch ?? branchName, head: info?.head ?? null, state: info?.state ?? "unavailable" };
    });
    const warnings = git.flatMap(({ branch, state }) => {
      if (state === "merged") return [];
      const reason = state === "dirty" ? "есть незакоммиченные изменения"
        : state === "pending" ? "есть коммиты вне main"
        : state === "empty" ? "нет собственных коммитов" : "не удалось проверить состояние Git";
      return [`${branch ?? "Worktree"} — ${reason}.`];
    });
    const confirmation = createHash("sha256").update(JSON.stringify([issue.id, threadIds, git])).digest("hex");
    return { confirmation, threadIds, worktreeIds, warnings };
  }
  function finish(id: string, token: string, update: (current: Issue) => Partial<Issue>) {
    const current = get(id);
    if (current.busy?.token !== token) return current;
    const updated = save(current, { ...update(current), busy: null });
    publish();
    return updated;
  }
  type ReviewRequest = z.infer<typeof issueReviewInput>;
  type BlockedReview = Extract<z.infer<typeof sharedReviewResult>, { outcome: "blocked" }>;
  async function startReviewWorker(request: ReviewRequest, issue: Issue, blocked: BlockedReview, hostId: string, path: string) {
    const previous = reviewWorker.get(issue.id) as { worker_id: string; revision: string } | undefined;
    if (previous?.revision === blocked.revision) {
      const thread = await bb.sdk.threads.get({ threadId: previous.worker_id }).catch(() => null);
      if (thread && !thread.archivedAt && !thread.deletedAt && thread.status !== "error") return thread.id;
    }
    const worker = await bb.sdk.threads.spawn({
      projectId: personalProjectId, providerId: "codex", visibility: "visible",
      title: `Разбор правок · ${issue.title}`.slice(0, 180),
      environment: { type: "host", hostId, workspace: { type: "personal" } },
      permissionMode: "accept-edits",
      pluginMetadata: { sharedReview: true },
      prompt: `${reviewAgentInstructions}\n\nДанные проверки\n${JSON.stringify({
        ...request, path, linkedThreads: issue.threadIds, revision: blocked.revision,
        ambiguousPaths: blocked.paths.slice(0, 200), reason: blocked.message,
      })}`,
    });
    saveReviewWorker.run(issue.id, worker.id, JSON.stringify(request), blocked.revision);
    return worker.id;
  }
  bb.agents.registerTool({
    name: reviewToolName,
    description: "Повторить штатную проверку карточки. Передавай все пути с подтверждённой принадлежностью и исходную ревизию.",
    parameters: sharedReviewResolution,
    async execute(resolution, { threadId, signal }) {
      const row = workerRequest.get(threadId) as { request: string; revision: string } | undefined;
      if (!row || row.revision !== resolution.revision) return "Запуск устарел. Открой карточку и снова нажми «Проверено».";
      const request = issueReviewInput.parse(JSON.parse(row.request));
      try {
        const result = await reviewIssue(request, resolution, signal);
        return JSON.stringify({ status: result.issue.status, commit: result.commit, remaining: result.remaining, message: result.issue.error });
      } catch (error) {
        return errorText(error);
      }
    },
  });
  const cleanWorker = async (threadId: string) => {
    await bb.sdk.threads.archive({ threadId }).catch(() => {});
    await bb.sdk.threads.stop({ threadId }).catch(() => {});
  };
  registerDerivations(bb, db, {
    get, issueForThread, publish, cleanWorker, signal: lifetime.signal,
    childrenOf: (id) => list().filter((issue) => issue.parentId === id),
    create(source, native, plan, mode, tasks) {
      let parent = source.issueId ? get(source.issueId) : native ? issueForThread(native.id) : undefined;
      if (!parent) {
        if (!native || native.projectId !== source.projectId) throw new Error("Исходный чат больше не доступен.");
        const ancestor = native.parentThreadId ? issueForThread(native.parentThreadId) : undefined;
        parent = save(newIssue({
          ...plan, projectId: source.projectId, title: source.title.slice(0, 180), threadIds: [native.id],
          status: native.archivedAt ? "done" : native.status === "pending" ? "backlog"
            : activeStatuses.has(native.status) ? "working" : "done",
          parentId: ancestor?.projectId === native.projectId ? ancestor.id : null,
          autoTitle: false, autoPlan: !plan.notes,
        }));
      }
      const parentId = parent.id;
      return tasks.map((task, index) => save(newIssue({
        ...task, projectId: source.projectId, parentId, order: Date.now() + index,
        autoTitle: false, autoPlan: false,
        origin: { mode, issueId: parentId, threadId: source.threadId },
      })));
    },
  });
  function settlePlanning(issue: Issue) {
    const job = issue.busy;
    if (job?.kind !== "planning" || !job.threadId || workers.has(job.token)) return;
    const threadId = job.threadId;
    workers.add(job.token);
    void (async () => {
      try {
        await bb.sdk.threads.wait({
          threadId, status: "idle", signal: lifetime.signal, timeoutMs: Math.max(1000, timeoutMs - (Date.now() - job.at)),
        });
        const { output } = await bb.sdk.threads.output({ threadId });
        const raw = output?.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "") ?? "";
        const result = suggestionSchema.parse(JSON.parse(raw));
        finish(issue.id, job.token, (current) => ({
          title: current.autoTitle ? result.title : current.title,
          notes: current.autoPlan ? result.plan : current.notes,
          messages: [...current.messages, { role: "assistant", text: result.reply }],
        }));
      } catch (error) {
        if (!lifetime.signal.aborted) finish(issue.id, job.token, () => ({
          error: "Не удалось подготовить план. " + errorText(error),
        }));
      } finally {
        workers.delete(job.token);
        if (!lifetime.signal.aborted) await cleanWorker(threadId);
      }
    })().catch((error) => bb.log.warn("Kanban planning worker failed: " + errorText(error)));
  }
  function linkStarted(id: string, token: string, threadId: string) {
    return finish(id, token, (current) => ({
      status: "working",
      threadIds: [...new Set([...current.threadIds, threadId])],
    }));
  }

  bb.events.on("thread.created", async ({ thread }) => {
    if (thread.originPluginId !== bb.pluginId) return;
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: thread.id });
    if (typeof metadata.issueId === "string" && typeof metadata.startToken === "string") {
      linkStarted(metadata.issueId, metadata.startToken, thread.id);
    }
    if (typeof metadata.planningFor === "string" && typeof metadata.planningToken === "string") {
      const current = get(metadata.planningFor);
      if (current.busy?.token === metadata.planningToken && !current.busy.threadId) {
        settlePlanning(save(current, { busy: { ...current.busy, threadId: thread.id } }));
        publish();
      }
    }
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    const issue = issueForThread(thread.id);
    if (!issue) return;
    save(issue, { threadIds: issue.threadIds.filter((id) => id !== thread.id) });
    publish();
  });
  bb.events.on("thread.active", ({ thread }) => {
    if (thread.archivedAt || thread.deletedAt) return;
    const issue = issueForThread(thread.id);
    if (!issue) return;
    reviewChecks.delete(issue.id);
    if (issue.status === "done" || issue.status === "review") {
      removeReviewWorker.run(issue.id);
      save(issue, { status: "working", reviewWorker: null });
      publish();
    }
  });
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    if (thread.originPluginId === bb.pluginId) {
      const planning = list().find((issue) => issue.busy?.kind === "planning" && issue.busy.threadId === thread.id);
      if (planning) {
        settlePlanning(planning);
        return;
      }
    }
    if (!lastAssistantText) return;
    const issue = issueForThread(thread.id);
    if (issue?.status !== "working") return;
    const check = Symbol();
    reviewChecks.set(issue.id, check);
    try {
      const threads = await Promise.all(issue.threadIds
        .map((threadId) => bb.sdk.threads.get({ threadId }).catch(() => null)));
      // A newer start or completion makes this snapshot of the linked runs stale.
      if (lifetime.signal.aborted || reviewChecks.get(issue.id) !== check) return;
      const row = read.get(issue.id);
      if (!row) return;
      const current = parse(row);
      if (current.status === "working" && current.busy?.kind !== "start" &&
        current.threadIds.length === issue.threadIds.length && current.threadIds.every((id) => issue.threadIds.includes(id)) &&
        !threads.some((linked) => linked && !linked.archivedAt && !linked.deletedAt && activeStatuses.has(linked.status))) {
        save(current, { status: "review" });
        publish();
      }
    } finally {
      if (reviewChecks.get(issue.id) === check) reviewChecks.delete(issue.id);
    }
  });

  async function reviewIssue(request: ReviewRequest, resolution?: z.infer<typeof sharedReviewResolution>, signal = lifetime.signal) {
    const { id, threadId, environmentId, expectedHead, expectedBranch } = request;
    const issue = get(id);
    if (!issue.threadIds.includes(threadId)) throw new Error("Этот чат не связан с карточкой.");
    if (issue.status === "done") return { issue, commit: null, remaining: 0 };
    if (issue.status !== "review") throw new Error("Сначала переведи карточку в «На проверке».");
    const pending = claim(issue, "review");
    const token = pending.busy!.token;
    publish();
    let commit: Awaited<ReturnType<typeof gitHost.call<"commitCheckout">>> = null;
    try {
      const linked = await Promise.all(issue.threadIds.map((threadId) => bb.sdk.threads.get({ threadId })));
      const source = linked.find((thread) => thread.id === threadId);
      if (!source || source.deletedAt || source.projectId !== issue.projectId || source.environmentId !== environmentId) {
        throw new Error("Рабочая папка карточки изменилась. Открой «Изменения» заново.");
      }
      if (linked.some((thread) => !thread.archivedAt && !thread.deletedAt && activeStatuses.has(thread.status))) {
        throw new Error("Дождись завершения работы в чатах карточки.");
      }
      const environment = await bb.sdk.environments.get({ environmentId });
      if (environment.projectId !== issue.projectId || environment.status !== "ready" || !environment.isGitRepo || !environment.path) {
        throw new Error("Рабочая папка Git недоступна.");
      }
      const shared = !environment.isWorktree || !environment.branchName || environment.branchName === environment.defaultBranch;
      const occupants = await bb.sdk.threads.list({ environmentId, includeHidden: true, archived: false, limit: 200 });
      if (occupants.some((thread) => (!shared || issue.threadIds.includes(thread.id)) &&
        (activeStatuses.has(thread.status) || thread.hasPendingInteraction || thread.queuedWork === "waiting")) || get(id).status !== "review") {
        throw new Error("Рабочая папка занята. Дождись завершения работы агента.");
      }
      const checkout = { path: environment.path, title: issue.title || source.title || "Обновить рабочую копию", expectedHead, expectedBranch };
      const options = { hostId: environment.hostId, signal: AbortSignal.any([signal, lifetime.signal]) };
      if (shared) {
        const history = await workDiffs.capture(threadId, environmentId, issue.projectId);
        const runs = "runs" in history ? history.runs : undefined;
        const lastRun = runs?.at(-1);
        const latest = runs && runs.length > 1 ? await workDiffs.capture(threadId, environmentId, issue.projectId,
          undefined, { runId: runs[runs.length - 1].id }) : null;
        const commits = !resolution && lastRun && await workDiffs.recordGitHistory(source, history).catch((error) => {
          bb.log.warn(`Kanban could not check Git history for ${threadId}: ${errorText(error)}`);
          return [];
        });
        const committed = commits && commits.some(({ committedAt, files }) =>
          files?.length && committedAt >= Math.floor(lastRun!.startedAt / 1000) * 1000) ? commits : [];
        if (get(id).status !== "review") throw new Error("Работа в карточке возобновилась. Повтори проверку после завершения.");
        const result = await gitHost.call("reviewSharedCheckout", {
          ...checkout, threadId, snapshot: history.outcome === "available" ? history.snapshot : null,
          ...(latest?.outcome === "available" && { latest: latest.snapshot }), committed, resolution,
          requireFull: linked.some((thread) => thread.id !== threadId && !thread.deletedAt && thread.environmentId === environmentId),
        }, options);
        if (result.outcome === "blocked") {
          let workerId = issue.reviewWorker ?? null;
          let message = result.message;
          if (!resolution) {
            try {
              workerId = await startReviewWorker(request, issue, result, environment.hostId, environment.path);
            } catch (error) {
              message += " Не удалось запустить помощника. " + errorText(error);
            }
          }
          const updated = finish(id, token, () => ({ error: message, reviewWorker: workerId }));
          return { issue: updated, commit: null, remaining: 0, blocked: true };
        }
        commit = result.commit;
      } else {
        if (resolution) throw new Error("Окружение исходной проверки изменилось.");
        commit = await gitHost.call("commitCheckout", checkout, options);
      }
      const captured = await workDiffs.capture(threadId, environmentId, issue.projectId, commit?.head ?? expectedHead ?? undefined);
      if (commit) {
        await workDiffs.recordGitHistory(source, captured).catch((error) =>
          bb.log.warn(`Kanban could not record Git commit ${commit?.head}: ${errorText(error)}`));
      }
      const others = [...new Set(linked.filter((thread) => !thread.deletedAt && thread.environmentId !== environmentId)
        .flatMap((thread) => thread.environmentId ?? []))];
      const remaining = (await Promise.all(others.map(async (id) => {
        const environment = await bb.sdk.environments.get({ environmentId: id });
        if (!environment.isGitRepo || environment.status === "destroyed") return false;
        if (environment.status !== "ready" || !environment.path) return true;
        const { dirty } = await gitHost.call("inspectCheckout", { path: environment.path },
          { hostId: environment.hostId, signal: lifetime.signal });
        return dirty;
      }))).filter(Boolean).length;
      if (!remaining) await Promise.allSettled(linked.filter(({ id, deletedAt }) => id !== threadId && !deletedAt)
        .map(workDiffs.checkpoint));
      const reviewed = finish(id, token, (current) => ({
        reviewWorker: null,
        status: current.status === "review" && !remaining &&
          current.threadIds.length === issue.threadIds.length && current.threadIds.every((id) => issue.threadIds.includes(id))
          ? "done" : current.status,
      }));
      removeReviewWorker.run(id);
      return { issue: reviewed, commit, remaining };
    } catch (error) {
      if (!lifetime.signal.aborted) finish(id, token, () => ({ error: errorText(error) }));
      throw error;
    } finally {
      if (commit && !lifetime.signal.aborted) bb.realtime.publish(worktreeChanged, null);
    }
  }

  bb.rpc.register(issueRpc, {
    issueList() {
      return list().map((issue) => {
        settlePlanning(issue);
        if (issue.busy && !issue.busy.threadId && Date.now() - issue.busy.at > timeoutMs) {
          return finish(issue.id, issue.busy.token, () => ({ error: "Действие прервалось. Можно повторить." }));
        }
        return issue;
      });
    },
    async issueCreate({ projectId, status, parentId, threadId, test }) {
      if (threadId) {
        const linked = issueForThread(threadId);
        if (linked) return linked;
      }
      const thread = threadId ? await inspectThread(threadId, projectId) : null;
      if (!thread) await bb.sdk.projects.get({ projectId });
      const plan = threadId ? planSchema.parse(await bb.sdk.threads.getPluginMetadata({ threadId })) : emptyPlan;
      if (threadId) {
        const linked = issueForThread(threadId);
        if (linked) return linked;
      }
      const issue = newIssue({
        ...plan, tags: test ? withTestTag(plan.tags) : plan.tags, projectId, status, parentId: parentId ?? null,
        title: (thread?.title ?? thread?.titleFallback ?? "").slice(0, 180),
        autoTitle: !thread, autoPlan: !plan.notes, threadIds: threadId ? [threadId] : [],
      });
      validateLinks(issue, issue);
      const updated = save(issue);
      publish();
      return updated;
    },
    issueSave({ id, version, fields }) {
      const issue = get(id);
      if (issue.version !== version) throw new Error("Карточка уже обновилась. Проверь изменения и сохрани ещё раз.");
      validateLinks(issue, fields);
      const updated = save(issue, fields);
      publish();
      return updated;
    },
    async issueMove({ id, status, beforeId, atEnd }) {
      const saved = await bb.storage.kv.get<unknown>(personalGroupsKey);
      const grouped = new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []);
      const groupOf = (projectId: string) => grouped.has(projectId) ? personalProjectId : projectId;
      const issue = get(id);
      if (beforeId === id || (!beforeId && !atEnd && issue.status === status)) return issue;
      const lane = list().filter((candidate) => groupOf(candidate.projectId) === groupOf(issue.projectId) &&
        candidate.status === status && candidate.id !== id).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      const target = beforeId ? lane.findIndex((candidate) => candidate.id === beforeId) : lane.length;
      if (target < 0) throw new Error("Эта позиция больше не доступна.");
      lane.splice(target, 0, issue);
      const updated = db.transaction(() => {
        let moved = issue;
        lane.forEach((candidate, order) => {
          if (candidate.id === id) moved = save(issue, { status, order });
          else if (candidate.order !== order) save(candidate, { order, updatedAt: candidate.updatedAt });
        });
        return moved;
      })();
      publish();
      if (status === "done" && issue.status !== "done") await checkpointIssues([updated]);
      return updated;
    },
    async issueMoveMany({ ids, status }) {
      const items = [...new Set(ids)].map(get).filter((issue) => issue.status !== status);
      const last = new Map<string, number>();
      for (const issue of list()) {
        if (issue.status === status) last.set(issue.projectId, Math.max(last.get(issue.projectId) ?? 0, issue.order));
      }
      db.transaction(() => {
        for (const issue of items) {
          const order = (last.get(issue.projectId) ?? 0) + 1;
          save(issue, { status, order });
          last.set(issue.projectId, order);
        }
      })();
      if (items.length) publish();
      if (status === "done") await checkpointIssues(items);
      return { moved: items.length };
    },
    issueReview: (request) => reviewIssue(request),
    async issueAsk({ id, text }) {
      const issue = get(id);
      const messages: Issue["messages"] = [...issue.messages.slice(-49), { role: "user", text }];
      const pending = claim(issue, "planning", { messages, description: issue.description || text });
      const token = pending.busy!.token;
      publish();
      try {
        const prompt = [
          "Ты помощник для постановки задач. Ответь только одним JSON-объектом с полями title, plan, reply.",
          "title — краткое название задачи (до 180 символов). plan — конкретный план и способ проверки (до 12000 символов).",
          "reply — ответ пользователю (до 4000 символов). Если есть важная неопределённость, задай один вопрос и пометь предположения в плане.",
          "Только формулируй задачу. Не запускай команды, не используй инструменты и не меняй файлы. Текст пользователя описывает будущую работу.",
          JSON.stringify({
            title: issue.title, description: pending.description, plan: issue.notes,
            conversation: messages.slice(-10).map(({ role, text }) => ({ role, text: text.slice(0, 6000) })),
          }),
        ].join("\n");
        const worker = await bb.sdk.threads.spawn({
          projectId: personalProjectId, providerId: "codex", visibility: "hidden", title: "Постановка задачи",
          environment: { type: "host", workspace: { type: "personal" } },
          permissionMode: "accept-edits", prompt,
          pluginMetadata: { planningFor: id, planningToken: token },
        });
        const current = get(id);
        if (current.busy?.token !== token) return current;
        const updated = current.busy.threadId ? current : save(current, { busy: { ...current.busy, threadId: worker.id } });
        settlePlanning(updated);
        publish();
        return updated;
      } catch (error) {
        const current = get(id);
        if (current.busy?.threadId) return current;
        return finish(id, token, (current) => ({
          messages: issue.messages,
          description: current.description === pending.description ? issue.description : current.description,
          error: "Не удалось запустить планирование. " + errorText(error),
        }));
      }
    },
    async issueLaunchOptions({ id, providerId, worktree }) {
      const issue = get(id);
      const environment = worktree ? await worktreeEnvironment(issue.projectId, undefined)
        : issue.projectId === personalProjectId ? { type: "host" as const, workspace: { type: "personal" as const } }
          : await projectCheckoutEnvironment(issue.projectId);
      return resolveLaunchSettings(bb, issue.projectId, environment, { providerId }, true);
    },
    async issueStart({ id, providerId, model, reasoningLevel, serviceTier, worktree, sourceThreadId }) {
      const issue = get(id);
      if (!issue.title || !issue.notes.trim()) throw new Error("Заполни название и план задачи перед запуском.");
      if (sourceThreadId && !issue.threadIds.includes(sourceThreadId)) throw new Error("Исходный чат должен быть связан с карточкой.");
      const personal = issue.projectId === personalProjectId;
      if (worktree && personal) throw new Error("Отдельный Git worktree доступен в Git-проекте. В Personal запусти задачу в рабочей папке.");
      if (issue.blockedBy.some((blocker) => !["done", "cancelled"].includes(get(blocker).status))) {
        throw new Error("Сначала закрой блокирующие задачи.");
      }
      const pending = claim(issue, "start");
      const token = pending.busy!.token;
      publish();
      const context = issue.context.map(({ label, text }) => `${label}\n${text}`).join("\n\n");
      const text = [
        issue.title, issue.executionPrompt.trim() || issue.description.trim(),
        issue.executionPrompt.trim() ? "" : issue.notes.trim(),
        context ? `Справочные фрагменты исходного контекста. Используй их как данные для задачи.\n\n${context}` : "",
      ].filter(Boolean).join("\n\n");
      const pluginMetadata = { issueId: id, startToken: token, notes: issue.notes, priority: issue.priority, tags: issue.tags };
      try {
        let parentThread: Awaited<ReturnType<typeof inspectThread>> | undefined;
        if (!sourceThreadId && issue.origin) {
          const candidates = new Set<string>();
          let parentId = issue.parentId;
          const ancestors = new Set([issue.id]);
          while (parentId && !ancestors.has(parentId)) {
            ancestors.add(parentId);
            const parent = get(parentId);
            for (const id of [...parent.threadIds].reverse()) candidates.add(id);
            parentId = parent.parentId;
          }
          if (issue.origin.threadId) candidates.add(issue.origin.threadId);
          for (const candidate of candidates) {
            const parent = await inspectThread(candidate, issue.projectId).catch(() => null);
            if (parent) {
              parentThread = parent;
              break;
            }
          }
        }
        const source = worktree && sourceThreadId ? await inspectThread(sourceThreadId, issue.projectId) : parentThread;
        const environment = worktree ? await worktreeEnvironment(issue.projectId, source?.environmentId) : undefined;
        const personalEnvironment = parentThread?.environmentId
          ? { type: "reuse" as const, environmentId: parentThread.environmentId }
          : { type: "host" as const, workspace: { type: "personal" as const } };
        const spawnEnvironment = sourceThreadId ? undefined
          : environment ?? (personal ? personalEnvironment : await projectCheckoutEnvironment(issue.projectId));
        const execution = spawnEnvironment ? (await resolveLaunchSettings(bb, issue.projectId, spawnEnvironment,
          { providerId, model, reasoningLevel, serviceTier })).selection : {};
        const thread = sourceThreadId
          ? await bb.sdk.threads.fork({
            sourceThreadId, title: issue.title, pluginMetadata, ...(environment ? { environment } : {}),
            input: [{ type: "text", text, mentions: [] }],
          })
          : await bb.sdk.threads.spawn({
            projectId: issue.projectId, title: issue.title, ...execution,
            ...(parentThread ? { parentThreadId: parentThread.id, parentNotifications: "off" as const } : {}),
            environment: spawnEnvironment!,
            pluginMetadata, prompt: text,
          });
        return { issue: linkStarted(id, token, thread.id), threadId: thread.id };
      } catch (error) {
        finish(id, token, () => ({ error: errorText(error) }));
        throw error;
      }
    },
    async issueLink({ id, threadId, linked }) {
      const issue = get(id);
      if (deleting.has(id)) throw new Error("Карточка удаляется.");
      if (linked) {
        await inspectThread(threadId, issue.projectId);
        const owner = issueForThread(threadId);
        if (owner && owner.id !== id) throw new Error("Этот чат уже связан с другой карточкой.");
      }
      const current = get(id);
      if (deleting.has(id)) throw new Error("Карточка удаляется.");
      const ids = new Set(current.threadIds);
      if (linked) ids.add(threadId);
      else ids.delete(threadId);
      const updated = save(current, { threadIds: [...ids] });
      publish();
      return updated;
    },
    async issueDeletePreview({ id }) {
      const issue = get(id);
      ensureAvailable(issue);
      const { confirmation, threadIds, worktreeIds, warnings } = await deletionPlan(issue);
      return { confirmation, chats: threadIds.length, worktrees: worktreeIds.length, warnings };
    },
    async issueDelete({ id, confirmation }) {
      if (!read.get(id)) return { deleted: false };
      const issue = get(id);
      ensureAvailable(issue);
      deleting.add(id);
      try {
        const plan = await deletionPlan(issue);
        if (plan.confirmation !== confirmation) throw new Error("Связи карточки или состояние worktree изменились. Проверь условия удаления ещё раз.");
        for (const threadId of plan.threadIds) await bb.sdk.threads.delete({ threadId, childThreadsConfirmed: false });
        // BB also retires these environments in the background. Request cleanup now for unused worktrees.
        await Promise.all(plan.worktreeIds.map((environmentId) => bb.sdk.environments.experimental_cleanup({ environmentId })
          .catch((error) => bb.log.warn(`Kanban worktree cleanup ${environmentId}: ${errorText(error)}`))));
        db.transaction(() => {
          for (const item of list()) {
            if (item.id === id) continue;
            const { parentId, duplicateOf, blockedBy, related } = item;
            if (parentId === id || duplicateOf === id || blockedBy.includes(id) || related.includes(id)) {
              save(item, {
                parentId: parentId === id ? null : parentId, duplicateOf: duplicateOf === id ? null : duplicateOf,
                blockedBy: blockedBy.filter((candidate) => candidate !== id),
                related: related.filter((candidate) => candidate !== id),
              });
            }
          }
          remove.run(id);
          removeReviewWorker.run(id);
        })();
        publish();
        return { deleted: true };
      } finally {
        deleting.delete(id);
      }
    },
  });
  return {
    list, get,
    projectIssues: (projectId: string) => list().filter((issue) => issue.projectId === projectId),
    prepareProjectRemoval(projectId: string) {
      checkProject(projectId);
      const items = list().filter((issue) => issue.projectId === projectId);
      items.forEach(ensureAvailable);
      removingProjects.add(projectId);
      return {
        commit() {
          db.transaction(() => {
            for (const issue of list().filter((item) => item.projectId === projectId)) save(issue, { projectId: personalProjectId });
          })();
          publish();
        },
        release: () => { removingProjects.delete(projectId); },
      };
    },
  };
}
