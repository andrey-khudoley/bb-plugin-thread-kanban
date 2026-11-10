import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./dist/server.js";

async function setup(t) {
  let saved = { providerId: "codex", model: "model", reasoningLevel: "xhigh", serviceTier: "default" };
  const model = { model: "model", displayName: "Test model", isDefault: true,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort })),
    defaultReasoningEffort: "medium", supportedServiceTiers: [{ id: "fast" }] };
  const { bb, harness } = createFakePluginHost({ sdk: {
    projects: { get: async () => ({ id: "proj_test", sources: [{ isDefault: true, hostId: "host_test", path: "/qa" }] }) },
    plugins: { list: async () => ({ plugins: [] }) },
    providers: { models: async () => ({ models: [model], providers: [{ id: "codex", available: true,
      capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "fast", label: "Fast" }] }] }) },
    threads: { spawn: async () => ({ id: "thr_qa" }), fork: async () => ({ id: "thr_fork" }) },
  } });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  await harness.behavior.callRpc("save", saved);
  const call = (method, input) => harness.behavior.callRpc(method, input);
  const issue = await call("issueCreate", { projectId: "proj_test", status: "todo", test: true });
  await call("issueSave", { id: issue.id, version: issue.version, fields: { ...issue, title: "QA", notes: "Only answer QA_OK" } });
  return { bb, harness, call, model, id: issue.id, save: (value) => harness.behavior.callRpc("save", value), failRead: () => bb.storage.kv.set("kanban-settings-v1", { corrupt: true }) };
}

test("saved defaults reach spawn on the execution host, including after plugin reload", async (t) => {
  const { harness, call, id } = await setup(t);
  for (const worktree of [false, true]) {
    await call("issueStart", { id, worktree });
  }
  const { harness: reloaded } = await harness.lifecycle.reload(plugin);
  t.after(() => reloaded.lifecycle.dispose());
  await reloaded.behavior.callRpc("issueStart", { id, worktree: false });
  for (const host of [harness, reloaded]) {
    for (const [args] of host.inspection.sdk.callsTo("threads.spawn")) {
      assert.equal(args.providerId, "codex"); assert.equal(args.model, "model");
      assert.equal(args.reasoningLevel, "xhigh"); assert.equal(args.serviceTier, "default");
    }
    for (const [args] of host.inspection.sdk.callsTo("providers.models")) assert.equal(args.hostId, "host_test");
  }
});

test("each supported default and explicit effort and speed reach spawn without modifying the preference", async (t) => {
  const { harness, call, id, save } = await setup(t);
  for (const reasoningLevel of ["low", "medium", "high", "xhigh"]) {
    await save({ providerId: "codex", model: "model", reasoningLevel, serviceTier: "fast" });
    await call("issueStart", { id, worktree: false });
    const [args] = harness.inspection.sdk.callsTo("threads.spawn").at(-1);
    assert.equal(args.reasoningLevel, reasoningLevel); assert.equal(args.serviceTier, "fast");
  }
  await call("issueStart", { id, worktree: false, reasoningLevel: "high", serviceTier: "default" });
  const [explicit] = harness.inspection.sdk.callsTo("threads.spawn").at(-1);
  assert.equal(explicit.reasoningLevel, "high"); assert.equal(explicit.serviceTier, "default");
  await call("issueStart", { id, worktree: false });
  const [inherited] = harness.inspection.sdk.callsTo("threads.spawn").at(-1);
  assert.equal(inherited.reasoningLevel, "xhigh"); assert.equal(inherited.serviceTier, "fast");
});

test("unsupported defaults are displayed and block spawn until explicitly overridden", async (t) => {
  const { harness, call, id, model } = await setup(t);
  model.supportedReasoningEfforts = [{ reasoningEffort: "high" }];
  const preview = await call("issueLaunchOptions", { id, worktree: false });
  assert.match(preview.warning, /не поддерживает усилие xhigh/);
  assert.equal(preview.selection.reasoningLevel, "xhigh");
  await assert.rejects(call("issueStart", { id, worktree: false }), /не поддерживает усилие xhigh/);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
  assert.equal((await call("issueList", null))[0].busy, null);
  await call("issueStart", { id, worktree: false, reasoningLevel: "high" });
  model.supportedServiceTiers = [];
  await assert.rejects(call("issueStart", { id, worktree: false, reasoningLevel: "high", serviceTier: "fast" }), /не поддерживает скорость fast/);
});

test("invalid saved settings never silently launch native defaults", async (t) => {
  const { harness, call, id, failRead } = await setup(t);
  await failRead();
  await assert.rejects(call("issueStart", { id, worktree: false }), /preference|windowPlacement/);
  assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
});

test("an explicit provider does not inherit another provider's model or settings", async (t) => {
  const { harness, call, id, save } = await setup(t);
  await save({ providerId: "other", model: "other-model", reasoningLevel: "unsupported", serviceTier: "ultrafast" });
  await call("issueStart", { id, worktree: false, providerId: "codex", reasoningLevel: "low", serviceTier: "fast" });
  const [args] = harness.inspection.sdk.callsTo("threads.spawn").at(-1);
  assert.equal(args.model, "model"); assert.equal(args.providerId, "codex");
  assert.equal(args.reasoningLevel, "low"); assert.equal(args.serviceTier, "fast");
});
