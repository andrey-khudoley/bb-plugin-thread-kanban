import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./dist/server.js";

test("new cards require an explicit test flag and never change source metadata", async (t) => {
  const metadata = { notes: "Source plan", priority: "high", tags: ["test", "release"] };
  const { bb, harness } = createFakePluginHost({ sdk: {
    projects: { get: async () => ({ id: "proj_test" }) },
    threads: {
      get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "proj_test" }),
      getPluginMetadata: async () => structuredClone(metadata),
    },
  } });
  await plugin(bb);
  t.after(() => harness.lifecycle.dispose());
  const call = (method, input) => harness.behavior.callRpc(method, input);
  const parent = await call("issueCreate", { projectId: "proj_test", status: "todo", test: true });
  assert.deepEqual(parent.tags, ["Test"]);
  for (const flag of [undefined, false, true]) {
    const card = await call("issueCreate", { projectId: "proj_test", status: "todo",
      parentId: parent.id, threadId: `thr_${flag}`, ...(flag === undefined ? {} : { test: flag }) });
    assert.deepEqual(card.tags, flag ? ["Test", "release"] : ["release"]);
    assert.equal(card.notes, metadata.notes);
    assert.equal(card.priority, metadata.priority);
  }
  assert.deepEqual((await call("issueList", null)).find(({ id }) => id === parent.id), parent);
  assert.equal(harness.inspection.sdk.callsTo("threads.updatePluginMetadata").length, 0);
  assert.deepEqual(metadata.tags, ["test", "release"]);
});

test("derivation strips generated Test tags unless the caller explicitly requests test cards", async (t) => {
  const { bb, harness } = createFakePluginHost({ sdk: {
    projects: { get: async () => ({ id: "proj_test" }) },
    threads: {
      spawn: async () => ({ id: "thr_worker" }), wait: async () => {},
      output: async () => ({ output: JSON.stringify({ tasks: [{
        title: "Generated", description: "Result", notes: "Plan", executionPrompt: "Do the work",
        tags: ["TEST", "release"], fragments: [],
      }] }) }),
      stop: async () => {}, archive: async () => {},
    },
  } });
  await plugin(bb);
  t.after(() => harness.lifecycle.dispose());
  const call = (method, input) => harness.behavior.callRpc(method, input);
  const parent = await call("issueCreate", { projectId: "proj_test", status: "todo", test: true });
  for (const flag of [undefined, false, true]) {
    const request = await call("deriveTasks", { source: { kind: "issue", id: parent.id }, mode: "single",
      instruction: "Create a task", ...(flag === undefined ? {} : { test: flag }) });
    let result;
    for (let i = 0; i < 100; i++) {
      result = await call("derivationStatus", { id: request.id });
      if (result.status !== "running") break;
      await setTimeout(10);
    }
    assert.equal(result.status, "done", result.message);
    assert.deepEqual(result.children[0].tags, flag ? ["Test", "release"] : ["release"]);
  }
  assert.deepEqual((await call("issueList", null)).find(({ id }) => id === parent.id), parent);
});
