import assert from "node:assert/strict";
import test from "node:test";
import { createOpenChatStore } from "./open-chats.ts";

test("replacement, closing and inactive panes retain only their visible chats", () => {
  const chats = createOpenChatStore();
  const first = chats.open("thr_first");
  const otherPane = chats.open("thr_other");
  first();
  const replacement = chats.open("thr_replacement");
  assert.deepEqual([...chats.getSnapshot()].sort(), ["thr_other", "thr_replacement"]);
  replacement(); // Switching this pane to card settings also releases the lease.
  assert.deepEqual([...chats.getSnapshot()], ["thr_other"]);
  otherPane();
  assert.equal(chats.getSnapshot().size, 0);
});

test("the same chat in two panes stays highlighted until both instances close", () => {
  const chats = createOpenChatStore();
  let changes = 0;
  const unsubscribe = chats.subscribe(() => changes++);
  const first = chats.open("thr_shared");
  const snapshot = chats.getSnapshot();
  const second = chats.open("thr_shared");
  first();
  first(); // Effect cleanup must be idempotent, including React Strict Mode.
  assert.strictEqual(chats.getSnapshot(), snapshot);
  assert.equal(changes, 1);
  second();
  assert.equal(changes, 2);
  assert.equal(snapshot.has("thr_shared"), true); // Old snapshots remain immutable.
  assert.equal(chats.getSnapshot().has("thr_shared"), false);
  unsubscribe();
  chats.open("thr_new");
  assert.equal(changes, 2);
});

test("windows do not share open state", () => {
  const firstWindow = createOpenChatStore();
  const secondWindow = createOpenChatStore();
  firstWindow.open("thr_first");
  assert.equal(secondWindow.getSnapshot().size, 0);
});
