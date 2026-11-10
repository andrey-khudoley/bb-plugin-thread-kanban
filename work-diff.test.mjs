import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "./dist/host.js";
import plugin from "./dist/server.js";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("keeps each run's net diff across commits, later main changes, reload and cleanup", async (t) => {
  const temp = await realpath(tmpdir());
  const folder = await mkdtemp(join(temp, "bb-kanban-diff-test-"));
  const root = join(folder, "repo");
  const host = experimental_createHostEntryHarness(hostEntry);
  t.after(async () => {
    await host.experimental_dispose();
    assert.equal(dirname(await realpath(folder)), temp);
    await rm(folder, { recursive: true, force: true });
  });
  await mkdir(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "kanban-test@example.test");
  git(root, "config", "user.name", "Kanban test");
  git(root, "config", "commit.gpgSign", "false");
  await writeFile(join(root, "alpha.txt"), "base\n");
  await writeFile(join(root, "beta.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "Base");
  const base = git(root, "rev-parse", "HEAD");
  const projectId = "proj_test";
  const hostId = "host_test";
  const environments = new Map();
  const threads = new Map();
  function run(name) {
    const path = join(folder, name);
    const createdAt = Date.now();
    git(root, "worktree", "add", "-b", name, path, "main");
    const environment = { id: `env_${name}`, path, createdAt, branchName: name, defaultBranch: "main",
      isGitRepo: true, isWorktree: true, projectId, hostId, status: "ready" };
    const thread = { id: `thr_${name}`, environmentId: environment.id, projectId };
    environments.set(environment.id, environment);
    threads.set(thread.id, thread);
    return { thread, environment, path };
  }
  const first = run("first");
  const second = run("second");
  const { bb, harness } = createFakePluginHost({
    sdk: {
      environments: { get: async ({ environmentId }) => environments.get(environmentId) },
      threads: {
        get: async ({ threadId }) => threads.get(threadId),
        events: { list: async () => [] },
      },
      projects: { get: async () => ({ sources: [{ hostId, path: root }] }) },
    },
    experimental_callHostRpc: ({ method, input }) => host.experimental_call(method, input),
  });
  await plugin(bb);
  t.after(() => harness.lifecycle.dispose());
  const query = (run, instance = harness) => instance.behavior.callRpc("workDiff", {
    threadId: run.thread.id, environmentId: run.thread.environmentId,
  });
  await writeFile(join(first.path, "alpha.txt"), "base\nfirst staged\n");
  git(first.path, "add", "alpha.txt");
  const index = git(first.path, "diff", "--cached");
  await writeFile(join(first.path, "alpha.txt"), "base\nfirst final\n");
  await writeFile(join(first.path, "beta.txt"), "base\nfirst beta\n");
  await writeFile(join(second.path, "other.txt"), "second run\n");

  const dirty = await query(first);
  assert.equal(dirty.snapshot.base, base);
  assert.deepEqual(dirty.snapshot.files.map(({ name }) => name), ["alpha.txt", "beta.txt"]);
  assert.match(dirty.snapshot.files[0].patch, /\+first final/);
  assert.doesNotMatch(dirty.snapshot.files[0].patch, /first staged/);
  assert.equal(git(first.path, "diff", "--cached"), index);
  assert.deepEqual((await query(second)).snapshot.files.map(({ name }) => name), ["other.txt"]);
  assert.equal((await harness.behavior.callRpc("workDiff", {
    threadId: first.thread.id, environmentId: second.environment.id,
  })).outcome, "unavailable");

  git(first.path, "add", "-A");
  git(first.path, "commit", "-m", "First changes");
  const committed = await query(first);
  assert.deepEqual(committed.snapshot.files, dirty.snapshot.files);
  await writeFile(join(first.path, "added file.txt"), "added after commit\n");
  const mixed = await query(first);
  assert.deepEqual(mixed.snapshot.files.map(({ name }) => name), ["added file.txt", "alpha.txt", "beta.txt"]);
  git(first.path, "add", "-A");
  git(first.path, "commit", "-m", "Finish first changes");
  const head = git(first.path, "rev-parse", "HEAD");
  git(root, "merge", "--no-ff", "first", "-m", "Merge first work");
  const mergedAt = git(root, "rev-parse", "HEAD");
  // Legacy installations have a merge result and the Git creation record.
  const db = bb.storage.database();
  db.prepare("DELETE FROM kanban_work_diffs WHERE environment_id=?").run(first.environment.id);
  db.prepare("DELETE FROM kanban_worktree_ranges WHERE environment_id=?").run(first.environment.id);
  db.prepare("INSERT INTO kanban_merge_jobs (id, created_at, payload) VALUES (?, ?, ?)").run("legacy", Date.now(), JSON.stringify({
    order: [{ target: { root, hostId, projectId }, candidate: { id: first.environment.id, branch: "first" }, head }],
    view: { results: [{ head: mergedAt }] },
  }));
  const restored = await query(first);
  assert.equal(restored.saved, false);
  assert.equal(restored.snapshot.head, head);
  assert.deepEqual(restored.snapshot.files, mixed.snapshot.files);
  const input = {
    threadId: first.thread.id, environmentId: first.thread.environmentId,
  };
  const worktreeHistory = await harness.behavior.callRpc("workGitHistory", input);
  assert.deepEqual(worktreeHistory.commits.map(({ subject }) => subject), ["Finish first changes", "First changes"]);
  assert.deepEqual(worktreeHistory.range, { base, head });
  // A previously merged worktree can receive more work. An old frozen row
  // must not hide the new head, even when Git history is the first view opened.
  db.prepare("UPDATE kanban_work_diffs SET frozen=1 WHERE environment_id=?").run(first.environment.id);
  await writeFile(join(first.path, "continued.txt"), "new work after merge\n");
  git(first.path, "add", "continued.txt");
  git(first.path, "commit", "-m", "Continue the worktree");
  const latest = git(first.path, "rev-parse", "HEAD");
  await writeFile(join(first.path, "beta.txt"), "uncommitted after the new head\n");
  const continued = await harness.behavior.callRpc("workGitHistory", input);
  assert.deepEqual(continued.range, { base, head: latest });
  assert.deepEqual(continued.commits.map(({ sha }) => sha), [latest, ...worktreeHistory.commits.map(({ sha }) => sha)]);
  const total = await harness.behavior.callRpc("workGitPatch", { ...input, sha: null });
  assert.deepEqual(total.files.map(({ name }) => name), ["added file.txt", "alpha.txt", "beta.txt", "continued.txt"]);
  assert.match(total.files.find(({ name }) => name === "beta.txt").patch, /\+first beta/);
  assert.doesNotMatch(total.files.find(({ name }) => name === "beta.txt").patch, /uncommitted/);
  assert.deepEqual((await harness.behavior.callRpc("workGitPatch", { ...input, sha: latest })).files.map(({ name }) => name),
    ["continued.txt"]);
  git(first.path, "restore", "--", "beta.txt");

  await writeFile(join(root, "unrelated.txt"), "later main commit\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "Unrelated main commit");
  git(root, "merge", "--no-ff", "first", "-m", "Merge continued work");
  git(root, "worktree", "remove", first.path);
  git(root, "branch", "-d", "first");
  first.environment.status = "destroyed";
  const { harness: reloaded } = await harness.lifecycle.reload(plugin);
  t.after(() => reloaded.lifecycle.dispose());
  assert.deepEqual(await reloaded.behavior.callRpc("workGitHistory", input), continued);
  assert.deepEqual(await reloaded.behavior.callRpc("workGitPatch", { ...input, sha: null }), total);
  const saved = { ...restored, saved: true, snapshot: { ...restored.snapshot, head: latest, files: total.files } };
  assert.deepEqual(await query(first, reloaded), saved);
  first.thread.environmentId = null;
  assert.deepEqual(await query(first, reloaded), saved);

  const old = run("old");
  old.environment.isWorktree = false;
  const unavailable = await query(old, reloaded);
  assert.equal(unavailable.outcome, "unavailable");
  assert.match(unavailable.message, /В журнале чата нет начала работы/);
});

test("replays only the shared checkout's attributable edits and commits", async (t) => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, "bb-kanban-shared-test-"));
  const host = experimental_createHostEntryHarness(hostEntry);
  t.after(async () => {
    await host.experimental_dispose();
    assert.equal(dirname(await realpath(root)), temp);
    await rm(root, { recursive: true, force: true });
  });
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "kanban-test@example.test");
  git(root, "config", "user.name", "Kanban test");
  git(root, "config", "commit.gpgSign", "false");
  for (const name of ["existing.txt", "edited.txt", "removed.txt"]) await writeFile(join(root, name), "base\n");
  await writeFile(join(root, "committed.txt"), "top\ncommon\nbase\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "Base");
  await writeFile(join(root, "existing.txt"), "dirty before launch\n");
  git(root, "add", "existing.txt");
  const origin = await host.experimental_call("sharedWorkOrigin", { path: root });
  assert.deepEqual(origin.dirtyPaths, ["existing.txt"]);
  const startedAt = Date.now();
  await writeFile(join(root, "foreign.txt"), "foreign\n");
  await writeFile(join(root, "committed.txt"), "foreign top\ncommon\nbase\n");
  git(root, "add", "foreign.txt", "committed.txt");
  git(root, "commit", "-m", "Foreign commit", "--", "foreign.txt", "committed.txt");
  await writeFile(join(root, "committed.txt"), "foreign top\ncommon\nbase\ncommitted by the chat\n");
  git(root, "add", "committed.txt");
  execFileSync("git", ["commit", "-m", "Chat commit"], {
    cwd: root, env: { ...process.env, GIT_REFLOG_ACTION: "bb-kanban:thr_test" }, stdio: "pipe",
  });
  const head = git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "edited.txt"), "uncommitted edit by the chat\n");
  await writeFile(join(root, "other.txt"), "parallel working edit\n");
  const input = {
    path: root, ...origin, threadId: "thr_test", startedAt,
    edits: [
      { path: join(root, "edited.txt"), kind: "update", at: Date.now(),
        diff: "@@ -1 +1 @@\n-base\n+uncommitted edit by the chat\n" },
      { path: join(root, "new file.txt"), kind: "add", at: Date.now(), diff: "new content\n" },
      { path: join(root, "empty.txt"), kind: "add", at: Date.now(), diff: "" },
      { path: join(root, "removed.txt"), kind: "delete", at: Date.now(), diff: "base\n" },
    ],
  };
  const snapshot = await host.experimental_call("readSharedWorkDiff", input);
  assert.equal(snapshot.head, head);
  assert.deepEqual(snapshot.files.map(({ name }) => name), ["committed.txt", "edited.txt", "empty.txt", "new file.txt", "removed.txt"]);
  assert.match(snapshot.files[0].patch, /\+committed by the chat/);
  assert.doesNotMatch(snapshot.files[0].patch, /foreign top/);
  const noEvidence = await host.experimental_call("readSharedWorkDiff", { ...input, threadId: "thr_other", edits: [] });
  assert.match(noEvidence.reason, /нет сохранённых патчей/);
  const commits = await host.experimental_call("readGitHistory", {
    path: root, branch: origin.branch, base: origin.base, head: null,
    shared: { threadId: "thr_test", dirtyPaths: origin.dirtyPaths, evidence: [] },
  });
  assert.deepEqual(commits.map(({ sha, files, fileCount }) => ({ sha, files, fileCount })),
    [{ sha: head, files: ["committed.txt"], fileCount: 2 }]);
  const review = await host.experimental_call("reviewSharedCheckout", {
    path: root, title: "Chat review", expectedHead: head, expectedBranch: "main",
    threadId: "thr_test", snapshot,
  });
  assert.equal(review.outcome, "blocked");
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal(git(root, "diff", "--cached"), "");
});

test("ignores chat artifacts and maps edits only from registered repository worktrees", async (t) => {
  const temp = await realpath(tmpdir());
  const folder = await mkdtemp(join(temp, "bb-kanban-edit-path-test-"));
  const root = join(folder, "repo");
  const linked = join(folder, "linked worktree");
  const nested = join(root, "nested-worktree");
  const other = join(folder, "other-repo");
  const host = experimental_createHostEntryHarness(hostEntry);
  t.after(async () => {
    await host.experimental_dispose();
    assert.equal(dirname(await realpath(folder)), temp);
    await rm(folder, { recursive: true, force: true });
  });
  await mkdir(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "kanban-test@example.test");
  git(root, "config", "user.name", "Kanban test");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "commit.gpgSign", "false");
  for (const name of ["direct.txt", "linked.txt", "nested.txt"]) await writeFile(join(root, name), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "Base");
  const origin = await host.experimental_call("sharedWorkOrigin", { path: root });
  git(root, "worktree", "add", "--detach", linked, "HEAD");
  git(root, "worktree", "add", "--detach", nested, "HEAD");
  await mkdir(other);
  git(other, "init", "-b", "main");
  await writeFile(join(root, "staged.txt"), "unrelated staged data\n");
  git(root, "add", "staged.txt");
  await writeFile(join(root, "staged.txt"), "unrelated working data\n");
  const index = await readFile(join(root, ".git", "index"));
  const status = git(root, "status", "--porcelain=v1", "-uall");
  const startedAt = Date.now() + 2000;
  const update = (path, value) => ({ path, kind: "update", at: startedAt + 1000,
    diff: `@@ -1 +1 @@\n-base\n+${value}\n` });
  const artifacts = [
    { path: join(folder, "report.md"), kind: "add", diff: "report\n", at: startedAt },
    update(join(other, "direct.txt"), "unrelated repository"),
    update(join(root + "-similar-prefix", "direct.txt"), "unrelated directory"),
  ];
  const input = { path: root, ...origin, threadId: "thr_paths", startedAt, edits: [
    ...artifacts,
    update("direct.txt", "relative repository edit"),
    update(join(linked, "linked.txt"), "linked worktree edit"),
    update(join(nested, "nested.txt"), "nested worktree edit"),
  ] };
  const snapshot = await host.experimental_call("readSharedWorkDiff", input);
  assert.deepEqual(snapshot.files.map(({ name }) => name), ["direct.txt", "linked.txt", "nested.txt"]);
  assert.match(snapshot.files[0].patch, /\+relative repository edit/);
  assert.match(snapshot.files[1].patch, /\+linked worktree edit/);
  assert.match(snapshot.files[2].patch, /\+nested worktree edit/);
  assert.deepEqual(await readFile(join(root, ".git", "index")), index);
  assert.equal(git(root, "status", "--porcelain=v1", "-uall"), status);
  assert.equal(git(root, "rev-parse", "HEAD"), origin.base);
  const onlyArtifacts = await host.experimental_call("readSharedWorkDiff", { ...input, edits: artifacts });
  assert.match(onlyArtifacts.reason, /нет сохранённых патчей/);
});

test("scopes shared review commits and preserves ambiguous changes and the user's index", async (t) => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, "bb-kanban-scoped-review-test-"));
  const host = experimental_createHostEntryHarness(hostEntry);
  t.after(async () => {
    await host.experimental_dispose();
    assert.equal(dirname(await realpath(root)), temp);
    await rm(root, { recursive: true, force: true });
  });
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "kanban-test@example.test");
  git(root, "config", "user.name", "Kanban test");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "commit.gpgSign", "false");
  const put = (name, contents) => writeFile(join(root, name), contents);
  const initial = "one\nkeep\nkeep\nkeep\nkeep\nkeep\nkeep\nkeep\nkeep\nlast\n";
  await put("task.txt", initial);
  await put("staged.txt", "base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "Base");
  const base = git(root, "rev-parse", "HEAD");
  const request = { path: root, title: "Проверка карточки", expectedHead: base, expectedBranch: "main", threadId: "thr_task", snapshot: null };
  const review = (changes = {}) => host.experimental_call("reviewSharedCheckout", { ...request, ...changes });
  assert.deepEqual(await review(), { outcome: "ready", commit: null });

  const task = initial.replace("one", "task");
  await put("task.txt", task);
  const snapshot = { base, head: base, branch: "main", shared: true,
    files: [{ name: "task.txt", patch: git(root, "diff", "--", "task.txt") + "\n" }] };
  const onlyTask = await review({ snapshot });
  assert.equal(onlyTask.outcome, "ready");
  assert.equal(git(root, "show", "--format=", "--name-only", "HEAD"), "task.txt");
  assert.equal(git(root, "status", "--porcelain"), "");

  git(root, "reset", "--hard", base);
  await put("task.txt", task);
  await put("staged.txt", "foreign staged\n");
  git(root, "add", "staged.txt");
  await put("staged.txt", "foreign worktree\n");
  await put("untracked.txt", "foreign untracked\n");
  const index = join(root, ".git", "index");
  const before = await readFile(index);
  const unknown = await review();
  assert.equal(unknown.outcome, "blocked");
  assert.deepEqual(await readFile(index), before);
  const separated = await review({ snapshot });
  assert.equal(separated.outcome, "ready");
  assert.match(git(root, "reflog", "-1", "--format=%gs"), /^bb-kanban:thr_task: /);
  assert.equal(git(root, "show", "--format=", "--name-only", "HEAD"), "task.txt");
  assert.equal(git(root, "show", ":staged.txt"), "foreign staged");
  assert.equal(git(root, "status", "--porcelain"), "MM staged.txt\n?? untracked.txt");
  assert.deepEqual(await review({ snapshot, expectedHead: separated.commit.head }), { outcome: "ready", commit: null });

  git(root, "reset", "--hard", base);
  await put("task.txt", task.replace("last", "other task"));
  const mixed = await review({ snapshot });
  assert.equal(mixed.outcome, "blocked");
  assert.deepEqual(mixed.paths, ["task.txt"]);
  const beforeMixed = await readFile(index);
  await put("untracked.txt", "changed concurrently\n");
  const selection = { task: ["task.txt"], foreign: ["untracked.txt"], patch: snapshot.files[0].patch };
  assert.equal((await review({ snapshot, resolution: { ...selection, revision: mixed.revision } })).outcome, "blocked");
  assert.deepEqual(await readFile(index), beforeMixed);
  assert.equal(git(root, "rev-parse", "HEAD"), base);
  const fresh = await review({ snapshot });
  const resolved = await review({ snapshot, resolution: { ...selection, revision: fresh.revision } });
  assert.equal(resolved.outcome, "ready");
  assert.equal(git(root, "show", "HEAD:task.txt"), task.trim());
  assert.equal(await readFile(join(root, "task.txt"), "utf8"), task.replace("last", "other task"));
  assert.equal(git(root, "diff", "--cached"), "");
  assert.match(git(root, "diff", "--", "task.txt"), /\+other task/);
});

test("keeps a completed run after a follow-up reverses its changes", async (t) => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, "bb-kanban-run-history-test-"));
  const host = experimental_createHostEntryHarness(hostEntry);
  t.after(async () => {
    await host.experimental_dispose();
    assert.equal(dirname(await realpath(root)), temp);
    await rm(root, { recursive: true, force: true });
  });
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "kanban-test@example.test");
  git(root, "config", "user.name", "Kanban test");
  git(root, "config", "commit.gpgSign", "false");
  const path = join(root, "task.txt");
  await writeFile(path, "base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "Base");
  const start = Math.floor(Date.now() / 1000) * 1000 + 2000;
  const thread = { id: "thr_run", environmentId: "env_run", projectId: "proj_run" };
  const environment = { id: thread.environmentId, path: root, branchName: "main", defaultBranch: "main",
    isGitRepo: true, isWorktree: false, projectId: thread.projectId, hostId: "host_test", status: "ready" };
  const events = [];
  function record(turnId, type, item) {
    const seq = events.length + 1;
    events.push({ seq, type, createdAt: start + seq * 1000, scope: { kind: "turn", turnId },
      data: { providerThreadId: "test", item } });
  }
  function run(id, from, to) {
    record(id, "turn/started");
    record(id, "item/completed", { id, type: "fileChange", status: "completed",
      changes: [{ path, kind: "update", diff: `@@ -1 +1 @@\n-${from}\n+${to}\n` }] });
    record(id, "turn/completed");
  }
  const { bb, harness } = createFakePluginHost({
    sdk: {
      environments: { get: async () => environment },
      threads: { get: async () => thread, events: { list: async ({ afterSeq, limit, types }) =>
        events.filter(({ seq, type }) => seq > Number(afterSeq ?? 0) && types.includes(type)).slice(0, Number(limit)) } },
    },
    experimental_callHostRpc: ({ method, input }) => host.experimental_call(method, input),
  });
  await plugin(bb);
  t.after(() => harness.lifecycle.dispose());
  const input = { threadId: thread.id, environmentId: environment.id };
  run("first", "base", "first result");
  await harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
  await writeFile(path, "first result\n");
  await writeFile(join(root, "foreign.txt"), "other task\n");
  git(root, "add", ".");
  const committedAt = new Date(start + 3500).toISOString();
  execFileSync("git", ["commit", "-m", "Mixed real commit"], {
    cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: committedAt, GIT_COMMITTER_DATE: committedAt }, stdio: "pipe",
  });
  const sha = git(root, "rev-parse", "HEAD");
  run("second", "first result", "base");
  const aggregate = await harness.behavior.callRpc("workDiff", input);
  assert.deepEqual(aggregate.runs.map(({ id }) => id), ["first", "second"]);
  assert.deepEqual(aggregate.snapshot.files, []);
  const first = await harness.behavior.callRpc("workDiff", { ...input, runId: "first" });
  const second = await harness.behavior.callRpc("workDiff", { ...input, runId: "second" });
  assert.match(first.snapshot.files[0].patch, /-base\n\+first result/);
  assert.match(second.snapshot.files[0].patch, /-first result\n\+base/);
  assert.equal((await harness.behavior.callRpc("workDiff", { ...input, runId: "missing" })).outcome, "unavailable");
  const gitHistory = await harness.behavior.callRpc("workGitHistory", input);
  assert.deepEqual(gitHistory.commits.map(({ sha, files, fileCount, source }) => ({ sha, files, fileCount, source })),
    [{ sha, files: ["task.txt"], fileCount: 2, source: "matched" }]);
  const gitPatch = await harness.behavior.callRpc("workGitPatch", { ...input, sha });
  assert.equal(gitPatch.files[0].patch.trimEnd(), git(root, "show", "--format=", sha, "--", "task.txt"));

  const { harness: reloaded } = await harness.lifecycle.reload(plugin);
  t.after(() => reloaded.lifecycle.dispose());
  events.length = 0;
  thread.environmentId = null;
  const detached = { ...input, environmentId: null };
  assert.deepEqual(await reloaded.behavior.callRpc("workDiff", { ...detached, runId: "first" }), first);
  assert.deepEqual(await reloaded.behavior.callRpc("workDiff", { ...detached, runId: "second" }), second);
  assert.deepEqual((await reloaded.behavior.callRpc("workDiff", detached)).runs, aggregate.runs);
  assert.deepEqual(await reloaded.behavior.callRpc("workGitHistory", detached), gitHistory);
  assert.deepEqual(await reloaded.behavior.callRpc("workGitPatch", { ...detached, sha }), gitPatch);
});
