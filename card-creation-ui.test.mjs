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
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { default: userEvent } = await import("@testing-library/user-event");
const { waitFor, cleanup, within } = await import("@testing-library/react");
await build({ stdin: { contents: `export { default } from './app'; export { DeriveDialog } from './derive-dialog';`,
  resolveDir: process.cwd(), loader: "tsx" }, outfile: "dist/card-creation-ui-test.mjs", bundle: true,
  packages: "external", platform: "node", format: "esm", jsx: "automatic", loader: { ".css": "empty" } });
const { DeriveDialog } = await import("./dist/card-creation-ui-test.mjs");
const app = await loadPluginApp(() => import("./dist/card-creation-ui-test.mjs"));

for (const mode of ["single", "decompose"]) {
  test(`manual ${mode} has no Test checkbox and overrides stale test selection`, async (t) => {
    let submitted;
    const slot = renderSlot({ component: DeriveDialog }, {
      request: { selection: { source: { kind: "issue", id: "source" }, title: "Source", mode, test: true }, trigger: null },
      close: () => {}, start: (selection) => { submitted = selection; },
    });
    t.after(() => { slot.lifecycle.unmount(); cleanup(); });
    const user = userEvent.setup({ document: dom.window.document });
    const dialog = within(await slot.findByRole("dialog"));
    assert.equal(dialog.queryByRole("checkbox"), null);
    await user.type(dialog.getByRole("textbox"), "Prepare the task");
    await user.click(dialog.getByRole("button", { name: mode === "single" ? "Подготовить задачу" : "Разложить на задачи" }));
    assert.equal(submitted.test, false);
  });
}

test("manual chat fork excludes Test while preserving the source plan and ordinary tags", async (t) => {
  sessionStorage.clear(); localStorage.clear();
  const metadata = { notes: "Source plan", priority: "high", tags: ["Test", "release"] };
  const thread = { id: "thr_source", projectId: "proj_test", displayTitle: "Source chat",
    parentThreadId: null, updatedAt: 1, status: "pending", runtimeStatus: "idle", activity: {}, queuedWork: null,
    isArchived: false, hasPendingInteraction: false, href: "/", environmentId: "env_test" };
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, {
    sidebarThreads: { status: "ready", projects: [{ id: "proj_test", name: "Project", href: "/", settingsHref: "/" }], threads: [thread] },
    sdk: { threads: {
      getPluginMetadata: async () => structuredClone(metadata),
      fork: async () => ({ id: "thr_fork", title: "Fork" }),
    } },
    rpc: { issueList: () => [], planList: () => ({ thr_source: metadata }), archiveParents: () => ({}),
      projectOrder: () => [], projectPersonalGroups: () => [], derivationList: () => [], worktreeStates: () => ({}) },
  });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  const user = userEvent.setup({ document: dom.window.document });
  await user.click(await slot.findByRole("button", { name: "Список" }));
  await user.click(await slot.findByRole("button", { name: "Действия с чатом: Source chat" }));
  await user.click(await slot.findByRole("menuitem", { name: "Создать форк чата" }));
  const dialog = within(await slot.findByRole("dialog", { name: "Форк чата" }));
  assert.equal(dialog.queryByRole("checkbox"), null);
  await user.click(dialog.getByRole("button", { name: "Создать форк", exact: true }));
  await waitFor(() => assert.equal(slot.inspection.sdkCalls.filter(({ method }) => method === "threads.fork").length, 1));
  const call = slot.inspection.sdkCalls.find(({ method }) => method === "threads.fork");
  assert.deepEqual(call.args[0].pluginMetadata, { ...metadata, tags: ["release"] });
  assert.deepEqual(metadata.tags, ["Test", "release"]);
  assert.equal(slot.inspection.sdkCalls.filter(({ method }) => method === "threads.updatePluginMetadata").length, 0);
});
