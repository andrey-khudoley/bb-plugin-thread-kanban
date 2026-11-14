import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./dist/server.js";

test("generates scoped, nested tasks with verified context and a fresh launch", async () => {
  const thread = makeThreadResponse({ id: "thr_source", projectId: "proj_personal", environmentId: "env_source", title: "Релиз" });
  const source = { kind: "thread", id: thread.id };
  const note = "Для проверки нужен пробный релиз.";
  const transcript = [
    { id: "old", kind: "conversation", role: "user", text: note, messageSeq: 2 },
    { id: "turn", kind: "turn", children: [
      { id: "latest", kind: "conversation", role: "assistant", text: "Обсудили публикацию и проверку.", messageSeq: 5 },
    ] },
    { id: "work", kind: "work", text: "Лишний вывод инструмента." },
  ];
  const task = (title, fragments = []) => ({
    title, description: "Подготовить и проверить результат.", notes: "Собрать, проверить, зафиксировать.",
    executionPrompt: "Собери результат и зафиксируй проверку.", priority: "high",
    tags: ["релиз"], status: "todo", fragments,
  });
  const replies = [
    { tasks: [
      task("Проверить релиз", [{ source: 0, text: note }, { source: 1, text: "Выдуманный фрагмент." }]),
      { ...task("Записать результат"), tags: ["test", "TEST", "релиз"] },
    ] },
    { tasks: [task("Проверить установку")] },
    { tasks: [] },
  ];
  const workerReplies = new Map();
  let workerCount = 0;
  const { bb, harness } = createFakePluginHost({ sdk: { plugins: { list: async () => ({ plugins: [] }) }, threads: {
    get: async () => thread,
    getPluginMetadata: async () => ({ tags: ["исходный"] }),
    timeline: async ({ beforeAnchorId, beforeAnchorSeq }) => {
      if (beforeAnchorId) {
        assert.equal(beforeAnchorSeq, "2");
        return { rows: [transcript[0]], timelinePage: {} };
      }
      return { rows: transcript.slice(1), timelinePage: { olderCursor: { anchorId: "cursor", anchorSeq: 2 } } };
    },
    spawn: async ({ visibility }) => {
      if (visibility !== "hidden") return { id: "thr_launch" };
      const id = `thr_worker${++workerCount}`;
      workerReplies.set(id, replies.shift());
      return { id };
    },
    wait: async () => { await setTimeout(10); },
    output: async ({ threadId }) => ({ output: JSON.stringify(workerReplies.get(threadId)) }),
    archive: async () => {},
    stop: async () => {},
  } } });
  try {
    await plugin(bb);
    const call = (method, input) => harness.behavior.callRpc(method, input);
    async function waitFor(id) {
      for (let i = 0; i < 50; i++) {
        const result = await call("derivationStatus", { id });
        if (result.status !== "running") return result;
        await setTimeout(10);
      }
      assert.fail("Generation did not finish");
    }
    const input = { source, mode: "decompose", instruction: "Только этап проверки", test: true };
    const request = await call("deriveTasks", input);
    assert.equal((await call("deriveTasks", input)).id, request.id);
    const result = await waitFor(request.id);
    assert.equal(result.status, "done", result.message);
    assert.equal(result.children.length, 2);
    const [first, second] = result.children;
    assert.equal(first.parentId, result.parentId);
    assert.equal(second.parentId, result.parentId);
    assert.deepEqual(first.context.map(({ text }) => text), [note]);
    assert.equal(first.status, "todo");
    assert.equal(first.priority, "high");
    assert.deepEqual(first.tags, ["Test", "релиз"]);
    assert.deepEqual(second.tags, ["Test", "релиз"]);
    const sourceIssue = (await call("issueList", null)).find(({ id }) => id === result.parentId);
    assert.deepEqual(sourceIssue.threadIds, [thread.id]);
    assert.deepEqual(sourceIssue.tags, ["исходный"]);
    const nested = await call("deriveTasks", {
      source: { kind: "issue", id: first.id }, mode: "single", instruction: "Проверь установку.",
    });
    const child = (await waitFor(nested.id)).children[0];
    assert.equal(child.parentId, first.id);
    assert.equal(child.origin.issueId, first.id);
    assert.deepEqual(child.tags, ["релиз"]);

    await assert.rejects(call("issueStart", { id: first.id, worktree: true }), /Git worktree доступен в Git-разделе/);
    const launch = await call("issueStart", { id: first.id, worktree: false });
    assert.equal(launch.threadId, "thr_launch");
    const spawn = harness.inspection.sdk.callsTo("threads.spawn").map(([args]) => args);
    assert.match(spawn[0].prompt, /Только этап проверки/);
    assert.match(spawn[0].prompt, /Обсудили публикацию и проверку/);
    assert.doesNotMatch(spawn[0].prompt, /Лишний вывод инструмента/);
    assert.match(spawn[1].prompt, /Проверь установку/);
    assert.equal(spawn[2].parentThreadId, thread.id);
    assert.deepEqual(spawn[2].environment, { type: "reuse", environmentId: thread.environmentId });
    assert.match(spawn[2].prompt, /Собери результат/);
    assert.ok(spawn[2].prompt.includes(note));
    assert.doesNotMatch(spawn[2].prompt, /Обсудили публикацию|Выдуманный фрагмент/);

    const empty = await call("deriveTasks", { source: { kind: "issue", id: child.id }, mode: "decompose", instruction: "" });
    assert.deepEqual((await waitFor(empty.id)).children, []);
    assert.equal((await call("issueList", null)).length, 4);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("selects the project checkout or a separate worktree according to the launch checkbox", async () => {
  const projectId = "proj_git";
  const path = "/project";
  const { bb, harness } = createFakePluginHost({ sdk: {
    plugins: { list: async () => ({ plugins: [] }) },
    projects: { get: async () => ({ id: projectId, sources: [
      { isDefault: false, hostId: "host_secondary", path: "/secondary" },
      { isDefault: true, hostId: "host_project", path },
    ] }) },
    threads: {
      spawn: async ({ environment }) => ({ id: environment.type === "provider" ? "thr_checkout" : "thr_worktree" }),
      fork: async () => ({ id: "thr_fork" }),
    },
  } });
  try {
    await plugin(bb);
    const call = (method, input) => harness.behavior.callRpc(method, input);
    const issue = await call("issueCreate", { projectId, status: "todo", test: true });
    assert.deepEqual(issue.tags, ["Test"]);
    const updated = await call("issueSave", {
      id: issue.id, version: issue.version, fields: { ...issue, title: "Проверить проект", notes: "Запустить проверки." },
    });
    const checkout = await call("issueStart", { id: updated.id, worktree: false });
    await call("issueStart", { id: updated.id, worktree: true });
    const [[checkoutSpawn], [worktreeSpawn]] = harness.inspection.sdk.callsTo("threads.spawn");
    assert.deepEqual(checkoutSpawn.pluginMetadata.tags, ["Test"]);
    assert.deepEqual(checkoutSpawn.environment, {
      type: "provider", environmentProviderId: "project-checkout",
      machine: { type: "existing", hostId: "host_project" }, inputs: { path },
    });
    assert.deepEqual(worktreeSpawn.environment, {
      type: "host", hostId: "host_project", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    });
    await call("issueStart", { id: updated.id, worktree: false, sourceThreadId: checkout.threadId });
    const [[fork]] = harness.inspection.sdk.callsTo("threads.fork");
    assert.equal(fork.sourceThreadId, checkout.threadId);
    assert.equal(Object.hasOwn(fork, "environment"), false);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("tracks worker activity and failures separately across concurrent derivations and retries", async () => {
  const waits = new Map();
  let workerCount = 0;
  const { bb, harness } = createFakePluginHost({ sdk: { projects: { get: async () => ({}) }, threads: {
    spawn: async () => ({ id: `thr_worker${++workerCount}` }),
    wait: ({ threadId, signal }) => new Promise((resolve, reject) => {
      waits.set(threadId, resolve);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    events: { list: async ({ threadId }) => [
      { type: "item/toolCall/progress", data: { message: `Проверка ${threadId}` } },
      { type: "turn/started", data: {} },
    ] },
    output: async () => ({ output: JSON.stringify({ tasks: [] }) }),
    archive: async () => {},
    stop: async () => {},
  } } });
  try {
    await plugin(bb);
    const call = (method, input) => harness.behavior.callRpc(method, input);
    const request = async () => {
      const issue = await call("issueCreate", { projectId: "proj_personal", status: "backlog" });
      return { source: { kind: "issue", id: issue.id }, mode: "decompose" };
    };
    const status = (run) => call("derivationStatus", { id: run.id });
    const input = await request();
    const first = await call("deriveTasks", input);
    const other = await call("deriveTasks", await request());
    assert.equal(first.phase, "context");
    assert.notEqual(first.id, other.id);
    await setTimeout(0);
    assert.equal((await status(first)).phase, "waiting");
    assert.equal((await status(other)).phase, "waiting");
    assert.equal((await status(other)).agentStarted, false);
    const worker = makeThreadResponse({ id: "thr_worker1" });
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: worker, sequence: 2 });
    assert.equal((await status(first)).agentStarted, true);
    assert.deepEqual((await status(first)).activity, ["Проверка thr_worker1"]);
    assert.deepEqual((await status(other)).activity, []);
    await harness.behavior.emitThreadEvent("thread.failed", { thread: worker, error: "Контрольный сбой" });
    assert.equal((await status(first)).status, "failed");
    assert.equal((await status(first)).message, "Контрольный сбой");
    assert.equal((await status(other)).status, "running");
    const retry = await call("deriveTasks", input);
    assert.notEqual(retry.id, first.id);
    await setTimeout(0);
    waits.get("thr_worker2")();
    waits.get("thr_worker3")();
    await setTimeout(0);
    assert.equal((await status(other)).status, "done");
    assert.equal((await status(retry)).status, "done");
    assert.equal((await status(retry)).phase, "saving");
    assert.deepEqual((await status(retry)).activity, []);
  } finally {
    await harness.lifecycle.dispose();
  }
});
