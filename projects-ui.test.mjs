import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { moveProject } from "./project-order.ts";

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
await build({ entryPoints: ["app.tsx"], outfile: "dist/project-ui-test.mjs", bundle: true, packages: "external", platform: "node", format: "esm", jsx: "automatic", loader: { ".css": "empty" } });
const app = await loadPluginApp(() => import("./dist/project-ui-test.mjs"));

function mount(names, options = {}) {
  sessionStorage.clear();
  localStorage.clear();
  let order = [];
  let personalGroups = options.groups ?? [];
  const projects = names.map((name, index) => ({ id: name === "Personal" ? "proj_personal" : `proj_${index}`, name, isPersonal: name === "Personal", href: "/", settingsHref: "/" }));
  const slot = renderSlot(app.navPanels[0], { subPath: "" }, {
    sidebarThreads: { status: "ready", projects, threads: options.threads ?? [] },
    sdk: {
      hosts: {
        list: async (...args) => options.hosts ? options.hosts(...args) : [{ id: "host_qa", name: "Компьютер QA", status: "connected" }],
        directory: async (input) => options.directory ? options.directory(input) : { directory: input.path, entries: [], parent: null, roots: [] },
      },
      projects: { create: options.create ?? (() => ({ id: "proj_created", name: "Новый проект" })) },
    },
    rpc: {
      issueList: () => options.issues ?? [], archiveParents: () => ({}), projectOrder: () => order,
      projectPersonalGroups: () => personalGroups,
      projectRemovalPreview: ({ projectId }) => ({ mode: options.empty ? "delete" : "personal", name: projects.find(({ id }) => id === projectId).name,
        tasks: options.issues?.filter((issue) => issue.projectId === projectId).length ?? 0, confirmation: "current" }),
      projectRemove: ({ projectId }) => {
        if (!options.empty) personalGroups = [...new Set([...personalGroups, projectId])];
        return { mode: options.empty ? "delete" : "personal" };
      },
      projectRestore: ({ projectId }) => { personalGroups = personalGroups.filter((id) => id !== projectId); return null; },
      derivationList: () => [], worktreeStates: () => ({}),
      projectMove: ({ projectId, direction, baseline }) => (order = moveProject(order.length ? order : baseline, projectId, direction)),
      projectRename: () => null,
    },
  });
  return { slot, projects, user: userEvent.setup({ document: dom.window.document }) };
}

test("create is keyboard accessible on an empty board; validates fields and cancel restores focus", async (t) => {
  const { slot, user } = mount([]);
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  const trigger = slot.getByRole("button", { name: "Создать проект" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const dialog = within(await slot.findByRole("dialog", { name: "Создать проект" }));
  const name = dialog.getByRole("textbox", { name: "Название проекта" });
  await waitFor(() => assert.ok(document.activeElement === name));
  await waitFor(() => assert.equal(dialog.getByRole("button", { name: "Создать проект" }).disabled, false));
  await user.click(dialog.getByRole("button", { name: "Создать проект" }));
  assert.ok(dialog.getByText("Введи название проекта."));
  assert.ok(dialog.getByText("Укажи папку проекта."));
  await user.type(name, "Test");
  await user.type(dialog.getByRole("textbox", { name: "Папка проекта" }), "relative/path");
  await user.click(dialog.getByRole("button", { name: "Создать проект" }));
  assert.ok(dialog.getByText("Укажи полный путь к папке на выбранном компьютере."));
  await user.keyboard("{Escape}");
  await waitFor(() => assert.ok(slot.queryByRole("dialog") === null));
  assert.equal(document.activeElement, trigger);
  assert.equal(slot.inspection.sdkCalls.filter(({ path }) => path === "projects.create").length, 0);
});

test("create preserves project and search filters on success, error and cancel, and prevents duplicates", async (t) => {
  let resolve;
  let calls = 0;
  const inputs = [];
  const { slot, user } = mount(["Первый", "Второй"], { create: (input) => {
    inputs.push(input);
    if (++calls === 1) throw new Error("Нет доступа к папке");
    return new Promise((done) => { resolve = done; });
  } });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  const filter = slot.getByRole("combobox", { name: "Проект" });
  await user.selectOptions(filter, "proj_1");
  await user.type(slot.getByRole("textbox", { name: "Найти задачу" }), "нет результатов");
  await user.click(slot.getByRole("button", { name: "Создать проект" }));
  await user.click(within(await slot.findByRole("dialog")).getByRole("button", { name: "Отмена" }));
  assert.equal(filter.value, "proj_1");
  assert.equal(calls, 0);
  await user.click(slot.getByRole("button", { name: "Создать проект" }));
  const dialog = within(await slot.findByRole("dialog"));
  await user.type(dialog.getByRole("textbox", { name: "Название проекта" }), "  Новый проект  ");
  await user.type(dialog.getByRole("textbox", { name: "Папка проекта" }), "  D:\\QA  ");
  await user.click(dialog.getByRole("button", { name: "Создать проект" }));
  await dialog.findByRole("alert");
  assert.match(dialog.getByRole("alert").textContent, /Нет доступа к папке/);
  assert.equal(filter.value, "proj_1");
  assert.equal(dialog.getByRole("textbox", { name: "Название проекта" }).value, "  Новый проект  ");
  await user.dblClick(dialog.getByRole("button", { name: "Создать проект" }));
  await user.keyboard("{Enter}{Enter}{Escape}");
  assert.ok(slot.getByRole("dialog"));
  assert.equal(dialog.getByRole("button", { name: "Создаю…" }).disabled, true);
  assert.equal(dialog.getByRole("button", { name: "Отмена" }).disabled, true);
  assert.equal(calls, 2);
  assert.deepEqual(inputs[1], { name: "Новый проект", source: { type: "local_path", hostId: "host_qa", path: "D:\\QA" } });
  resolve({ id: "proj_created", name: "Новый проект" });
  await waitFor(() => assert.ok(slot.queryByRole("dialog") === null));
  assert.equal(filter.value, "proj_1");
  assert.equal(slot.getByRole("textbox", { name: "Найти задачу" }).value, "нет результатов");
  assert.equal([...filter.options].filter(({ value }) => value === "proj_created").length, 1);
});

test("creating from all projects keeps existing chats visible and adds the new project without filtering", async (t) => {
  const { slot, user } = mount(["Первый", "Второй"], {
    threads: [chat("thr_existing", "proj_0", "Существующий чат")],
  });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await user.click(slot.getByRole("button", { name: "Список" }));
  await slot.findByText("Существующий чат");
  const filter = slot.getByRole("combobox", { name: "Проект" });
  assert.equal(filter.value, "");
  await user.click(slot.getByRole("button", { name: "Создать проект" }));
  const dialog = within(await slot.findByRole("dialog"));
  await user.type(dialog.getByRole("textbox", { name: "Название проекта" }), "Новый проект");
  await user.type(dialog.getByRole("textbox", { name: "Папка проекта" }), "D:\\QA");
  await user.click(dialog.getByRole("button", { name: "Создать проект" }));
  await waitFor(() => assert.ok(slot.queryByRole("dialog") === null));
  assert.equal(filter.value, "");
  assert.ok(slot.getByText("Существующий чат"));
  assert.ok(slot.getByRole("region", { name: "Первый" }));
  assert.ok(slot.getByRole("region", { name: "Второй" }));
  assert.ok(slot.getByRole("region", { name: "Новый проект" }));
});

test("disconnected machines and host loading errors prevent creation and offer retry", async (t) => {
  let attempts = 0;
  const { slot, user } = mount([], { hosts: () => {
    if (++attempts === 1) throw new Error("Связь потеряна");
    return [{ id: "offline", name: "QA offline", status: "disconnected" }];
  } });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await user.click(slot.getByRole("button", { name: "Создать проект" }));
  const dialog = within(await slot.findByRole("dialog"));
  assert.match((await dialog.findByRole("alert")).textContent, /Связь потеряна/);
  assert.equal(dialog.getByRole("button", { name: "Создать проект" }).disabled, true);
  await user.click(dialog.getByRole("button", { name: "Обновить компьютеры" }));
  await dialog.findByRole("status");
  assert.equal(dialog.getByRole("option", { name: "QA offline · Не в сети" }).disabled, true);
  assert.equal(dialog.getByRole("button", { name: "Создать проект" }).disabled, true);
});

test("a missing or inaccessible source folder never calls project creation", async (t) => {
  let creations = 0;
  const { slot, user } = mount(["Первый"], {
    directory: () => { throw new Error("Папка не найдена"); },
    create: () => { creations++; return { id: "unexpected", name: "Test" }; },
  });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  const filter = slot.getByRole("combobox", { name: "Проект" });
  await user.selectOptions(filter, "proj_0");
  await user.click(slot.getByRole("button", { name: "Создать проект" }));
  const dialog = within(await slot.findByRole("dialog"));
  await user.type(dialog.getByRole("textbox", { name: "Название проекта" }), "Test");
  await user.type(dialog.getByRole("textbox", { name: "Папка проекта" }), "D:\\missing");
  await user.click(dialog.getByRole("button", { name: "Создать проект" }));
  assert.match((await dialog.findByRole("alert")).textContent, /Папка не найдена/);
  assert.equal(creations, 0);
  assert.equal(filter.value, "proj_0");
  await user.click(dialog.getByRole("button", { name: "Отмена" }));
  assert.equal(filter.value, "proj_0");
});

test("project menus target the right project, close outside, and validate rename and cancellation", async (t) => {
  const { slot, user } = mount(["Первый", "Второй"]);
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await user.click(await slot.findByRole("button", { name: "Действия с проектом: Второй" }));
  await user.click(await slot.findByRole("menuitem", { name: "Переименовать" }));
  assert.equal(slot.queryByRole("menu"), null);
  const input = await slot.findByRole("textbox", { name: "Название проекта" });
  assert.equal(input.value, "Второй");
  await user.clear(input);
  await user.type(input, "   ");
  assert.equal(slot.getByRole("button", { name: "Сохранить" }).disabled, true);
  await user.click(slot.getByRole("button", { name: "Отмена" }));
  assert.equal(slot.inspection.rpcCalls.filter(({ method }) => method === "projectRename").length, 0);
  await user.click(slot.getByRole("button", { name: "Действия с проектом: Второй" }));
  await user.click(await slot.findByRole("menuitem", { name: "Переименовать" }));
  const restored = await slot.findByRole("textbox", { name: "Название проекта" });
  assert.equal(restored.value, "Второй");
  await user.clear(restored);
  await user.type(restored, "Новое имя");
  await user.click(slot.getByRole("button", { name: "Сохранить" }));
  await waitFor(() => assert.equal(slot.queryByRole("dialog"), null));
  const rename = slot.inspection.rpcCalls.find(({ method }) => method === "projectRename");
  assert.deepEqual(rename.input, { projectId: "proj_1", name: "Новое имя" });
  await user.click(slot.getByRole("button", { name: "Действия с проектом: Первый" }));
  await slot.findByRole("menu");
  await user.click(slot.getByRole("heading", { name: "Задачи" }));
  await waitFor(() => assert.equal(slot.queryByRole("menu"), null));
});

test("movement respects boundaries and updates headings without moving cards", async (t) => {
  const { slot, user } = mount(["Первый", "Второй"]);
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await waitFor(() => assert.ok(slot.inspection.rpcCalls.some(({ method }) => method === "projectOrder")));
  await user.click(slot.getByRole("button", { name: "Действия с проектом: Первый" }));
  assert.equal((await slot.findByRole("menuitem", { name: "Поднять выше" })).getAttribute("aria-disabled"), "true");
  await user.click(slot.getByRole("menuitem", { name: "Опустить ниже" }));
  await waitFor(() => assert.deepEqual([...slot.container.querySelectorAll(".kb-project")].map((node) => node.getAttribute("aria-label")), ["Второй", "Первый"]));
  await user.click(slot.getByRole("button", { name: "Действия с проектом: Первый" }));
  assert.equal((await slot.findByRole("menuitem", { name: "Опустить ниже" })).getAttribute("aria-disabled"), "true");
  await user.click(slot.getByRole("menuitem", { name: "Поднять выше" }));
  await waitFor(() => assert.deepEqual([...slot.container.querySelectorAll(".kb-project")].map((node) => node.getAttribute("aria-label")), ["Первый", "Второй"]));
  assert.equal(slot.inspection.rpcCalls.filter(({ method }) => method === "issueMove").length, 0);
});

test("single project cannot move; cancelling removal preserves the project", async (t) => {
  const { slot, user } = mount(["Единственный"]);
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await user.click(await slot.findByRole("button", { name: "Действия с проектом: Единственный" }));
  for (const name of ["Поднять выше", "Опустить ниже"]) {
    assert.equal((await slot.findByRole("menuitem", { name })).getAttribute("aria-disabled"), "true");
  }
  await user.click(slot.getByRole("menuitem", { name: "Убрать проект…" }));
  await slot.findByText("Убрать проект в Personal?");
  assert.match(slot.getByRole("dialog").textContent, /Единственный.*Personal/s);
  await user.click(slot.getByRole("button", { name: "Отмена" }));
  assert.equal(slot.queryByRole("dialog"), null);
  assert.equal(slot.inspection.rpcCalls.some(({ method }) => method === "projectRemove"), false);
});

const issue = (id, projectId, title) => ({ id, projectId, title, description: "", notes: "", status: "todo", threadIds: [],
  parentId: null, blockedBy: [], related: [], duplicateOf: null, autoTitle: false, autoPlan: false,
  assignee: "", priority: null, tags: ["Test"], messages: [], busy: null, error: null,
  order: 0, version: 0, createdAt: 0, updatedAt: 0 });
const chat = (id, projectId, displayTitle, overrides = {}) => ({ id, projectId, displayTitle, parentThreadId: null,
  updatedAt: 0, createdAt: 0, status: "idle", runtimeStatus: "idle", queuedWork: "none", activity: {},
  isHidden: false, isArchived: false, environment: null, ...overrides });

test("removing a project groups tasks and chats in Personal, preserves filters, and restores the original group", async (t) => {
  const { slot, user } = mount(["Первый", "Второй", "Personal"], {
    issues: [issue("task_a", "proj_0", "Задача источника"), issue("task_p", "proj_personal", "Личная задача")],
    threads: [chat("thr_first", "proj_0", "Чат источника"), chat("thr_other", "proj_1", "Другой чат")],
  });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await user.click(slot.getByRole("button", { name: "Список" }));
  await user.selectOptions(slot.getByRole("combobox", { name: "Проект" }), "proj_0");
  await user.click(slot.getByRole("button", { name: "Действия с проектом: Первый" }));
  await user.click(await slot.findByRole("menuitem", { name: "Убрать проект…" }));
  await slot.findByText("Убрать проект в Personal?");
  await user.click(slot.getByRole("button", { name: "Убрать в Personal" }));
  await waitFor(() => assert.equal(slot.queryByRole("button", { name: "Действия с проектом: Первый" }), null));
  assert.equal(slot.getByRole("combobox", { name: "Проект" }).value, "proj_personal");
  const personal = within(slot.getByRole("region", { name: "Personal" }));
  assert.ok(personal.getByRole("button", { name: "Открыть: Задача источника" }));
  assert.ok(personal.getByRole("button", { name: "Открыть: Личная задача" }));
  assert.ok(personal.getByRole("button", { name: "Открыть: Чат источника" }));
  assert.equal(slot.queryByRole("button", { name: "Открыть: Другой чат" }), null);
  await user.click(slot.getByRole("button", { name: "Действия с проектом: Personal" }));
  await user.click(await slot.findByRole("menuitem", { name: "Вернуть проект в канбан…" }));
  assert.equal(slot.getByRole("combobox", { name: "Проект для возврата" }).value, "proj_0");
  await user.click(slot.getByRole("button", { name: "Вернуть проект" }));
  await waitFor(() => assert.equal(slot.queryByRole("dialog"), null));
  await user.selectOptions(slot.getByRole("combobox", { name: "Проект" }), "");
  await slot.findByRole("button", { name: "Действия с проектом: Первый" });
  const original = within(slot.getByRole("region", { name: "Первый" }));
  assert.ok(original.getByRole("button", { name: "Открыть: Задача источника" }));
  assert.ok(original.getByRole("button", { name: "Открыть: Чат источника" }));
});

test("empty-project confirmation explicitly offers native deletion and preserves tasks in Personal", async (t) => {
  const { slot, user } = mount(["Пустой"], { empty: true, issues: [issue("remaining", "proj_0", "Задача без чата")] });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await user.click(await slot.findByRole("button", { name: "Действия с проектом: Пустой" }));
  await user.click(await slot.findByRole("menuitem", { name: "Убрать проект…" }));
  await slot.findByText("Удалить проект?");
  assert.match(slot.getByRole("dialog").textContent, /задачи \(1\) сохранятся в Personal/);
  await user.click(slot.getByRole("button", { name: "Удалить проект" }));
  await waitFor(() => assert.equal(slot.queryByRole("dialog"), null));
  assert.deepEqual(slot.inspection.rpcCalls.find(({ method }) => method === "projectRemove").input, { projectId: "proj_0", confirmation: "current" });
});
