import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./dist/server.js";

const preference = { providerId: "codex", model: "test-model", reasoningLevel: "high", serviceTier: "default" };
async function setup(t, sdk = { plugins: { list: async () => ({ plugins: [] }) } }) {
  const host = createFakePluginHost({ sdk });
  t.after(() => host.harness.lifecycle.dispose());
  await plugin(host.bb);
  return { ...host, call: (method, input = null) => host.harness.behavior.callRpc(method, input) };
}

test("a clean install owns all settings, preserves independent saves and survives reload", async t => {
  const { harness, call } = await setup(t);
  assert.equal(await call("read"), null);
  assert.equal(await call("readWindowPlacement"), "right");
  assert.deepEqual(await call("readPaneHeaders"), { top: false, bottom: true });
  await Promise.all([call("save", preference), call("saveWindowPlacement", "above"), call("savePaneHeaders", { top: true, bottom: false })]);
  const next = await harness.lifecycle.reload(plugin);
  t.after(() => next.harness.lifecycle.dispose());
  assert.deepEqual(await next.harness.behavior.callRpc("read", null), preference);
  assert.equal(await next.harness.behavior.callRpc("readWindowPlacement", null), "above");
  assert.deepEqual(await next.harness.behavior.callRpc("readPaneHeaders", null), { top: true, bottom: false });
  assert.equal(harness.inspection.sdk.callsTo("plugins.callRpc").length, 0);
});

test("legacy settings migrate once, without requiring the old plugin after reload", async t => {
  let available = true;
  const { harness, call } = await setup(t, { plugins: {
    list: async () => ({ plugins: available ? [{ id: "chat-defaults", status: "running" }] : [] }),
    callRpc: async ({ method, outputSchema }) => outputSchema.parse({
      read: preference, readWindowPlacement: "below", readPaneHeaders: { top: true, bottom: true },
    }[method]),
  } });
  assert.deepEqual(await call("read"), preference);
  assert.equal(await call("readWindowPlacement"), "below");
  assert.deepEqual(await call("readPaneHeaders"), { top: true, bottom: true });
  assert.equal(harness.inspection.sdk.callsTo("plugins.callRpc").length, 3);
  available = false;
  await call("saveWindowPlacement", "above");
  const next = await harness.lifecycle.reload(plugin);
  t.after(() => next.harness.lifecycle.dispose());
  assert.deepEqual(await next.harness.behavior.callRpc("read", null), preference);
  assert.equal(await next.harness.behavior.callRpc("readWindowPlacement", null), "above");
  assert.equal(next.harness.inspection.sdk.callsTo("plugins.list").length, 0);
});

test("a partial migration failure stores nothing and retries all fields", async t => {
  let fail = true;
  const { bb, call } = await setup(t, { plugins: {
    list: async () => ({ plugins: [{ id: "chat-defaults", status: "running" }] }),
    callRpc: async ({ method, outputSchema }) => {
      if (fail && method === "readPaneHeaders") throw new Error("Legacy settings unavailable");
      return outputSchema.parse({ read: preference, readWindowPlacement: "below", readPaneHeaders: { top: true, bottom: false } }[method]);
    },
  } });
  await assert.rejects(call("read"), /Legacy settings unavailable/);
  assert.equal(await bb.storage.kv.get("kanban-settings-v1"), undefined);
  fail = false;
  assert.deepEqual(await call("read"), preference);
  assert.equal(await call("readWindowPlacement"), "below");
});

test("a disabled legacy plugin blocks migration rather than overwriting its values", async t => {
  const { bb, call } = await setup(t, { plugins: { list: async () => ({ plugins: [{ id: "chat-defaults", status: "disabled" }] }) } });
  await assert.rejects(call("read"), /chat-defaults/);
  assert.equal(await bb.storage.kv.get("kanban-settings-v1"), undefined);
});

test("invalid settings cannot overwrite the saved selection", async t => {
  const { call } = await setup(t);
  await call("save", preference);
  await assert.rejects(call("saveWindowPlacement", "left"));
  await assert.rejects(call("savePaneHeaders", { top: "right", bottom: true }));
  assert.deepEqual(await call("read"), preference);
  assert.equal(await call("readWindowPlacement"), "right");
});
