import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { mergeHostRpc } from "./merge-contract";
import { workDiffChanged, workDiffRpc, workGitCommit, workSnapshot, type WorkDiffResult, type WorkRun, type WorkSnapshot } from "./work-diff-contract";

type WorktreeRange = Pick<WorkSnapshot, "base" | "head" | "branch">;
type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
type MergeTarget = { hostId: string; projectId: string; root: string };
type MergeJob = {
  order: { target: MergeTarget; candidate: { id: string; branch: string }; head: string }[];
  view: { results: { head: string | null }[] };
};

export function registerWorkDiffs(bb: BbPluginApi) {
  const db = bb.storage.database();
  db.exec(`CREATE TABLE IF NOT EXISTS kanban_work_diffs (
    environment_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, frozen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kanban_work_diff_threads (
    thread_id TEXT PRIMARY KEY, environment_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kanban_worktree_ranges (
    environment_id TEXT PRIMARY KEY, base TEXT NOT NULL, head TEXT NOT NULL, branch TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kanban_shared_work_diffs (
    thread_id TEXT NOT NULL, environment_id TEXT NOT NULL, origin TEXT, snapshot TEXT,
    PRIMARY KEY (thread_id, environment_id)
  );
  CREATE TABLE IF NOT EXISTS kanban_shared_work_runs (
    thread_id TEXT NOT NULL, environment_id TEXT NOT NULL, run_id TEXT NOT NULL,
    started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, snapshot TEXT NOT NULL,
    PRIMARY KEY (thread_id, environment_id, run_id)
  );
  CREATE TABLE IF NOT EXISTS kanban_work_git_history (
    thread_id TEXT NOT NULL, environment_id TEXT NOT NULL, sha TEXT NOT NULL, commit_data TEXT NOT NULL, patch TEXT,
    PRIMARY KEY (thread_id, environment_id, sha)
  );`);
  const read = db.prepare("SELECT snapshot FROM kanban_work_diffs WHERE environment_id=?");
  const save = db.prepare(`INSERT INTO kanban_work_diffs VALUES (?, ?, ?)
    ON CONFLICT(environment_id) DO UPDATE SET snapshot=excluded.snapshot, frozen=MAX(kanban_work_diffs.frozen, excluded.frozen)
    WHERE kanban_work_diffs.snapshot<>excluded.snapshot OR kanban_work_diffs.frozen<excluded.frozen`);
  const lookup = db.prepare("SELECT environment_id FROM kanban_work_diff_threads WHERE thread_id=?");
  const link = db.prepare(`INSERT INTO kanban_work_diff_threads VALUES (?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET environment_id=excluded.environment_id`);
  const freeze = db.prepare("UPDATE kanban_work_diffs SET frozen=1 WHERE environment_id=? AND json_extract(snapshot, '$.head')=?");
  const rangeRead = db.prepare("SELECT base, head, branch FROM kanban_worktree_ranges WHERE environment_id=?");
  const rangeSave = db.prepare(`INSERT INTO kanban_worktree_ranges VALUES (?, ?, ?, ?)
    ON CONFLICT(environment_id) DO UPDATE SET base=excluded.base, head=excluded.head, branch=excluded.branch
    WHERE base<>excluded.base OR head<>excluded.head OR branch<>excluded.branch`);
  const sharedRead = db.prepare("SELECT origin, snapshot FROM kanban_shared_work_diffs WHERE thread_id=? AND environment_id=?");
  const sharedLast = db.prepare("SELECT environment_id FROM kanban_shared_work_diffs WHERE thread_id=? AND snapshot IS NOT NULL ORDER BY rowid DESC LIMIT 1");
  const sharedOrigin = db.prepare(`INSERT INTO kanban_shared_work_diffs (thread_id, environment_id, origin) VALUES (?, ?, ?)
    ON CONFLICT(thread_id, environment_id) DO UPDATE SET origin=excluded.origin WHERE origin IS NULL`);
  const sharedSave = db.prepare(`INSERT INTO kanban_shared_work_diffs (thread_id, environment_id, snapshot) VALUES (?, ?, ?)
    ON CONFLICT(thread_id, environment_id) DO UPDATE SET snapshot=excluded.snapshot`);
  const runList = db.prepare(`SELECT run_id AS id, started_at AS startedAt, ended_at AS endedAt
    FROM kanban_shared_work_runs WHERE thread_id=? AND environment_id=? ORDER BY started_at, rowid`);
  const runRead = db.prepare("SELECT snapshot FROM kanban_shared_work_runs WHERE thread_id=? AND environment_id=? AND run_id=?");
  const lastRun = db.prepare("SELECT environment_id FROM kanban_shared_work_runs WHERE thread_id=? ORDER BY ended_at DESC LIMIT 1");
  const runSave = db.prepare("INSERT OR IGNORE INTO kanban_shared_work_runs VALUES (?, ?, ?, ?, ?, ?)");
  const gitCommits = db.prepare("SELECT commit_data FROM kanban_work_git_history WHERE thread_id=? AND environment_id=?");
  const gitLast = db.prepare("SELECT environment_id FROM kanban_work_git_history WHERE thread_id=? ORDER BY rowid DESC LIMIT 1");
  const gitCommit = db.prepare("SELECT commit_data, patch FROM kanban_work_git_history WHERE thread_id=? AND environment_id=? AND sha=?");
  const gitSave = db.prepare("INSERT OR IGNORE INTO kanban_work_git_history (thread_id, environment_id, sha, commit_data) VALUES (?, ?, ?, ?)");
  const gitSavePatch = db.prepare("UPDATE kanban_work_git_history SET patch=? WHERE thread_id=? AND environment_id=? AND sha=?");
  const host = bb.hosts.experimental_client({ contract: mergeHostRpc });
  const lifetime = new AbortController();
  bb.onDispose(() => lifetime.abort());
  const pending = new Map<string, Promise<unknown>>();

  function previous(environmentId: string) {
    const row = read.get(environmentId) as { snapshot: string } | undefined;
    return row ? { snapshot: workSnapshot.parse(JSON.parse(row.snapshot)) } : null;
  }
  const storedRange = (environmentId: string) => rangeRead.get(environmentId) as WorktreeRange | undefined;
  function merged(environmentId: string, projectId: string) {
    const merges = db.prepare(`SELECT payload FROM kanban_merge_jobs
      WHERE EXISTS (SELECT 1 FROM json_each(payload, '$.order') WHERE json_extract(value, '$.candidate.id')=?)
      ORDER BY created_at DESC`);
    for (const { payload } of merges.all(environmentId) as { payload: string }[]) {
      const job = JSON.parse(payload) as MergeJob;
      const branch = job.order.find(({ candidate }) => candidate.id === environmentId);
      if (!branch || branch.target.projectId !== projectId) continue;
      // Merge results are written in repository-group order, including failed groups.
      const key = ({ hostId, root }: MergeTarget) => JSON.stringify([hostId, root]);
      const targets = [...new Set(job.order.map(({ target }) => key(target)))];
      const result = job.view.results[targets.indexOf(key(branch.target))];
      if (result?.head) return { ...branch, mergedAt: result.head };
    }
    return null;
  }
  function serialize<T>(environmentId: string, operation: () => Promise<T>) {
    const task = (pending.get(environmentId) ?? Promise.resolve()).catch(() => {}).then(operation);
    pending.set(environmentId, task);
    const release = () => { if (pending.get(environmentId) === task) pending.delete(environmentId); };
    void task.then(release, release);
    return task;
  }

  const unavailable = (detail?: string) => ({ outcome: "unavailable" as const,
    message: `История изменений недоступна.${detail ? ` ${detail}` : " Не удалось установить исходное состояние и вершину выбранной работы."}` });
  const available = (snapshot: WorkSnapshot, saved: boolean) => ({ outcome: "available" as const, snapshot, saved });
  const isolated = (env: Environment) => env.isWorktree && !!env.branchName && env.branchName !== env.defaultBranch;
  type Origin = Awaited<ReturnType<typeof host.call<"sharedWorkOrigin">>>;
  type SharedRow = { origin: string | null; snapshot: string | null };
  const readShared = (threadId: string, environmentId: string) => sharedRead.get(threadId, environmentId) as SharedRow | undefined;
  const hostOptions = (env: Environment) => ({ hostId: env.hostId, signal: lifetime.signal });
  const savedRuns = (threadId: string, environmentId: string) => runList.all(threadId, environmentId) as WorkRun[];
  function savedRun(threadId: string, environmentId: string, runId: string) {
    const row = runRead.get(threadId, environmentId, runId) as { snapshot: string } | undefined;
    return row && available(workSnapshot.parse(JSON.parse(row.snapshot)), true);
  }

  async function recordOrigin(thread: Thread, env: Environment) {
    if (isolated(env) || env.status !== "ready" || !env.path) return false;
    return serialize(thread.id, async () => {
      if (readShared(thread.id, env.id)?.origin) return true;
      // A warm turn must not replace a missing initial checkpoint with today's HEAD.
      const [started] = await bb.sdk.threads.events.list({
        threadId: thread.id, limit: "1", order: "asc", types: ["turn/started"], signal: lifetime.signal,
      });
      if (started) return env.isGitRepo;
      const origin = await host.call("sharedWorkOrigin", { path: env.path! }, hostOptions(env));
      if (!origin) return false;
      sharedOrigin.run(thread.id, env.id, JSON.stringify(origin));
      return true;
    });
  }

  // The provider gives its shell's Git updates a thread-specific reflog label.
  // Ordinary Git operations in the checkout keep their own reflog labels.
  for (const provider of ["codex", "claude-code", "pi", "acp-cursor"]) {
    bb.providers.experimental_contributeEnv(provider, async ({ threadId }) => {
      if (!threadId) return [];
      try {
        const thread = await bb.sdk.threads.get({ threadId, signal: lifetime.signal });
        if (thread.environmentId) {
          const env = await bb.sdk.environments.get({ environmentId: thread.environmentId, signal: lifetime.signal });
          if (!await recordOrigin(thread, env)) return [];
        }
      } catch (error) {
        bb.log.warn(`Kanban could not record Git origin for ${threadId}: ${String(error)}`);
      }
      return [{ name: "GIT_REFLOG_ACTION", value: `bb-kanban:${threadId}`, reason: "Связать Git-коммиты с историей карточки канбана" }];
    });
  }

  async function captureShared(threadId: string, env: Environment, runId?: string, checkpointRun = false) {
    return serialize(threadId, async () => {
      if (runId) {
        const saved = savedRun(threadId, env.id, runId);
        if (saved) return saved;
      }
      const stored = readShared(threadId, env.id);
      const saved = !runId && stored?.snapshot && workSnapshot.parse(JSON.parse(stored.snapshot));
      const origin = stored?.origin && JSON.parse(stored.origin) as Origin;
      const branch = origin ? origin.branch : env.branchName;
      if (env.status !== "ready" || !env.path) {
        const runs = savedRuns(threadId, env.id);
        return { ...(saved ? available(saved, true) : unavailable("Рабочая папка или ветка чата больше недоступна, сохранённого diff нет.")), runs };
      }
      type Edit = Parameters<typeof host.call<"readSharedWorkDiff">>[1]["edits"][number];
      type Run = WorkRun & { startSeq: number; endSeq: number | null };
      const runs = new Map<string, Run>();
      const edits: (Edit & { seq: number; runId: string | null })[] = [];
      const seen = new Set<string>();
      let afterSeq: string | undefined;
      for (;;) {
        const events = await bb.sdk.threads.events.list({
          threadId, ...(afterSeq && { afterSeq }), limit: "100", order: "asc",
          types: ["turn/started", "turn/completed", "item/completed"], signal: lifetime.signal,
        });
        for (const event of events) {
          const id = event.scope.kind === "turn" ? event.scope.turnId : null;
          if (event.type === "turn/started" && id && !runs.has(id)) {
            runs.set(id, { id, startedAt: event.createdAt, endedAt: null, startSeq: event.seq, endSeq: null });
          }
          if (event.type === "turn/completed" && id) {
            const run = runs.get(id);
            if (run) {
              run.endedAt = event.createdAt;
              run.endSeq = event.seq;
            }
          }
          if (event.type !== "item/completed") continue;
          const { item, providerThreadId } = event.data;
          if (item.type !== "fileChange" || item.status !== "completed") continue;
          const key = JSON.stringify([providerThreadId, item.id]);
          if (seen.has(key)) continue;
          seen.add(key);
          for (const { path, kind, diff } of item.changes) {
            if (diff === undefined) continue;
            if (kind === "add" || kind === "delete" || (kind === "update" && diff)) {
              edits.push({ path, kind, diff, at: event.createdAt, seq: event.seq, runId: id });
            }
          }
        }
        const last = events.at(-1);
        if (!last || String(last.seq) === afterSeq) break;
        afterSeq = String(last.seq);
      }
      const ordered = [...runs.values()];
      const history = new Map(savedRuns(threadId, env.id).map((run) => [run.id, run]));
      for (const { id, startedAt, endedAt } of ordered) history.set(id, { id, startedAt, endedAt });
      const list = [...history.values()].sort((a, b) => a.startedAt - b.startedAt);
      const start = ordered[0];
      if (!start) {
        if (saved) return { ...available(saved, true), runs: list };
        if (!env.isGitRepo && !await host.call("sharedWorkOrigin", { path: env.path }, hostOptions(env))) {
          return { outcome: "not_applicable" as const };
        }
        return { ...unavailable("В журнале чата нет начала работы."), runs: list };
      }
      const readGit = (run?: Run) => host.call("readSharedWorkDiff", {
        path: env.path!, branch, threadId, startedAt: start.startedAt, base: origin ? origin.base : null,
        dirtyPaths: origin ? origin.dirtyPaths ?? null : null,
        ...(run && { run: { startedAt: run.startedAt, endedAt: run.endedAt } }),
        edits: edits.filter(({ seq, runId }) => seq > start.startSeq && (!run || seq < run.startSeq ||
          (runId === run.id && (run.endSeq === null || seq < run.endSeq)))).map(({ seq, path, kind, diff, at }) =>
          ({ path, kind, diff, at, ...(run && seq < run.startSeq && { beforeRun: true as const }) })),
      }, hostOptions(env));
      const captureRun = async (run: Run) => {
        const result = await readGit(run);
        if (!result || "reason" in result) return unavailable(result?.reason);
        if (run.endedAt !== null) runSave.run(threadId, env.id, run.id, run.startedAt, run.endedAt, JSON.stringify(result));
        return available(result, run.endedAt !== null);
      };
      if (runId) {
        const run = runs.get(runId);
        return run ? captureRun(run) : unavailable("Запуск отсутствует в журнале чата.");
      }
      if (checkpointRun) {
        const latest = ordered.at(-1);
        if (latest && latest.endedAt !== null && !savedRun(threadId, env.id, latest.id)) {
          await captureRun(latest).catch((error) => bb.log.warn(`Kanban could not checkpoint run ${latest.id}: ${String(error)}`));
        }
      }
      const result = await readGit();
      if (!result) return saved ? { ...available(saved, true), runs: list } : { outcome: "not_applicable" as const };
      if ("reason" in result) return { ...(saved ? available(saved, true) : unavailable(result.reason)), runs: list };
      sharedSave.run(threadId, env.id, JSON.stringify(result));
      return { ...available(result, true), runs: list };
    });
  }

  function capture(threadId: string, environmentId: string, projectId: string, expectedHead?: string,
    { runId, checkpointRun, revisionsOnly }: { runId?: string; checkpointRun?: boolean; revisionsOnly?: true } = {}): Promise<WorkDiffResult> {
    return serialize(environmentId, async () => {
      const stored = previous(environmentId);
      const range = storedRange(environmentId);
      const knownHead = range?.head ?? stored?.snapshot.head;
      const fallback = revisionsOnly && range ? { ...range, files: [] } : stored?.snapshot;
      if (stored || range) link.run(threadId, environmentId);
      const integration = expectedHead ? null : merged(environmentId, projectId);
      try {
        const env = await bb.sdk.environments.get({ environmentId, signal: lifetime.signal });
        if (env.projectId !== projectId) return unavailable();
        if (!isolated(env)) return await captureShared(threadId, env, runId, checkpointRun);
        if (runId) return unavailable("Для этого окружения доступен общий diff работы.");
        if (!env.isGitRepo) return { outcome: "not_applicable" as const };
        const checkout = env.status === "ready" ? env.path : null;
        const readGit = (root: string | null, merge?: NonNullable<typeof integration>) => host.call("readWorkDiff", {
          checkout: merge ? null : checkout, root, branch: merge?.candidate.branch ?? env.branchName!,
          createdAt: env.createdAt, base: range?.base ?? stored?.snapshot.base ?? null,
          head: expectedHead ?? merge?.head ?? null, mergedAt: merge?.mergedAt ?? null,
          ...(knownHead && { knownHead }), ...(revisionsOnly && { revisionsOnly }),
        }, { hostId: env.hostId, signal: lifetime.signal });
        let snapshot = checkout ? await readGit(null) : null;
        const fromCheckout = !!snapshot;
        if (!snapshot && integration && integration.head !== knownHead) {
          snapshot = await readGit(integration.target.root, integration);
        }
        const recoverRange = !revisionsOnly && range && stored?.snapshot.head !== range.head ? range : null;
        if (!snapshot && !expectedHead && (recoverRange || (!integration && !stored))) {
          const project = await bb.sdk.projects.get({ projectId, signal: lifetime.signal });
          const sources = project.sources.filter(({ hostId }) => hostId === env.hostId);
          for (const source of sources) {
            if (recoverRange) {
              const files = await host.call("readGitCommitPatch", {
                path: source.path, sha: recoverRange.head, parent: recoverRange.base, files: null,
              }, hostOptions(env)).catch((error) => {
                lifetime.signal.throwIfAborted();
                bb.log.warn(`Kanban could not recover committed range for ${threadId}: ${String(error)}`);
                return null;
              });
              if (files) snapshot = { ...recoverRange, files };
            } else {
              snapshot = await readGit(source.path);
            }
            if (snapshot) break;
          }
        }
        if (!snapshot) return fallback && !expectedHead ? available(fallback, true) : unavailable();
        link.run(threadId, environmentId);
        rangeSave.run(environmentId, snapshot.base, snapshot.head, snapshot.branch);
        if (!revisionsOnly) save.run(environmentId, JSON.stringify(snapshot), !fromCheckout && integration ? 1 : 0);
        return available(snapshot, !fromCheckout);
      } catch (error) {
        if (runId) return savedRun(threadId, environmentId, runId) ?? unavailable("Не удалось прочитать изменения этого запуска.");
        const runs = savedRuns(threadId, environmentId);
        const shared = readShared(threadId, environmentId)?.snapshot;
        if (shared) return { ...available(workSnapshot.parse(JSON.parse(shared)), true), runs };
        return fallback && !expectedHead ? available(fallback, true)
          : { ...unavailable(error instanceof Error ? error.message.trimEnd().split("\n").at(-1)?.slice(0, 400) : undefined), runs };
      }
    });
  }

  async function gitRepository(thread: Pick<Thread, "environmentId" | "projectId">, requested: string | null) {
    if (requested && thread.environmentId && requested !== thread.environmentId) return null;
    const environmentId = thread.environmentId ?? requested;
    if (!environmentId) return null;
    const env = await bb.sdk.environments.get({ environmentId, signal: lifetime.signal });
    if (env.projectId !== thread.projectId) return null;
    const project = env.status !== "ready" || !env.path
      ? await bb.sdk.projects.get({ projectId: env.projectId, signal: lifetime.signal }) : null;
    const path = (env.status === "ready" && env.path) || project?.sources.find(({ hostId }) => hostId === env.hostId)?.path;
    return path ? { env, path } : null;
  }

  async function recordGitHistory(thread: Pick<Thread, "id" | "environmentId" | "projectId">,
    result: WorkDiffResult, backfill = false) {
    const repo = await gitRepository(thread, null);
    if (!repo) return;
    const { env, path } = repo;
    const snapshot = result.outcome === "available" ? result.snapshot : null;
    if (isolated(env) && !snapshot) return;
    const shared = !isolated(env);
    const stored = readShared(thread.id, env.id);
    const origin = stored?.origin ? JSON.parse(stored.origin) as Origin : null;
    const runs = "runs" in result ? result.runs : undefined;
    const evidence = [];
    if (shared && runs?.length) {
      for (const [index, run] of runs.entries()) {
        let captured = savedRun(thread.id, env.id, run.id);
        if (!captured && backfill && run.endedAt !== null && runs.length > 1 && index < 8) {
          const recovered = await capture(thread.id, env.id, thread.projectId, undefined, { runId: run.id });
          if (recovered.outcome === "available") captured = recovered;
        }
        const files = captured?.snapshot.files ?? (runs.length === 1 ? snapshot?.files : undefined);
        if (files?.length) evidence.push({ startedAt: run.startedAt, before: runs[index + 1]?.startedAt ?? null, files });
      }
    }
    const found = await host.call("readGitHistory", {
      path, base: origin?.base ?? snapshot?.base ?? null, head: snapshot?.head ?? null,
      branch: origin?.branch ?? snapshot?.branch ?? env.branchName,
      ...(shared && { shared: { threadId: thread.id, dirtyPaths: origin?.dirtyPaths ?? null, evidence } }),
    }, hostOptions(env));
    db.transaction(() => {
      for (const commit of found) gitSave.run(thread.id, env.id, commit.sha, JSON.stringify(commit));
    })();
    return found;
  }

  function storedCommits(threadId: string, environmentId: string) {
    const rows = gitCommits.all(threadId, environmentId) as { commit_data: string }[];
    return rows.map(({ commit_data }) => workGitCommit.parse(JSON.parse(commit_data)))
      .sort((a, b) => b.committedAt - a.committedAt);
  }

  const lastGitEnvironment = (threadId: string) =>
    (gitLast.get(threadId) as { environment_id: string } | undefined)?.environment_id;

  function gitRange(range: WorktreeRange | undefined) {
    return range && range.base !== range.head ? { base: range.base, head: range.head } : undefined;
  }

  bb.rpc.register(workDiffRpc, {
    async workGitHistory({ threadId, environmentId }) {
      const thread = await bb.sdk.threads.get({ threadId, signal: lifetime.signal }).catch(() => null);
      if (!thread || thread.deletedAt || (environmentId && thread.environmentId && environmentId !== thread.environmentId)) {
        return { commits: [], message: "Рабочая папка этого чата недоступна." };
      }
      const id = thread.environmentId ?? environmentId ?? lastGitEnvironment(threadId);
      if (!id) return { commits: [], message: "У чата нет привязанной рабочей папки Git." };
      if (!thread.environmentId) {
        const commits = storedCommits(threadId, id);
        const range = commits.some(({ source }) => source === "branch") ? gitRange(storedRange(id) ?? previous(id)?.snapshot) : undefined;
        return { commits, ...(range && { range }) };
      }
      let failure: string | undefined;
      let range: ReturnType<typeof gitRange>;
      try {
        const result = await capture(threadId, id, thread.projectId, undefined, { revisionsOnly: true });
        if (result.outcome === "not_applicable") return { commits: [], message: "Окружение без Git." };
        if (result.outcome === "available" && !result.snapshot.shared) range = gitRange(result.snapshot);
        await recordGitHistory(thread, result, true);
        if (result.outcome === "unavailable") failure = result.message;
      } catch (error) {
        failure = error instanceof Error ? error.message.trimEnd().split("\n").at(-1) : undefined;
      }
      const commits = storedCommits(threadId, id);
      return { commits, ...(range && { range }),
        ...(!commits.length && !range && { message: failure ?? "Пока нет коммитов, связанных с этим чатом." }) };
    },
    async workGitPatch({ threadId, environmentId, sha }) {
      const thread = await bb.sdk.threads.get({ threadId, signal: lifetime.signal }).catch(() => null);
      const id = thread?.environmentId ?? environmentId ?? lastGitEnvironment(threadId);
      if (!thread || thread.deletedAt || !id || (environmentId && environmentId !== id)) {
        return { files: [], message: "Рабочая папка этого чата недоступна." };
      }
      if (!sha) {
        const repo = await gitRepository(thread, id);
        if (!repo || !isolated(repo.env)) return { files: [], message: "Для чата нет подтверждённого диапазона Git." };
        const result = await capture(threadId, id, thread.projectId, undefined, { revisionsOnly: true });
        const range = result.outcome === "available" ? gitRange(result.snapshot) : undefined;
        if (!range) return { files: [], message: "Для чата нет подтверждённого диапазона Git." };
        const files = await host.call("readGitCommitPatch", {
          path: repo.path, sha: range.head, parent: range.base, files: null,
        }, hostOptions(repo.env));
        return { files };
      }
      const row = gitCommit.get(threadId, id, sha) as { commit_data: string; patch: string | null } | undefined;
      if (!row) return { files: [], message: "Коммит не связан с этим чатом." };
      if (row.patch) return { files: workSnapshot.shape.files.parse(JSON.parse(row.patch)) };
      const repo = await gitRepository(thread, id);
      if (!repo) return { files: [], message: "Рабочая папка этого чата недоступна." };
      const { parent, files: scope } = workGitCommit.parse(JSON.parse(row.commit_data));
      const files = await host.call("readGitCommitPatch", {
        path: repo.path, sha, parent, files: scope,
      }, hostOptions(repo.env));
      gitSavePatch.run(JSON.stringify(files), threadId, id, sha);
      return { files };
    },
    async workDiff({ threadId, environmentId, runId }) {
      const thread = await bb.sdk.threads.get({ threadId, signal: lifetime.signal }).catch(() => null);
      if (!thread || thread.deletedAt) return unavailable();
      if (thread.environmentId) {
        if (environmentId && environmentId !== thread.environmentId) return unavailable();
        return capture(threadId, thread.environmentId, thread.projectId, undefined, { runId });
      }
      const row = lookup.get(threadId) as { environment_id: string } | undefined;
      const stored = row && (!environmentId || environmentId === row.environment_id) && previous(row.environment_id);
      if (stored && !runId) return available(stored.snapshot, true);
      const lastShared = (sharedLast.get(threadId) ?? lastRun.get(threadId)) as { environment_id: string } | undefined;
      const sharedId = environmentId ?? lastShared?.environment_id;
      if (runId) {
        return (sharedId ? savedRun(threadId, sharedId, runId) : undefined) ?? unavailable("Diff этого запуска не сохранён.");
      }
      const shared = sharedId ? readShared(threadId, sharedId)?.snapshot : null;
      const runs = sharedId ? savedRuns(threadId, sharedId) : [];
      return {
        ...(shared ? available(workSnapshot.parse(JSON.parse(shared)), true)
          : unavailable("У чата нет доступной рабочей папки и сохранённого общего diff.")),
        runs,
      };
    },
  });

  async function checkpoint(thread: { id: string; environmentId: string | null; projectId: string }) {
    if (!thread.environmentId) return;
    const result = await capture(thread.id, thread.environmentId, thread.projectId, undefined, { checkpointRun: true });
    if (result.outcome !== "not_applicable") {
      await recordGitHistory(thread, result).catch((error) => bb.log.warn(`Kanban could not record Git history for ${thread.id}: ${String(error)}`));
    }
    if (!lifetime.signal.aborted) bb.realtime.publish(workDiffChanged, { threadId: thread.id });
  }
  bb.events.on("thread.idle", ({ thread }) => checkpoint(thread));
  bb.events.on("thread.failed", ({ thread }) => checkpoint(thread));
  bb.events.on("thread.archived", ({ thread }) => checkpoint(thread));
  return { capture, checkpoint, recordGitHistory, freeze(environmentId: string, snapshot: WorkSnapshot) {
    try {
      freeze.run(environmentId, snapshot.head);
    } catch (error) {
      bb.log.warn(`Kanban could not finalize work diff for ${environmentId}: ${String(error)}`);
    }
  } };
}

export type WorkDiffs = ReturnType<typeof registerWorkDiffs>;
