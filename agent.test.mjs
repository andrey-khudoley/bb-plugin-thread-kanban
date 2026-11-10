import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./dist/server.js";

const activity = { activeWorkflowCount: 0, activePlanModeCount: 0, activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0 };
const row = (id, overrides = {}) => ({ ...makeThreadResponse({ id, projectId: "proj_test" }),
  title: id, queuedWork: "none", activity, hasPendingInteraction: false, ...overrides });
const report = (overrides = {}) => ({ windowId: "window-test", observerId: null, requestId: null, capturedAt: Date.now(),
  generation: 2, pluginId: "thread-kanban", route: "/plugins/thread-kanban/board", documentVisible: true, mounted: true,
  viewport: { width: 1200, height: 800, devicePixelRatio: 1 }, state: [{ loading: false }], cards: [], controls: [], overlays: [], panels: [], errors: [], truncated: false,
  ...overrides });

async function setup(t) {
  const threads = [];
  const closed = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "thread-kanban", agentSkillIds: ["thread-kanban"], sdk: {
    projects: { list: async () => [{ id: "proj_test", name: "Test" }], get: async () => ({ id: "proj_test" }) },
    threads: {
      list: async ({ archived = false, includeHidden = false, projectId, threadIds, offset = 0, limit = 200 }) => threads
        .filter((thread) => Boolean(thread.archivedAt) === archived && (includeHidden || thread.visibility !== "hidden") &&
          (!projectId || thread.projectId === projectId) && (!threadIds || threadIds.includes(thread.id))).slice(offset, offset + limit),
      get: async ({ threadId }) => threads.find(({ id }) => id === threadId) ?? makeThreadResponse({ id: threadId, projectId: "proj_test" }),
      getPluginMetadata: async () => ({}),
      experimental_listPluginMetadata: async () => ({ threads: [] }),
    },
    experimental_desktopBrowsers: {
      listInstances: async () => ({ instances: [{ hostId: "host_test", instanceId: "desktop_test", generation: "g1" }] }),
      createTab: async () => ({ tab: { tabId: "tab_owned" } }),
      captureTab: async () => ({ base64: "/9j/test", mimeType: "image/jpeg", width: 1200, height: 800 }),
      closeTab: async (input) => { closed.push(input); return { ok: true }; },
    },
  } });
  await plugin(bb);
  t.after(() => harness.lifecycle.dispose());
  const call = (method, input = {}) => harness.behavior.callRpc(method, input);
  return { call, threads, harness, closed };
}

test("server snapshot combines native chats and tasks without duplicate linked chats, with bounded pagination", async (t) => {
  const { call, threads } = await setup(t);
  threads.push(row("thr_linked"), row("thr_native", { hasPendingInteraction: true }), row("thr_hidden", { visibility: "hidden" }));
  const issue = await call("issueCreate", { projectId: "proj_test", status: "todo", threadId: "thr_linked", test: true });
  const result = await call("agentSnapshot", { limit: 1 });
  assert.equal(result.source, "server"); assert.equal(result.total, 2);
  assert.equal(result.cards.length, 1); assert.equal(result.nextOffset, 1);
  const all = await call("agentSnapshot", { includeHidden: true });
  assert.equal(all.total, 3);
  assert.ok(all.cards.some((card) => card.id === issue.id && card.tags.includes("Test")));
  assert.ok(!all.cards.some((card) => card.id === "thr_linked"));
  assert.equal(all.cards.find((card) => card.id === "thr_native").nativeStage, "waiting");
  assert.equal((await call("agentSnapshot", { query: "does not exist" })).total, 0);
  await assert.rejects(() => call("agentSnapshot", { limit: 201 }));
});

test("archive visibility matches task ownership and native chat lifecycles", async (t) => {
  const { call, threads } = await setup(t);
  threads.push(row("thr_archived", { archivedAt: 1 }), row("thr_archived_native", { archivedAt: 1 }));
  await call("issueCreate", { projectId: "proj_test", status: "todo", threadId: "thr_archived", test: true });
  assert.equal((await call("agentSnapshot")).total, 0);
  assert.equal((await call("agentSnapshot", { includeArchived: true })).total, 2);
});

test("card reads include runs and refuse missing tasks", async (t) => {
  const { call, threads } = await setup(t);
  threads.push(row("thr_linked"));
  const issue = await call("issueCreate", { projectId: "proj_test", status: "todo", threadId: "thr_linked", test: true });
  const result = await call("agentCardGet", { id: issue.id });
  assert.equal(result.issue.id, issue.id); assert.equal(result.runs[0].id, "thr_linked");
  assert.equal((await call("agentCardGet", { id: "thr_linked", kind: "thread" })).linkedIssues[0].id, issue.id);
  await assert.rejects(() => call("agentCardGet", { id: "missing" }), /Карточка не найдена/);
});

test("UI snapshots require a new correlated response and never pass a cached report as live UI", async (t) => {
  const { call, harness } = await setup(t);
  await call("agentUiReport", report());
  const absent = await call("agentUiSnapshot", { windowId: "window-test", timeoutMs: 250 });
  assert.equal(absent.status, "no_window"); assert.equal(absent.windows.length, 0);
  const pending = call("agentUiSnapshot", { windowId: "window-test", timeoutMs: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  const request = harness.inspection.realtimeSignals.at(-1).payload;
  await call("agentUiReport", report({ requestId: request.requestId, state: [{ query: "real filter" }] }));
  const live = await pending;
  assert.equal(live.status, "ok"); assert.equal(live.windows[0].state[0].query, "real filter");
  await call("agentUiGone", { windowId: "window-test" });
  const other = call("agentUiSnapshot", { timeoutMs: 500 });
  await new Promise((resolve) => setImmediate(resolve));
  await call("agentUiReport", report({ requestId: harness.inspection.realtimeSignals.at(-1).payload.requestId, mounted: false }));
  assert.equal((await other).status, "board_closed");
});

test("observer capture uses the exact owned desktop tab, returns native image content and closes that tab", async (t) => {
  const { call, harness, closed } = await setup(t);
  let observerId;
  harness.sdk.stub("experimental_desktopBrowsers.createTab", async ({ url }) => {
    observerId = new URL(url).searchParams.get("kanban-observer");
    return { tab: { tabId: "tab_owned" } };
  });
  const responder = setInterval(() => {
    const request = harness.inspection.realtimeSignals.at(-1)?.payload;
    if (observerId && request?.requestId) void call("agentUiReport", report({ observerId, requestId: request.requestId }));
  }, 10);
  t.after(() => clearInterval(responder));
  const opened = await call("agentUiOpen", { hostId: "host_test", instanceId: "desktop_test", threadId: "thr_test" });
  assert.equal(opened.windowId, "window-test");
  const image = await call("agentUiCapture", { windowId: opened.windowId, threadId: "thr_test" });
  assert.equal(image.source, "desktop-browser-screenshot"); assert.equal(image.base64, "/9j/test");
  const native = await harness.behavior.callAgentTool("kanban_ui_capture", {
    windowId: opened.windowId, threadId: "thr_other",
  }, { threadId: "thr_test" });
  assert.equal(native.content[1].type, "image"); assert.equal(native.content[1].data, "/9j/test");
  await assert.rejects(() => call("agentUiCapture", { windowId: opened.windowId, threadId: "thr_other" }), /не принадлежит/);
  const captureCalls = harness.inspection.sdk.callsTo("experimental_desktopBrowsers.captureTab");
  assert.equal(captureCalls.length, 2);
  clearInterval(responder);
  await call("agentUiGone", { windowId: opened.windowId });
  await call("agentUiClose", { windowId: opened.windowId, threadId: "thr_test" });
  assert.equal(closed[0].tabId, "tab_owned");
  assert.equal("observerId" in closed[0], false);
});

test("ordinary agents receive read tools while recovery agents retain their specialized review tool", async (t) => {
  const { harness } = await setup(t);
  const base = makePluginAgentConfigurationContext();
  const ordinary = await harness.behavior.resolveAgentConfiguration(base);
  assert.ok(ordinary.tools.some((tool) => (typeof tool === "string" ? tool : tool.name) === "kanban_snapshot"));
  const recovery = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    origin: { kind: "plugin", pluginId: "thread-kanban" }, pluginMetadata: { sharedReview: true },
  }));
  assert.ok(recovery.tools.some((tool) => (typeof tool === "string" ? tool : tool.name) === "kanban_resolve_shared_review"));
});
