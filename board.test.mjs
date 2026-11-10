import assert from "node:assert/strict";
import { test } from "node:test";
import { ancestorsOf, columns, descendantIds, indexThreads, stageOf } from "./board.ts";

const thread = (id, overrides = {}) => ({
  id,
  parentThreadId: null,
  updatedAt: 0,
  status: "idle",
  runtimeStatus: "idle",
  queuedWork: "none",
  activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 },
  ...overrides,
});

test("uses the four board labels and prioritizes a pending interaction over work", () => {
  const base = thread("root");
  assert.deepEqual(columns.map(({ label }) => label), ["Бэклог", "Работает", "Ожидает ввод", "Завершён"]);
  assert.equal(stageOf({ ...base, status: "pending", runtimeStatus: "pending" }), "new");
  assert.equal(stageOf({ ...base, runtimeStatus: "active" }), "working");
  assert.equal(stageOf({ ...base, runtimeStatus: "active", hasPendingInteraction: true }), "waiting");
  assert.equal(stageOf(base), "done");
  assert.equal(stageOf({ ...base, queuedWork: "waiting" }), "working");
  assert.equal(stageOf({ ...base, activity: { ...base.activity, workflows: 1 } }), "working");
  assert.equal(stageOf({ ...base, runtimeStatus: "active", hasPendingInteraction: true, isArchived: true }), "done");
});

test("indexes native fork hierarchies with multiple depths and independent statuses", () => {
  const root = thread("root");
  const fork = thread("fork", { parentThreadId: root.id, runtimeStatus: "active" });
  const nestedFork = thread("nested", { parentThreadId: fork.id, hasPendingInteraction: true });
  const sibling = thread("sibling", { parentThreadId: root.id });
  const index = indexThreads([nestedFork, sibling, root, fork]);
  assert.deepEqual(ancestorsOf(nestedFork, index).map((parent) => parent.id), ["root", "fork"]);
  assert.deepEqual(descendantIds(root.id, index), new Set(["fork", "sibling", "nested"]));
  assert.equal(stageOf(fork), "working");
  assert.equal(stageOf(nestedFork), "waiting");
});

test("handles a missing parent and terminates on a malformed cycle", () => {
  const first = thread("first", { parentThreadId: "second" });
  const second = thread("second", { parentThreadId: "first" });
  const orphan = thread("orphan", { parentThreadId: "missing" });
  const index = indexThreads([first, second, orphan]);
  assert.deepEqual(ancestorsOf(orphan, index), []);
  assert.deepEqual(ancestorsOf(first, index), [second]);
  assert.deepEqual(descendantIds(first.id, index), new Set(["second"]));
});
