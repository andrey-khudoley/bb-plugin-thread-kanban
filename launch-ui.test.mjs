import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { build } from "esbuild";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "getComputedStyle", "localStorage", "sessionStorage"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { default: userEvent } = await import("@testing-library/user-event");
const { waitFor, cleanup } = await import("@testing-library/react");
await build({ entryPoints: ["./issue-panel.tsx"], outfile: "dist/launch-ui-test.mjs", bundle: true, packages: "external", platform: "node", format: "esm", jsx: "automatic", loader: { ".css": "empty" } });
const { IssuePanel } = await import("./dist/launch-ui-test.mjs");

test("launch menu inherits defaults and sends per-launch effort and speed overrides", async (t) => {
  const issue = { id: "qa", projectId: "proj_qa", version: 1, status: "todo", title: "Test QA", notes: "Only QA_OK",
    description: "", executionPrompt: "", assignee: "", priority: null, tags: ["Test"], threadIds: [], messages: [],
    parentId: null, blockedBy: [], related: [], duplicateOf: null, autoTitle: true, autoPlan: true, context: [],
    busy: null, error: null, origin: null, createdAt: 1, updatedAt: 1, order: 1 };
  const slot = renderSlot({ component: IssuePanel }, { params: { issueId: issue.id } }, {
    rpc: {
      issueList: () => [issue], derivationList: () => [],
      issueLaunchOptions: () => ({ selection: { providerId: "codex", model: "model", reasoningLevel: "xhigh", serviceTier: "default" },
        modelLabel: "Test model", efforts: ["low", "medium", "high", "xhigh"].map((id) => ({ id, label: id })),
        speeds: [{ id: "default", label: "Обычная" }, { id: "fast", label: "Fast" }], warning: null }),
      issueStart: () => ({ issue, threadId: "thr_qa" }),
    },
  });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  const user = userEvent.setup({ document: dom.window.document });
  await user.click(await slot.findByRole("button", { name: "Запуск", exact: true }));
  const effort = await slot.findByRole("combobox", { name: "Усилие для запуска" });
  const speed = slot.getByRole("combobox", { name: "Скорость для запуска" });
  assert.equal(effort.value, ""); assert.equal(speed.value, "");
  assert.match(effort.selectedOptions[0].textContent, /Из настроек канбана.*xhigh/);
  await user.selectOptions(effort, "high"); await user.selectOptions(speed, "fast");
  await user.click(slot.getByRole("button", { name: "Запустить работу" }));
  await waitFor(() => assert.ok(slot.inspection.rpcCalls.some(({ method }) => method === "issueStart")));
  const launch = slot.inspection.rpcCalls.find(({ method }) => method === "issueStart");
  assert.deepEqual(launch.input, { id: "qa", worktree: false, reasoningLevel: "high", serviceTier: "fast" });
  await user.click(slot.getByRole("button", { name: "Запуск", exact: true }));
  assert.equal((await slot.findByRole("combobox", { name: "Усилие для запуска" })).value, "");
  assert.equal(slot.getByRole("combobox", { name: "Скорость для запуска" }).value, "");
  await user.click(slot.getByRole("button", { name: "Запустить работу" }));
  await waitFor(() => assert.equal(slot.inspection.rpcCalls.filter(({ method }) => method === "issueStart").length, 2));
  assert.deepEqual(slot.inspection.rpcCalls.filter(({ method }) => method === "issueStart").at(-1).input,
    { id: "qa", worktree: false });
});

test("workspace tools stay mounted while switching chat, task and changes", async (t) => {
  const issue = { id: "qa-tools", projectId: "proj_qa", version: 1, title: "Test · Шапка", description: "", notes: "План",
    executionPrompt: "", context: [], assignee: "", priority: null, tags: ["Test"], status: "todo", parentId: null,
    blockedBy: [], related: [], duplicateOf: null, autoTitle: false, autoPlan: false, threadIds: ["thr_qa_tools"],
    messages: [], busy: null, error: null, origin: null, createdAt: 1, updatedAt: 1, order: 1 };
  const slot = renderSlot({ component: IssuePanel }, { params: { issueId: issue.id } }, {
    rpc: { issueList: () => [issue], derivationList: () => [], worktreeStates: () => ({}) },
    sdk: { threads: { get: async () => null } },
  });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  const user = userEvent.setup({ document: dom.window.document });
  const tools = await slot.findByRole("button", { name: "Инструменты рабочего чата" });
  for (const name of ["Задача", "Изменения", "Чат", "Задача", "Чат"]) {
    await user.click(slot.getByRole("button", { name, exact: true }));
    assert.equal(slot.getByRole("button", { name: "Инструменты рабочего чата" }), tools);
    assert.equal(tools.isConnected, true);
  }
});
