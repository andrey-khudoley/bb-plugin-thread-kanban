import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./dist/server.js";

const projectId = "proj_personal";

async function setup(t, readThread = (thread) => thread) {
  const threads = new Map();
  const { bb, harness } = createFakePluginHost({ sdk: {
    projects: { get: async () => ({ id: projectId }) },
    threads: {
      get: async ({ threadId }) => readThread(threads.get(threadId)),
      getPluginMetadata: async () => ({}),
    },
  } });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const call = (method, input) => harness.behavior.callRpc(method, input);
  const addThread = (id, overrides) => threads.set(id, makeThreadResponse({ id, projectId, ...overrides }));
  async function change(threadId, status) {
    const thread = { ...threads.get(threadId), status };
    threads.set(threadId, thread);
    const result = status === "active"
      ? await harness.behavior.emitThreadEvent("thread.active", { thread })
      : await harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "Готово" });
    assert.deepEqual(result.errors, []);
  }
  const stage = async (id) => (await call("issueList", null)).find((issue) => issue.id === id)?.status;
  return { addThread, call, change, stage, harness, signals: harness.inspection.realtimeSignals };
}

test("removes a deleted chat from its card while keeping other linked chats", async (t) => {
  const { addThread, call, harness } = await setup(t);
  const first = "thr_first";
  const second = "thr_second";
  addThread(first);
  addThread(second);
  const card = await call("issueCreate", { projectId, status: "todo", threadId: first, test: true });
  await call("issueLink", { id: card.id, threadId: second, linked: true });

  const result = await harness.behavior.emitThreadEvent("thread.deleted", {
    thread: makeThreadResponse({ id: first, projectId, deletedAt: Date.now() }),
  });
  assert.deepEqual(result.errors, []);
  const [saved] = await call("issueList", null);
  assert.equal(saved.id, card.id);
  assert.equal(saved.status, card.status);
  assert.deepEqual(saved.tags, ["Test"]);
  assert.deepEqual(saved.threadIds, [second]);
});

test("a planning message can be retried after a failed launch without duplicating it", async (t) => {
  const { call, harness } = await setup(t);
  const { id } = await call("issueCreate", { projectId, status: "todo", test: true });
  const text = "Черновик постановки задачи";
  harness.sdk.stub("threads.spawn", async () => { throw new Error("Сбой запуска"); });

  const failed = await call("issueAsk", { id, text });
  assert.match(failed.error, /Сбой запуска/);
  assert.deepEqual(failed.messages, []);
  assert.equal(failed.description, "");
  assert.equal(failed.busy, null);

  harness.sdk.stub("threads.spawn", async () => ({ id: "thr_planning" }));
  harness.sdk.stub("threads.wait", async () => new Promise(() => {}));
  const retried = await call("issueAsk", { id, text });
  assert.equal(retried.error, null);
  assert.deepEqual(retried.messages, [{ role: "user", text }]);
  assert.equal(retried.description, text);
});

test("requires a current deletion confirmation and removes the review card, its chat and worktree", async (t) => {
  const threadId = "thr_delete_test";
  const environmentId = "env_delete_test";
  const thread = makeThreadResponse({ id: threadId, projectId, environmentId });
  const calls = [];
  let state = "merged";
  const { bb, harness } = createFakePluginHost({
    sdk: {
      projects: { get: async () => ({ id: projectId, sources: [{ hostId: "host_test", path: "repo", isDefault: true }] }) },
      environments: {
        get: async () => ({ id: environmentId, projectId, hostId: "host_test", path: "worktree", branchName: "test",
          status: "ready", managed: true, isGitRepo: true, isWorktree: true }),
        experimental_cleanup: async ({ environmentId }) => { calls.push(environmentId); return { ok: true }; },
      },
      threads: {
        get: async () => thread,
        getPluginMetadata: async () => ({}),
        list: async () => [thread],
        experimental_listCascade: async () => ({ threads: [{ threadId, cascadeThreadIds: [] }] }),
        delete: async ({ threadId, childThreadsConfirmed }) => {
          assert.equal(childThreadsConfirmed, false);
          calls.push(threadId);
          const result = await harness.behavior.emitThreadEvent("thread.deleted", {
            thread: { ...thread, deletedAt: Date.now() },
          });
          assert.deepEqual(result.errors, []);
          return { ok: true };
        },
      },
    },
    experimental_callHostRpc: async ({ method }) => {
      assert.equal(method, "inspectWorktrees");
      return { base: "a".repeat(40), candidates: [{ id: environmentId, branch: "test", head: "b".repeat(40),
        state, files: [], message: "" }] };
    },
  });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const call = (method, input) => harness.behavior.callRpc(method, input);
  const { id } = await call("issueCreate", { projectId, status: "todo", threadId, test: true });
  const child = await call("issueCreate", { projectId, status: "todo", parentId: id, test: true });
  await call("issueMove", { id, status: "review" });
  const merged = await call("issueDeletePreview", { id });
  assert.deepEqual(merged.warnings, []);
  assert.equal(merged.worktrees, 1);

  state = "dirty";
  await assert.rejects(call("issueDelete", { id, confirmation: merged.confirmation }), /изменились/);
  assert.deepEqual(calls, []);
  assert.equal((await call("issueList", null)).find((item) => item.id === id)?.status, "review");
  const dirty = await call("issueDeletePreview", { id });
  assert.match(dirty.warnings[0], /незакоммиченные изменения/);
  await call("issueDelete", { id, confirmation: dirty.confirmation });
  assert.deepEqual(calls, [threadId, environmentId]);

  const { harness: reloaded } = await harness.lifecycle.reload(plugin);
  t.after(() => reloaded.lifecycle.dispose());
  const [saved] = await reloaded.behavior.callRpc("issueList", null);
  assert.equal(saved.id, child.id);
  assert.equal(saved.parentId, null);
});

test("reopens a finished chat card on a new turn and persists both transitions", async (t) => {
  const { addThread, call, change, stage, harness, signals } = await setup(t);
  const threadId = "thr_chat";
  addThread(threadId);
  const { id } = await call("issueCreate", { projectId, status: "done", threadId });
  const signalsBeforeTurn = signals.length;

  await change(threadId, "active");
  assert.equal(await stage(id), "working");
  await change(threadId, "idle");
  assert.equal(await stage(id), "review");
  assert.equal(signals.length, signalsBeforeTurn + 2);

  const { harness: reloaded } = await harness.lifecycle.reload(plugin);
  t.after(() => reloaded.lifecycle.dispose());
  const [card] = await reloaded.behavior.callRpc("issueList", null);
  assert.equal(card.id, id);
  assert.equal(card.status, "review");
});

test("reviews a task after its last linked run, and preserves manual completion during a turn", async (t) => {
  const { addThread, call, change, stage } = await setup(t);
  const { id } = await call("issueCreate", { projectId, status: "todo" });
  addThread("thr_first");
  addThread("thr_second");
  for (const threadId of ["thr_first", "thr_second"]) {
    await call("issueLink", { id, threadId, linked: true });
  }
  await call("issueMove", { id, status: "done" });

  await change("thr_first", "active");
  await change("thr_second", "active");
  await change("thr_first", "idle");
  assert.equal(await stage(id), "working");
  await change("thr_second", "idle");
  assert.equal(await stage(id), "review");

  await change("thr_first", "active");
  await call("issueMove", { id, status: "done" });
  await change("thr_first", "idle");
  assert.equal(await stage(id), "done");
});

test("archives only the selected chat and preserves its task and child links across reload", async (t) => {
  const parent = "thr_parent";
  const child = "thr_child";
  const grandchild = "thr_grandchild";
  const rows = new Map([
    [parent, { id: parent, parentThreadId: null }],
    [child, { id: child, parentThreadId: parent }],
    [grandchild, { id: grandchild, parentThreadId: child }],
  ].map(([id, row]) => [id, {
    ...row, projectId, visibility: "visible", status: "idle", runtime: { displayStatus: "idle" },
    queuedWork: "none", hasPendingInteraction: false, archivedAt: null, sectionId: null, activity: {},
  }]));
  const archivedCalls = [];
  let refuseArchive = false;
  const { bb, harness } = createFakePluginHost({ sdk: {
    projects: { get: async () => ({ id: projectId }) },
    threads: {
      get: async ({ threadId }) => rows.get(threadId),
      list: async ({ threadIds, archived }) => [...rows.values()].filter((row) =>
        (!threadIds || threadIds.includes(row.id)) && Boolean(row.archivedAt) === archived),
      experimental_listCascade: async () => ({ threads: [] }),
      update: async ({ threadId, parentThreadId }) => Object.assign(rows.get(threadId), { parentThreadId }),
      archive: async ({ threadId }) => {
        assert.equal(rows.get(child).parentThreadId, null);
        if (refuseArchive) throw new Error("BB rejected archive");
        archivedCalls.push(threadId);
        rows.get(threadId).archivedAt = 100;
      },
      unarchive: async ({ threadId }) => { rows.get(threadId).archivedAt = null; },
    },
  } });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const call = (method, input) => harness.behavior.callRpc(method, input);
  const task = await call("issueCreate", { projectId, status: "todo", test: true });
  await call("issueLink", { id: task.id, threadId: parent, linked: true });
  const archive = { threadId: parent, archived: true };
  const archiveKeys = { keys: [parent, child, "thr_missing"] };

  refuseArchive = true;
  await assert.rejects(() => call("archiveChat", archive), /BB rejected archive/);
  assert.equal(rows.get(child).parentThreadId, parent);
  assert.deepEqual(await call("archiveParents", null), {});
  assert.deepEqual(await call("archivedThreads", archiveKeys), { [parent]: null, [child]: null, thr_missing: null });

  rows.get(child).lifecycleOwnerThreadId = parent;
  await assert.rejects(() => call("archiveChat", archive), /зависимыми чатами/);
  assert.equal(rows.get(child).parentThreadId, parent);
  delete rows.get(child).lifecycleOwnerThreadId;

  refuseArchive = false;
  await call("archiveChat", archive);
  assert.deepEqual(archivedCalls, [parent]);
  assert.equal(rows.get(child).archivedAt, null);
  assert.equal(rows.get(grandchild).parentThreadId, child);
  const { harness: reloaded } = await harness.lifecycle.reload(plugin);
  t.after(() => reloaded.lifecycle.dispose());
  const afterReload = (method, input) => reloaded.behavior.callRpc(method, input);
  const [saved] = await afterReload("issueList", null);
  assert.equal(saved.status, "todo");
  assert.deepEqual(saved.threadIds, [parent]);
  assert.deepEqual(await afterReload("archiveParents", null), { [child]: parent });
  assert.deepEqual(await afterReload("archivedThreads", archiveKeys), { [parent]: parent, [child]: null, thr_missing: null });

  await afterReload("archiveChat", { threadId: parent, archived: false });
  assert.equal(rows.get(parent).archivedAt, null);
  assert.equal(rows.get(child).parentThreadId, parent);
  assert.deepEqual(await afterReload("archiveParents", null), {});
  assert.deepEqual(await afterReload("archivedThreads", archiveKeys), { [parent]: null, [child]: null, thr_missing: null });
});

test("a fresh turn invalidates a review check still reading linked chats", async (t) => {
  const reading = Promise.withResolvers();
  const releaseRead = Promise.withResolvers();
  const threadId = "thr_chat";
  let pause = false;
  const { addThread, call, change, stage } = await setup(t, async (thread) => {
    if (pause) {
      reading.resolve();
      await releaseRead.promise;
    }
    return thread;
  });
  addThread(threadId);
  const { id } = await call("issueCreate", { projectId, status: "working", threadId });
  pause = true;
  const oldCompletion = change(threadId, "idle");
  await reading.promise;
  try {
    await change(threadId, "active");
  } finally {
    pause = false;
    releaseRead.resolve();
    await oldCompletion;
  }
  assert.equal(await stage(id), "working");
  await change(threadId, "idle");
  assert.equal(await stage(id), "review");
});
