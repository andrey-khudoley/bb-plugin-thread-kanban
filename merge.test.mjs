import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "./dist/host.js";
import plugin from "./dist/server.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("merges clean worktrees and replays a conflict resolution against the original stages", async () => {
  const temp = await realpath(tmpdir());
  const folder = await mkdtemp(join(temp, "bb-kanban-merge-test-"));
  const root = join(folder, "repo");
  const host = experimental_createHostEntryHarness(hostEntry);
  try {
    await mkdir(root);
    git(root, "init", "-b", "main");
    git(root, "config", "user.email", "kanban-test@example.test");
    git(root, "config", "user.name", "Kanban test");
    await writeFile(join(root, "shared.txt"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "Base");
    function addWorktree(name) {
      const path = join(folder, name);
      git(root, "worktree", "add", "-b", name, path, "main");
      return { id: name, path, branch: name };
    }
    async function task(name, file, content = name) {
      const candidate = addWorktree(name);
      const { path } = candidate;
      await writeFile(join(path, file), content + "\n");
      git(path, "add", ".");
      git(path, "commit", "-m", name);
      return { ...candidate, head: git(path, "rev-parse", "HEAD") };
    }
    const fresh = addWorktree("fresh");
    const alpha = await task("alpha", "alpha.txt");
    const beta = await task("beta", "beta.txt");
    const preview = await host.experimental_call("inspectWorktrees", { root, candidates: [fresh, alpha, beta], includeFiles: true });
    assert.deepEqual(preview.candidates.map(({ state, files }) => [state, files]), [
      ["empty", []], ["pending", ["alpha.txt"]], ["pending", ["beta.txt"]],
    ]);
    await writeFile(join(root, "dirty.txt"), "untracked");
    await assert.rejects(host.experimental_call("mergeWorktrees", { root, base: preview.base, candidates: [alpha, beta] }), /незакоммиченные/);
    await rm(join(root, "dirty.txt"));
    assert.deepEqual(await host.experimental_call("previewMergeConflicts", {
      root, base: preview.base, candidates: [alpha, beta],
    }), { outcome: "previewed" });
    assert.equal(git(root, "rev-parse", "HEAD"), preview.base);
    const merged = await host.experimental_call("mergeWorktrees", { root, base: preview.base, candidates: [alpha, beta] });
    assert.equal(merged.head, git(root, "rev-parse", "HEAD"));
    assert.match(await readFile(join(root, "beta.txt"), "utf8"), /^beta/);
    assert.equal(git(root, "status", "--porcelain"), "");
    const after = await host.experimental_call("inspectWorktrees", { root, candidates: [fresh, alpha, beta], includeFiles: false });
    assert.deepEqual(after.candidates.map(({ state }) => state), ["empty", "merged", "merged"]);
    await assert.rejects(host.experimental_call("mergeWorktrees", { root, base: preview.base, candidates: [alpha] }), /main изменилась/);

    const left = await task("left", "shared.txt");
    const right = await task("right", "shared.txt");
    const conflicted = await host.experimental_call("mergeWorktrees", {
      root, base: merged.head, candidates: [left, right],
    });
    assert.equal(conflicted.outcome, "conflict");
    const [conflict] = conflicted.conflicts;
    assert.equal(conflict.path, "shared.txt");
    assert.match(conflict.current.text, /^left/);
    assert.match(conflict.incoming.text, /^right/);
    assert.equal(git(root, "rev-parse", "HEAD"), merged.head);
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.equal(git(root, "worktree", "list", "--porcelain").split(/\n/).filter((line) => line.startsWith("worktree ")).length, 6);
    assert.match(await readFile(join(right.path, "shared.txt"), "utf8"), /^right/);
    const resolution = { [conflict.id]: { kind: "text", text: "left\nright\n" } };
    const final = await host.experimental_call("mergeWorktrees", {
      root, base: merged.head, candidates: [left, right], resolutions: resolution,
    });
    assert.equal(final.outcome, "merged");
    assert.equal(git(root, "rev-parse", "HEAD"), final.head);
    assert.equal((await readFile(join(root, "shared.txt"), "utf8")).replace(/\r\n/g, "\n"), "left\nright\n");
    assert.equal(git(root, "status", "--porcelain"), "");
  } finally {
    await host.experimental_dispose();
    assert.equal(dirname(await realpath(folder)), temp);
    await rm(folder, { recursive: true, force: true });
  }
});

test("plans ready and explicitly selected worktrees through the agent and preserves its validated order", async () => {
  const projectId = "proj_test";
  const threads = ["parent", "child", "other"].map((name) => ({
    id: `thr_${name}`, title: name, projectId, environmentId: `env_${name}`, environmentIsWorktree: true,
    status: "idle", visibility: "visible", parentThreadId: name === "child" ? "thr_parent" : null,
  }));
  const applied = [];
  const inputs = [];
  const { bb, harness } = createFakePluginHost({
    sdk: {
      projects: { get: async () => ({ name: "Test", sources: [{ hostId: "host_test", path: "/repo", isDefault: true }] }) },
      environments: { list: async () => [], get: async ({ environmentId: id }) => ({
        id, isWorktree: true, isGitRepo: true, branchName: id, path: "/" + id, status: "ready", projectId, hostId: "host_test",
      }) },
      threads: {
        list: async ({ archived, threadIds }) => archived ? [] : threads.filter(({ id }) => !threadIds || threadIds.includes(id)),
        get: async ({ threadId }) => threads.find(({ id }) => id === threadId),
        getPluginMetadata: async () => ({}),
        spawn: async ({ prompt }) => { inputs.push(JSON.parse(prompt.split("\n").at(-1))); return { id: "thr_planner" }; },
        wait: async () => {},
        output: async () => ({ output: JSON.stringify({ order: ["env_parent", "env_child"], reason: "Сначала родительская ветка." }) }),
        stop: async () => {},
        archive: async () => {},
      },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      if (method === "inspectWorktrees") return { base: "a".repeat(40), candidates: input.candidates.map(({ id, branch }) => ({
        id, branch, state: "pending", head: "b".repeat(40), files: ["shared.ts"], message: "",
      })) };
      applied.push(input.candidates.map(({ id }) => id));
      return { outcome: "merged", head: "c".repeat(40) };
    },
  });
  try {
    await plugin(bb);
    const call = (method, input) => harness.behavior.callRpc(method, input);
    const parent = await call("issueCreate", { projectId, status: "done", threadId: "thr_parent", test: true });
    const child = await call("issueCreate", { projectId, status: "done", threadId: "thr_child", parentId: parent.id, test: true });
    await call("issueCreate", { projectId, status: "todo", threadId: "thr_other", test: true });
    await call("issueSave", { id: child.id, version: child.version, fields: { ...child, blockedBy: [parent.id] } });
    await call("issueMove", { id: child.id, status: "review" });
    async function waitFor(id) {
      for (let i = 0; i < 80; i++) {
        const plan = await call("mergeStatus", { id });
        if (!["planning", "merging"].includes(plan.state)) return plan;
        await setTimeout(5);
      }
      assert.fail("Merge job did not finish");
    }
    const ready = await call("planMerge", { mode: "all", projectId });
    assert.equal((await call("planMerge", { mode: "all", projectId })).id, ready.id);
    const plan = await waitFor(ready.id);
    assert.equal(plan.state, "ready", plan.message);
    assert.deepEqual(plan.branches.map(({ id }) => id), ["env_parent", "env_child"]);
    assert.deepEqual(inputs[0].find(({ id }) => id === "env_child").before, ["env_parent"]);
    assert.deepEqual(inputs[0].find(({ id }) => id === "env_child").ancestors, ["env_parent"]);
    assert.equal(applied.length, 0);
    await call("applyMerge", { id: ready.id });
    assert.equal((await waitFor(ready.id)).state, "done");
    assert.deepEqual(applied, [["env_parent", "env_child"]]);

    const selected = await call("planMerge", { mode: "selected", issueIds: [child.id], threadIds: ["thr_parent"] });
    assert.deepEqual((await waitFor(selected.id)).branches.map(({ id }) => id), ["env_parent", "env_child"]);
    const childOnly = await call("planMerge", { mode: "single", threadId: "thr_child" });
    const blocked = await waitFor(childOnly.id);
    assert.equal(blocked.branches.length, 0);
    assert.match(blocked.skipped[0].message, /блокирующую/);
    assert.equal((await call("planMerge", { mode: "single", threadId: "thr_child" })).id, childOnly.id);
    await waitFor(childOnly.id);
    await call("dismissMerge", { id: childOnly.id });
    assert.ok(!(await call("mergeHistory", null)).some(({ id }) => id === childOnly.id));
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("waits for a busy checkout and resumes commit and merge in the same plan", async () => {
  const temp = await realpath(tmpdir());
  const folder = await mkdtemp(join(temp, "bb-kanban-flow-test-"));
  const root = join(folder, "main");
  const worktree = join(folder, "task");
  const gitHost = experimental_createHostEntryHarness(hostEntry);
  const projectId = "proj_test";
  const thread = { id: "thr_task", title: "Исправить переход", projectId, environmentId: "env_task",
    environmentIsWorktree: true, status: "idle", visibility: "visible" };
  const committed = [];
  let mainStatus = "active";
  let applied = 0;
  const { bb, harness } = createFakePluginHost({
    sdk: {
      projects: { get: async () => ({ name: "Test", sources: [{ hostId: "host_test", path: root }] }) },
      environments: {
        get: async ({ environmentId }) => ({
          id: environmentId, isWorktree: environmentId === "env_task", isGitRepo: true,
          branchName: environmentId === "env_main" ? "main" : "task", path: environmentId === "env_main" ? root : worktree,
          status: "ready", projectId, hostId: "host_test",
        }),
        list: async () => [{ id: "env_main", branchName: "main", isWorktree: false }],
      },
      threads: {
        list: async ({ archived, environmentId }) => archived ? []
          : environmentId === "env_main" ? [{ id: "thr_main", title: "Главный чат", status: mainStatus }] : [thread],
        get: async () => thread,
        getPluginMetadata: async () => ({}),
      },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      if (method === "mergeWorktrees") applied++;
      const result = await gitHost.experimental_call(method, input);
      if (method === "commitCheckout" && result) committed.push(input.path === root ? "env_main" : "env_task");
      return result;
    },
  });
  try {
    await mkdir(root);
    git(root, "init", "-b", "main");
    git(root, "config", "user.email", "kanban-test@example.test");
    git(root, "config", "user.name", "Kanban test");
    git(root, "commit", "--allow-empty", "-m", "Base");
    git(root, "worktree", "add", "-b", "task", worktree, "main");
    await writeFile(join(root, "main.txt"), "Main\n");
    await writeFile(join(worktree, "task.txt"), "Task\n");
    await plugin(bb);
    const call = (method, input) => harness.behavior.callRpc(method, input);
    async function waitFor(id) {
      for (let i = 0; i < 240; i++) {
        const plan = await call("mergeStatus", { id });
        if (plan.state !== "planning" && plan.state !== "merging") return plan;
        await setTimeout(50);
      }
      assert.fail("Plan did not finish");
    }
    const { id } = await call("planMerge", { mode: "single", threadId: thread.id });
    const initial = await waitFor(id);
    assert.equal(initial.state, "blocked", initial.message);
    assert.equal(initial.title, thread.title);
    assert.deepEqual(initial.preparations.map(({ kind }) => kind), ["worktree", "main"]);
    await call("commitMergeChanges", { id, preparationId: "env_task" });
    const prepared = await waitFor(id);
    assert.equal(prepared.state, "blocked");
    assert.deepEqual(committed, ["env_task"]);
    assert.deepEqual(prepared.preparations.map(({ kind }) => kind), ["main"]);
    assert.deepEqual(prepared.preparations[0].waitingFor, [{ id: "thr_main", title: "Главный чат", reason: "working" }]);
    assert.deepEqual((await call("mergeHistory", null))[0].preparations[0].waitingFor, prepared.preparations[0].waitingFor);
    await call("commitMergeChanges", { id, preparationId: "env_main" });
    assert.equal((await waitFor(id)).state, "blocked");
    assert.deepEqual(committed, ["env_task"]);
    mainStatus = "pending";
    assert.deepEqual((await call("mergeStatus", { id })).preparations[0].waitingFor, []);
    assert.deepEqual((await call("mergeHistory", null))[0].preparations[0].waitingFor, []);
    await call("commitMergeChanges", { id, preparationId: "env_main" });
    const ready = await waitFor(id);
    assert.equal(ready.state, "ready", ready.message);
    assert.equal(ready.branches.length, 1);
    assert.deepEqual(ready.commits.map(({ branch }) => branch), ["task", "main"]);
    assert.deepEqual(committed, ["env_task", "env_main"]);
    mainStatus = "active";
    await call("applyMerge", { id });
    assert.equal((await waitFor(id)).state, "ready");
    assert.equal(applied, 0);
    mainStatus = "idle";
    assert.deepEqual((await call("mergeStatus", { id })).waitingFor, []);
    await call("applyMerge", { id });
    const result = await waitFor(id);
    assert.equal(result.state, "done", result.message);
    assert.equal(applied, 1);
    assert.equal(result.results[0].head, git(root, "rev-parse", "HEAD"));
    assert.match(await readFile(join(root, "task.txt"), "utf8"), /^Task/);
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.equal((await call("mergeHistory", null)).length, 1);
    assert.match(git(root, "log", "-1", "--format=%B"), /^merge: .+[\s\S]+- Добавить task\.txt/);

    const issue = await call("issueCreate", { projectId, status: "done", threadId: thread.id, test: true });
    await call("issueMove", { id: issue.id, status: "review" });
    await writeFile(join(worktree, "task.txt"), "Updated\n");
    await writeFile(join(worktree, "notes.txt"), "Notes\n");
    const expectedHead = git(worktree, "rev-parse", "HEAD");
    const request = { id: issue.id, threadId: thread.id, environmentId: "env_task", expectedBranch: "task", expectedHead };
    await assert.rejects(call("issueReview", { ...request, expectedHead: "a".repeat(40) }), /Коммит ветки изменился/);
    assert.equal((await call("issueList", null))[0].status, "review");
    assert.equal(git(worktree, "rev-parse", "HEAD"), expectedHead);
    const review = await call("issueReview", request);
    assert.equal(review.issue.status, "done");
    assert.equal(review.commit.head, git(worktree, "rev-parse", "HEAD"));
    assert.match(git(worktree, "log", "-1", "--format=%B"), /^fix: Исправить переход\r?\n\r?\n- Добавить notes\.txt\r?\n- Обновить task\.txt$/);
    assert.equal(git(worktree, "status", "--porcelain"), "");
  } finally {
    await harness.lifecycle.dispose();
    await gitHost.experimental_dispose();
    assert.equal(dirname(await realpath(folder)), temp);
    await rm(folder, { recursive: true, force: true });
  }
});

test("keeps valid decisions, fills missing explanations in a legacy plan and resumes with the same choices", async () => {
  const thread = { id: "thr_merge", title: "Merge", projectId: "proj_test", environmentId: "env_merge",
    environmentIsWorktree: true, status: "idle", visibility: "visible" };
  const side = (text) => ({ exists: true, mode: "100644", text });
  const conflicts = ["automatic", "choice"].map((name, index) => ({
    id: String(index + 1).repeat(64), path: name + ".txt", branch: "task", text: true,
    base: side("base\n"), current: side("current\n"), incoming: side("incoming\n"),
  }));
  const [automatic, choice] = conflicts;
  const attempts = [];
  const explanationRequests = [];
  const initialDescription = "В main сохранится строка current. Строка incoming из ветки не войдёт.";
  let { bb, harness } = createFakePluginHost({
    sdk: {
      projects: { get: async () => ({ name: "Test", sources: [{ hostId: "host_test", path: "/repo" }] }) },
      environments: { get: async () => ({
        id: thread.environmentId, isWorktree: true, isGitRepo: true, branchName: "task", path: "/worktree",
        status: "ready", projectId: thread.projectId, hostId: "host_test",
      }), list: async () => [] },
      threads: {
        list: async ({ archived }) => archived ? [] : [thread],
        spawn: async ({ title, prompt }) => {
          if (title === "Разбор конфликтов worktree") return { id: "thr_agent" };
          assert.equal(title, "Пояснения к вариантам слияния");
          explanationRequests.push(JSON.parse(prompt.split("\n").at(-1)));
          return { id: "thr_explanation" };
        },
        wait: async () => {},
        output: async ({ threadId }) => ({ output: JSON.stringify(threadId === "thr_explanation" ? [
          { id: choice.id, question: "Текущая сторона заменяет base на current, а ветка на incoming. Какое значение нужно в итоговом файле?", choices: [
            { id: "2", description: "В main попадёт строка incoming. Строка current будет заменена." },
            { id: "1", description: initialDescription },
          ] },
        ] : [
          { id: automatic.id, kind: "resolve", text: "current\nincoming\n", reason: "Обе правки совместимы." },
          { id: "malformed", kind: "ask", choices: null },
          { id: choice.id, kind: "ask", question: "Какой контракт оставить?", choices: [
            { label: "Текущий", description: initialDescription, resolution: { kind: "current" } },
            { label: "Новый", resolution: { kind: "incoming" } },
          ] },
        ]) }),
        stop: async () => {},
        archive: async () => {},
      },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      if (method === "inspectWorktrees") return { base: "a".repeat(40), candidates: [
        { id: thread.environmentId, branch: "task", state: "pending", head: "b".repeat(40), files: [], message: "" },
      ] };
      attempts.push({ method, ...input });
      if (method === "previewMergeConflicts") return { outcome: "conflict", conflicts: [choice] };
      return attempts.length === 1 ? { outcome: "conflict", conflicts } : { outcome: "merged", head: "c".repeat(40) };
    },
  });
  try {
    await plugin(bb);
    const call = (method, input) => harness.behavior.callRpc(method, input);
    async function waitFor(id, expected) {
      for (let i = 0; i < 80; i++) {
        const plan = await call("mergeStatus", { id });
        if (plan.state === expected) return plan;
        assert.notEqual(plan.state, "failed", plan.message);
        await setTimeout(5);
      }
      assert.fail("Merge job did not reach " + expected);
    }
    const { id } = await call("planMerge", { mode: "single", threadId: thread.id });
    await waitFor(id, "ready");
    await call("applyMerge", { id });
    const paused = await waitFor(id, "awaiting");
    assert.match(paused.questions[0].question, /^choice.txt .*current.*incoming.*Какой контракт оставить\?/);
    assert.equal(paused.questions[0].explained, false);
    assert.equal(paused.questions[0].choices[0].description, initialDescription);
    assert.match(paused.questions[0].choices[1].description, /стал «incoming»/);
    assert.equal(paused.resolved[0].by, "agent");
    assert.equal(paused.results.length, 0);
    const db = bb.storage.database();
    const { payload } = db.prepare("SELECT payload FROM kanban_merge_jobs WHERE id = ?").get(id);
    const legacy = JSON.parse(payload);
    const answeredId = "3".repeat(64);
    const priorAnswer = { path: "answered.txt", branch: "task", by: "user", message: "Оставить текущую версию" };
    const savedResolutions = { ...legacy.resolutions, [answeredId]: { kind: "current" } };
    legacy.resolutions = savedResolutions;
    legacy.view.resolved.push(priorAnswer);
    delete legacy.pending[0].source;
    delete legacy.pending[0].view.explained;
    legacy.view.questions = legacy.pending.map(({ view }) => view);
    db.prepare("UPDATE kanban_merge_jobs SET payload = ? WHERE id = ?").run(JSON.stringify(legacy), id);
    ({ harness } = await harness.lifecycle.reload(plugin));
    assert.equal((await call("mergeHistory", null))[0].state, "awaiting");
    await call("explainMerge", { id });
    for (let i = 0; i < 80 && (await call("mergeStatus", { id })).explaining; i++) await setTimeout(5);
    const explained = await call("mergeStatus", { id });
    assert.equal(explained.state, "awaiting");
    assert.equal(explained.questions[0].explained, true);
    assert.deepEqual(explained.questions[0].choices.map(({ id, label }) => [id, label]), [["1", "Текущий"], ["2", "Новый"]]);
    assert.match(explained.questions[0].choices[1].description, /incoming.*current/);
    assert.deepEqual(explained.resolved, [...paused.resolved, priorAnswer]);
    assert.equal(attempts[1].method, "previewMergeConflicts");
    assert.deepEqual(attempts[1].resolutions, savedResolutions);
    assert.deepEqual(explanationRequests[0][0].choices.map(({ resolution }) => resolution.kind), ["current", "incoming"]);
    ({ harness } = await harness.lifecycle.reload(plugin));
    assert.deepEqual((await call("mergeStatus", { id })).questions, explained.questions);
    await assert.rejects(call("answerMerge", { id, answers: [{ questionId: choice.id, choiceId: "wrong" }] }), /Выбери один/);
    await call("answerMerge", { id, answers: [{ questionId: choice.id, choiceId: "2" }] });
    const done = await waitFor(id, "done");
    assert.deepEqual(attempts[2].resolutions, {
      ...savedResolutions,
      [choice.id]: { kind: "incoming" },
    });
    assert.equal(done.resolved[2].by, "user");
    assert.match(done.resolved[2].message, /В main попадёт строка incoming/);
    assert.equal(done.results[0].head, "c".repeat(40));
  } finally {
    await harness.lifecycle.dispose();
  }
});
