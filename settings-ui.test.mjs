import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { build } from "esbuild";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "localStorage"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { waitFor, cleanup } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
await build({ entryPoints: ["settings-ui.tsx"], outfile: "dist/settings-ui-test.mjs", bundle: true,
  packages: "external", platform: "node", format: "esm", jsx: "automatic", loader: { ".css": "empty" } });
const { KanbanSettings } = await import("./dist/settings-ui-test.mjs");

test("integrated settings save panel placement, headers and execution preferences without another plugin", async t => {
  let preference = { providerId: "codex", model: "test-model", reasoningLevel: "high", serviceTier: "default" };
  let placement = "right", headers = { top: false, bottom: true };
  const slot = renderSlot({ component: KanbanSettings }, {}, {
    rpc: {
      read: () => preference, save: value => { preference = value; return value; },
      readWindowPlacement: () => placement, saveWindowPlacement: value => { placement = value; return value; },
      readPaneHeaders: () => headers, savePaneHeaders: value => { headers = value; return value; },
    },
    sdk: { providers: { models: async () => ({
      providers: [{ id: "codex", available: true, capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "fast", label: "Fast" }] }],
      models: [{ id: "test-model", model: "test-model", displayName: "Test model", isDefault: true, defaultReasoningEffort: "high",
        supportedReasoningEfforts: ["low", "high"].map(reasoningEffort => ({ reasoningEffort })), supportedServiceTiers: [{ id: "fast" }] }],
    }) } },
  });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  const user = userEvent.setup({ document: dom.window.document });
  const select = await slot.findByRole("combobox", { name: "Расположение открываемых окон" });
  await waitFor(() => assert.equal(select.disabled, false));
  await user.selectOptions(select, "above");
  await waitFor(() => assert.equal(placement, "above"));
  await user.click(slot.getByRole("checkbox", { name: "Шапка верхней панели справа" }));
  await waitFor(() => assert.deepEqual(headers, { top: true, bottom: true }));
  const effort = await slot.findByRole("combobox", { name: "Уровень усилия по умолчанию" });
  await waitFor(() => assert.equal(effort.disabled, false));
  await user.selectOptions(effort, "low");
  await user.selectOptions(slot.getByRole("combobox", { name: "Скорость по умолчанию" }), "fast");
  await user.click(slot.getByRole("button", { name: "Сохранить", exact: true }));
  await waitFor(() => assert.deepEqual(preference, { providerId: "codex", model: "test-model", reasoningLevel: "low", serviceTier: "fast" }));
  assert.equal(slot.queryByRole("button", { name: "Синхронизировать с main" }), null);
});

test("a settings read failure offers retry and does not enable a speculative selection", async t => {
  let fail = true;
  const slot = renderSlot({ component: KanbanSettings }, {}, { rpc: {
    read: () => { if (fail) throw new Error("Unavailable"); return null; },
    readWindowPlacement: () => "right", readPaneHeaders: () => ({ top: false, bottom: true }),
  }, sdk: { providers: { models: async () => ({ providers: [], models: [] }) } } });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await slot.findByRole("alert", { name: "" });
  const user = userEvent.setup({ document: dom.window.document });
  fail = false;
  await user.click(slot.getByRole("button", { name: "Повторить", exact: true }));
  await slot.findByRole("combobox", { name: "Модель по умолчанию" });
  assert.equal(slot.inspection.rpcCalls.filter(({ method }) => method === "save").length, 0);
});
