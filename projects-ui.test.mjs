import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { moveProject } from "./project-order.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "getComputedStyle", "localStorage", "sessionStorage"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { default: userEvent } = await import("@testing-library/user-event");
const { waitFor, cleanup, within, fireEvent } = await import("@testing-library/react");
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
      projects: { create: options.create ?? (() => ({ id: "proj_created", name: "Новый раздел" })) },
    },
    rpc: {
      folderList: () => options.folders ?? [], folderMaterials: () => [],
      folderRead: ({ id }) => ({ ...options.folders.find((folder) => folder.id === id), messagesTotal: 0, nextMessageOffset: null }),
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
      ...options.rpc,
    },
  });
  return { slot, projects, user: userEvent.setup({ document: dom.window.document }) };
}

test("create is keyboard accessible on an empty board; validates fields and cancel restores focus", async (t) => {
  const { slot, user } = mount([]);
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  const trigger = slot.getByRole("button", { name: "Создать раздел" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const dialog = within(await slot.findByRole("dialog", { name: "Создать раздел" }));
  const name = dialog.getByRole("textbox", { name: "Название раздела" });
  await waitFor(() => assert.ok(document.activeElement === name));
  await waitFor(() => assert.equal(dialog.getByRole("button", { name: "Создать раздел" }).disabled, false));
  await user.click(dialog.getByRole("button", { name: "Создать раздел" }));
  assert.ok(dialog.getByText("Введи название раздела."));
  assert.ok(dialog.getByText("Укажи папку раздела."));
  await user.type(name, "Test");
  await user.type(dialog.getByRole("textbox", { name: "Папка раздела" }), "relative/path");
  await user.click(dialog.getByRole("button", { name: "Создать раздел" }));
  assert.ok(dialog.getByText("Укажи полный путь к папке на выбранном компьютере."));
  await user.keyboard("{Escape}");
  await waitFor(() => assert.ok(slot.queryByRole("dialog") === null));
  assert.equal(document.activeElement, trigger);
  assert.equal(slot.inspection.sdkCalls.filter(({ path }) => path === "projects.create").length, 0);
});

const folderFixture = (id, overrides = {}) => ({ id, sectionId: 'proj_0', name: 'Проект Сапфир', createdAt: 1000, updatedAt: 1000,
  version: 1, elapsedMs: 65000, activeSince: null, count: 2, activeCount: 1, messages: [], assistant: null, error: null, ...overrides });

test('project folder occupies one card, expands without duplicates, preserves member stages and filters, and separates material actions', async (t) => {
  const folders = [folderFixture('folder-a')];
  const issues = [{ ...issue('a', 'proj_0', 'Активная карточка'), folderId: 'folder-a' },
    { ...issue('b', 'proj_0', 'Готовая карточка'), folderId: 'folder-a', status: 'done' }, issue('c', 'proj_0', 'Отдельная карточка')];
  const { slot, user } = mount(['Infrastructure'], { folders, issues });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await user.click(slot.getByRole('button', { name: 'Список' }));
  await slot.findByRole('button', { name: 'Развернуть проект Проект Сапфир' });
  const ids = () => [...slot.container.querySelectorAll('[data-kanban-card-id]')].map((node) => node.getAttribute('data-kanban-card-id'));
  assert.deepEqual(ids().sort(), ['c', 'folder-a']);
  await user.click(slot.getByRole('button', { name: 'Развернуть проект Проект Сапфир' }));
  assert.deepEqual(ids().sort(), ['a','b','c','folder-a']);
  assert.equal(slot.container.querySelector('[data-kanban-card-id="b"]').getAttribute('data-kanban-stage'), 'done');
  await user.click(slot.getByRole('button', { name: 'Действия с проектом: Проект Сапфир' }));
  await user.click(slot.getByRole('menuitem', { name: 'Материалы', exact: true }));
  await slot.findByRole('dialog', { name: 'Проект · Проект Сапфир' });
  assert.equal(slot.getByRole('tab', { name: 'Материалы' }).getAttribute('aria-selected'), 'true');
  assert.ok(slot.getByRole('button', { name: 'Добавить заметку' }));
  await user.keyboard('{Escape}');
  assert.ok(slot.getByRole('button', { name: 'Свернуть проект Проект Сапфир' }));
  await user.type(slot.getByRole('textbox', { name: 'Найти задачу' }), 'Активная');
  await waitFor(() => assert.deepEqual(ids().sort(), ['a', 'folder-a']));
  assert.equal(issues[1].status, 'done');
  await user.click(slot.getByRole('button', { name: 'Свернуть проект Проект Сапфир' }));
  assert.deepEqual(ids(), ['folder-a']);
});

test('project disclosure, counts, empty states, keyboard menu and drop feedback remain independent', async (t) => {
  let assigned = null;
  const folders = [folderFixture('empty', { count: 0, activeCount: 0 }), folderFixture('filtered', { name: 'Отфильтрованный проект', count: 3 })];
  const issues = [issue('move-me', 'proj_0', 'Отдельная задача')];
  const { slot, user } = mount(['Infrastructure'], { folders, issues, rpc: { folderRelocate: input => { assigned = input; return { moved: 1, undoToken: 'undo-test' }; } } });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await user.click(slot.getByRole('button', { name: 'Список' }));
  const toggle = await slot.findByRole('button', { name: 'Развернуть проект Проект Сапфир' });
  toggle.focus(); await user.keyboard('{Enter}');
  const group = slot.container.querySelector('[data-project-folder-id="empty"]');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(document.getElementById(toggle.getAttribute('aria-controls')).contains(slot.getByText('Пока нет карточек')));
  assert.ok(within(group).getByLabelText('Показано карточек: 0. Всего в проекте: 0'));
  const trigger = within(group).getByRole('button', { name: 'Действия с проектом: Проект Сапфир' });
  trigger.focus(); await user.keyboard('{Enter}');
  assert.ok(slot.getByRole('menuitem', { name: 'Помощник', exact: true }));
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  await user.keyboard('{Escape}');
  assert.equal(document.activeElement, trigger);
  const drag = { types: ['application/x-bb-kanban-issue'], getData: () => 'move-me', setData: () => {}, setDragImage() {} };
  const source = slot.container.querySelector('[data-kanban-card-id="move-me"]');
  fireEvent.dragStart(source, { dataTransfer: drag });
  fireEvent.dragOver(group, { dataTransfer: drag });
  assert.equal(group.dataset.dropTarget, 'true');
  assert.ok(within(group).getByRole('status'));
  // JSDOM has no DragEvent constructor; supply the native relatedTarget field.
  const leave = new dom.window.Event('dragleave', { bubbles: true });
  Object.defineProperty(leave, 'relatedTarget', { value: toggle });
  fireEvent(group, leave);
  assert.equal(group.dataset.dropTarget, 'true');
  fireEvent.drop(group, { dataTransfer: drag });
  await waitFor(() => assert.deepEqual(assigned, { cards: [{ id: 'move-me', version: issues[0].version }], folderId: 'empty', atEnd: true, positionScope: 'project' }));
  assert.equal(group.dataset.dropTarget, 'false');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  fireEvent.dragStart(source, { dataTransfer: drag });
  fireEvent.dragOver(group, { dataTransfer: drag });
  fireEvent.dragEnd(window);
  assert.equal(group.dataset.dropTarget, 'false');
  fireEvent.dragOver(group, { dataTransfer: { types: ['text/plain'] } });
  assert.equal(group.dataset.dropTarget, 'false');
  await user.click(slot.getByRole('button', { name: 'Развернуть проект Отфильтрованный проект' }));
  assert.ok(slot.getByText('Нет карточек по текущим фильтрам'));
  assert.ok(slot.getByLabelText('Показано карточек: 0. Всего в проекте: 3'));
  assert.equal(slot.inspection.rpcCalls.some(({ method }) => ['issueMove', 'issueCreate'].includes(method)), false);
});

function moveRpc(issues, folders, calls) {
  return input => {
    calls.push(structuredClone(input));
    for (const card of input.cards) {
      const current = issues.find(issue => issue.id === card.id);
      assert.equal(current.version, card.version);
      if (input.folderId !== undefined) current.folderId = input.folderId;
      if (input.status) current.status = input.status;
      current.version++;
    }
    for (const folder of folders) { const members = issues.filter(issue => issue.folderId === folder.id); folder.count = members.length; folder.activeCount = members.filter(issue => issue.status !== 'done').length; }
    return { moved: input.cards.length, undoToken: 'move-undo' };
  };
}

test('project drops preserve stage, column drops preserve project, and extraction is explicit', async t => {
  const width = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });
  const folders = [folderFixture('a', { name: 'Альфа', count: 0 }), folderFixture('b', { name: 'Бета', count: 1 })];
  const issues = [{ ...issue('source', 'proj_0', 'Переносимая'), status: 'backlog' }, { ...issue('target', 'proj_0', 'Назначение'), folderId: 'b' }, issue('foreign', 'proj_1', 'Чужой раздел')];
  const calls = [];
  const { slot, user } = mount(['Infrastructure', 'Other'], { folders, issues, rpc: { folderRelocate: moveRpc(issues, folders, calls) } });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); width ? Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', width) : delete dom.window.HTMLElement.prototype.clientWidth; });
  await user.click(await slot.findByRole('button', { name: 'Развернуть проект Бета · К выполнению' }));
  const node = id => slot.container.querySelector(`[data-kanban-card-id="${id}"]`);
  let preview;
  const drag = id => ({ types: ['application/x-bb-kanban-issue'], setData() {}, setDragImage(node) { preview = node; }, getData: () => id });
  const title = node('source').querySelector('.kb-card-title');
  assert.equal(title.draggable, true);
  fireEvent.dragStart(title, { dataTransfer: drag('source') });
  assert.equal(preview, node('source'));
  fireEvent.dragOver(node('target'), { dataTransfer: drag('source') });
  assert.equal(node('target').dataset.dropState, 'allowed');
  assert.equal(node('target').closest('.kb-folder').dataset.dropState, undefined);
  fireEvent.drop(node('target'), { dataTransfer: drag('source') });
  await waitFor(() => assert.equal(node('source')?.closest('.kb-folder')?.dataset.projectFolderId, 'b'));
  assert.deepEqual(calls[0], { cards: [{ id: 'source', version: 0 }], folderId: 'b', atEnd: true, positionScope: 'project' });
  assert.equal(issues[0].status, 'backlog');
  const zone = slot.container.querySelector('[aria-label="Infrastructure · К выполнению"] .kb-ungroup-drop');
  fireEvent.dragStart(node('source'), { dataTransfer: drag('source') }); fireEvent.drop(zone, { dataTransfer: drag('source') });
  await waitFor(() => assert.equal(issues[0].folderId, null));
  assert.equal(issues[0].status, 'backlog');
  // An empty project is shown in backlog, but that is not its members' stage.
  const empty = slot.container.querySelector('[data-project-folder-id="a"]');
  fireEvent.dragStart(node('target'), { dataTransfer: drag('target') }); fireEvent.drop(empty, { dataTransfer: drag('target') });
  await waitFor(() => assert.equal(node('target')?.closest('.kb-folder')?.dataset.projectFolderId, 'a'));
  assert.equal(issues[1].status, 'todo');
  assert.equal(node('target').closest('.kb-folder').dataset.expanded, 'true');
  assert.deepEqual(calls[2], { cards: [{ id: 'target', version: 0 }], folderId: 'a', atEnd: true, positionScope: 'project' });
  // The free part of another column changes stage without removing membership.
  const review = slot.container.querySelector('[aria-label="Infrastructure · На проверке"]');
  fireEvent.dragStart(node('target'), { dataTransfer: drag('target') }); fireEvent.drop(review, { dataTransfer: drag('target') });
  await waitFor(() => assert.equal(node('target')?.dataset.kanbanStage, 'review'));
  assert.equal(issues[1].folderId, 'a');
  assert.deepEqual(calls[3], { cards: [{ id: 'target', version: 1 }], status: 'review', atEnd: true });
  const heading = slot.getByRole('button', { name: /Свернуть колонку «Завершён»/ });
  fireEvent.dragStart(node('target'), { dataTransfer: drag('target') }); fireEvent.drop(heading, { dataTransfer: drag('target') });
  await waitFor(() => assert.equal(node('target')?.dataset.kanbanStage, 'done'));
  assert.equal(issues[1].folderId, 'a');
  assert.equal(node('target').closest('.kb-folder').dataset.expanded, 'true');
  const count = calls.length;
  fireEvent.dragStart(node('foreign'), { dataTransfer: drag('foreign') }); fireEvent.dragOver(node('target'), { dataTransfer: drag('foreign') });
  assert.equal(node('target').dataset.dropState, 'forbidden');
  fireEvent.drop(node('target'), { dataTransfer: drag('foreign') }); assert.equal(calls.length, count);
  fireEvent.dragStart(node('target'), { dataTransfer: drag('target') }); fireEvent.drop(node('target'), { dataTransfer: drag('target') }); assert.equal(calls.length, count);
});

test('card menu moves project and stage in one dialog; cancellation keeps the card unchanged', async t => {
  const folders = [folderFixture('a'), folderFixture('b', { name: 'Бета', count: 0 })];
  const issues = [{ ...issue('card', 'proj_0', 'Карточка для меню'), folderId: 'a' }]; const calls = [];
  const { slot, user } = mount(['Infrastructure'], { folders, issues, rpc: { folderRelocate: moveRpc(issues, folders, calls) } });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await user.click(slot.getByRole('button', { name: 'Список' }));
  await user.click(await slot.findByRole('button', { name: 'Развернуть проект Проект Сапфир' }));
  const menu = () => user.click(slot.getByRole('button', { name: 'Действия с задачей: Карточка для меню' }));
  await menu(); await user.click(slot.getByRole('menuitem', { name: 'Переместить…' }));
  await slot.findByRole('dialog', { name: 'Переместить карточку' });
  await user.selectOptions(slot.getByRole('combobox', { name: 'Проект назначения' }), 'b');
  await user.click(slot.getByRole('button', { name: 'Отмена', exact: true })); assert.equal(calls.length, 0);
  await waitFor(() => assert.equal(document.activeElement, slot.getByRole('button', { name: 'Действия с задачей: Карточка для меню' })));
  await menu(); await user.click(slot.getByRole('menuitem', { name: 'Переместить…' }));
  await user.selectOptions(slot.getByRole('combobox', { name: 'Проект назначения' }), 'b');
  await user.selectOptions(slot.getByRole('combobox', { name: 'Этап назначения' }), 'review');
  await user.click(slot.getByRole('button', { name: 'Переместить', exact: true }));
  await waitFor(() => assert.deepEqual(calls[0], { cards: [{ id: 'card', version: 0 }], folderId: 'b', status: 'review' }));
});

test('project cards separate members from searchable additions, batch add without changing stages, and keep card actions available', async t => {
  const folders = [folderFixture('a', { count: 1 }), folderFixture('b', { name: 'Бета', count: 1 })];
  const issues = [{ ...issue('member', 'proj_0', 'Участник проекта'), folderId: 'a' },
    issue('extra', 'proj_0', 'Добавить активную'), { ...issue('done', 'proj_0', 'Добавить готовую'), status: 'done', folderId: 'b' }];
  const calls = []; let undos = 0;
  const { slot, user } = mount(['Infrastructure'], { folders, issues, rpc: { folderRelocate: moveRpc(issues, folders, calls), folderUndoMove: ({ token }) => {
    assert.equal(token, 'move-undo'); undos++; issues[1].folderId = null; issues[2].folderId = 'b'; folders[0].count = 1; folders[1].count = 1;
    return { restored: 2 };
  } } });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await user.click(slot.getByRole('button', { name: 'Список' }));
  await user.click((await slot.findAllByRole('button', { name: 'Действия с проектом: Проект Сапфир' }))[0]);
  await user.click(slot.getByRole('menuitem', { name: 'Добавить существующие…' }));
  const dialog = within(await slot.findByRole('dialog', { name: 'Проект · Проект Сапфир' }));
  assert.equal(dialog.queryByRole('checkbox', { name: 'Выбрать карточку: Участник проекта' }), null);
  await user.type(dialog.getByRole('searchbox', { name: 'Найти карточки для добавления' }), 'Добавить');
  await user.click(dialog.getByRole('button', { name: 'Выбрать показанные' }));
  await user.click(dialog.getByRole('button', { name: 'Добавить в проект', exact: true }));
  await waitFor(() => assert.equal(dialog.getAllByRole('checkbox').length, 3));
  assert.deepEqual(calls[0], { cards: [{ id: 'extra', version: 0 }, { id: 'done', version: 0 }], folderId: 'a' });
  assert.equal(issues[2].status, 'done');
  assert.ok(dialog.getByRole('combobox', { name: 'Этап карточки: Добавить готовую' }));
  await user.click(dialog.getByRole('tab', { name: 'Материалы' }));
  await user.click(dialog.getByRole('button', { name: 'Отменить перенос' }));
  await waitFor(() => assert.equal(undos, 1));
  await user.click(dialog.getByRole('tab', { name: 'Карточки' }));
  await waitFor(() => assert.equal(dialog.getAllByRole('checkbox').length, 1));
  await user.click(dialog.getByRole('button', { name: 'Участник проекта', exact: true }));
  await waitFor(() => assert.equal(slot.queryByRole('dialog'), null));
  assert.equal(slot.inspection.sdkCalls.some(call => call.path === 'threads.spawn'), false);
});

test('rename shortcut focuses the name and project tabs support arrows, Home and End', async t => {
  const { slot, user } = mount(['Infrastructure'], { folders: [folderFixture('a', { count: 0 })] });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await user.click((await slot.findAllByRole('button', { name: 'Действия с проектом: Проект Сапфир' }))[0]);
  await user.click(slot.getByRole('menuitem', { name: 'Переименовать…' }));
  const input = await slot.findByRole('textbox', { name: 'Новое название проекта' });
  await waitFor(() => assert.equal(document.activeElement, input));
  assert.equal(input.selectionEnd, 'Проект Сапфир'.length);
  await user.click(slot.getByRole('tab', { name: 'Материалы' })); await user.keyboard('{ArrowRight}');
  assert.equal(slot.getByRole('tab', { name: 'Карточки' }).getAttribute('aria-selected'), 'true');
  await user.keyboard('{Home}'); assert.equal(slot.getByRole('tab', { name: 'Помощник' }).getAttribute('aria-selected'), 'true');
  await user.keyboard('{End}'); assert.equal(slot.getByRole('tab', { name: 'Карточки' }).getAttribute('aria-selected'), 'true');
  assert.equal(slot.getByRole('tabpanel').getAttribute('aria-labelledby'), slot.getByRole('tab', { name: 'Карточки' }).id);
});

test('compact project and transfer drawers return keyboard focus after their owner unmounts', async t => {
  const matchMedia = window.matchMedia;
  window.matchMedia = query => ({ media: query, matches: query === '(max-width: 767px)', addEventListener() {}, removeEventListener() {} });
  const folders = [folderFixture('a', { count: 1 })];
  const issues = [{ ...issue('member', 'proj_0', 'Карточка в узком окне'), folderId: 'a' }];
  const { slot, user } = mount(['Infrastructure'], { folders, issues });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); window.matchMedia = matchMedia; });
  await user.click(slot.getByRole('button', { name: 'Список' }));
  const trigger = await slot.findByRole('button', { name: 'Действия с проектом: Проект Сапфир' });
  await user.click(trigger); await user.click(slot.getByRole('menuitem', { name: 'Добавить существующие…' }));
  await slot.findByRole('dialog', { name: 'Проект · Проект Сапфир' });
  await user.keyboard('{Escape}');
  await waitFor(() => assert.equal(document.activeElement, trigger));
  await user.click(slot.getByRole('button', { name: 'Развернуть проект Проект Сапфир' }));
  const cardTrigger = slot.getByRole('button', { name: 'Действия с задачей: Карточка в узком окне' });
  await user.click(cardTrigger); await user.click(slot.getByRole('menuitem', { name: 'Переместить…' }));
  await slot.findByRole('dialog', { name: 'Переместить карточку' });
  await user.keyboard('{Escape}');
  await waitFor(() => assert.equal(document.activeElement, cardTrigger));
});

test('a native chat can be explicitly wrapped in a project card without starting or replacing its conversation', async t => {
  let created;
  const folders = [folderFixture('a', { count: 0 })];
  const threads = [chat('thr_legacy', 'proj_0', 'Существующий чат')];
  const { slot, user } = mount(['Infrastructure'], { folders, threads, rpc: { issueCreate: input => {
    created = input; return { ...issue('wrapper', 'proj_0', 'Существующий чат'), folderId: input.folderId, status: input.status, threadIds: [input.threadId] };
  } } });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await user.click(slot.getByRole('button', { name: 'Список' }));
  const card = await waitFor(() => { const node = slot.container.querySelector('[data-kanban-card-id="thr_legacy"]'); assert.ok(node); return node; });
  const stage = card.dataset.kanbanStage;
  await user.click(within(card).getByRole('button', { name: /Действия/ }));
  await user.click(slot.getByRole('menuitem', { name: 'Добавить в проект…' }));
  await slot.findByRole('dialog', { name: 'Добавить чат в проект' });
  await user.selectOptions(slot.getByRole('combobox', { name: 'Проект для чата' }), 'a');
  await user.click(slot.getByRole('button', { name: 'Создать карточку в проекте', exact: true }));
  await waitFor(() => assert.deepEqual(created, { projectId: 'proj_0', status: stage, test: false, threadId: 'thr_legacy', folderId: 'a' }));
  assert.equal(slot.inspection.sdkCalls.some(call => call.path === 'threads.spawn'), false);
});

test('failed card creation keeps the original dialog and stage available for retry', async t => {
  let attempts = 0;
  const { slot, user } = mount(['Infrastructure'], { rpc: { issueCreate: () => { attempts++; throw Error('Нет соединения'); } } });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await user.click(slot.getByRole('button', { name: 'Создать задачу или проект' }));
  await user.selectOptions(slot.getByRole('combobox', { name: 'Этап новой задачи' }), 'todo');
  await user.click(slot.getByRole('button', { name: 'Создать', exact: true }));
  await waitFor(() => assert.equal(attempts, 1));
  assert.ok(slot.getByRole('dialog', { name: 'Создать в разделе' }));
  assert.equal(slot.getByRole('combobox', { name: 'Этап новой задачи' }).value, 'todo');
  assert.equal(slot.getByRole('button', { name: 'Создать', exact: true }).disabled, false);
});

test('shared create control creates a folder and opens its own assistant without creating a task or chat', async (t) => {
  const folders = [];
  let created = null;
  const { slot, user } = mount(['Infrastructure'], { folders, rpc: {
    folderCreate: (input) => { created = input; const result = folderFixture('new-folder', { name: input.name, count: 0, activeCount: 0 }); folders.push(result); return result; },
  } });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await user.click(slot.getByRole('button', { name: 'Создать задачу или проект' }));
  await user.selectOptions(slot.getByRole('combobox', { name: 'Тип новой карточки' }), 'project');
  await user.type(slot.getByRole('textbox', { name: 'Название проекта' }), 'Новая папка');
  await user.click(slot.getByRole('button', { name: 'Создать', exact: true }));
  await slot.findByRole('dialog', { name: 'Проект · Новая папка' });
  assert.deepEqual(created, { sectionId: 'proj_0', name: 'Новая папка' });
  assert.equal(slot.inspection.rpcCalls.some(({ method }) => method === 'issueCreate'), false);
});

test('each board stage groups multiple cards from one project without moving or duplicating them', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });
  const folders = [folderFixture('folder-stage', { count: 4, activeCount: 2 })];
  const issues = [
    { ...issue('todo-a', 'proj_0', 'Первая активная'), folderId: 'folder-stage' },
    { ...issue('todo-b', 'proj_0', 'Вторая активная'), folderId: 'folder-stage' },
    { ...issue('done-a', 'proj_0', 'Первая завершённая'), folderId: 'folder-stage', status: 'done' },
    { ...issue('done-b', 'proj_0', 'Вторая завершённая'), folderId: 'folder-stage', status: 'done' },
  ];
  const { slot, user } = mount(['Infrastructure'], { folders, issues });
  t.after(() => {
    slot.lifecycle.unmount(); cleanup();
    if (descriptor) Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', descriptor);
    else delete dom.window.HTMLElement.prototype.clientWidth;
  });
  await slot.findByRole('button', { name: 'Развернуть проект Проект Сапфир · К выполнению' });
  const group = (stage) => slot.container.querySelector(`[data-kanban-card-id="folder-stage:${stage}"]`);
  assert.equal(slot.container.querySelectorAll('[data-kanban-kind="project"]').length, 2);
  assert.equal(slot.container.querySelectorAll('[data-kanban-kind="issue"]').length, 0);
  await user.click(slot.getByRole('button', { name: 'Развернуть проект Проект Сапфир · К выполнению' }));
  assert.deepEqual([...group('todo').querySelectorAll('[data-kanban-kind="issue"]')].map(e=>e.dataset.kanbanCardId).sort(), ['todo-a','todo-b']);
  assert.equal(group('done').querySelectorAll('[data-kanban-kind="issue"]').length, 0);
  await user.click(slot.getByRole('button', { name: 'Развернуть проект Проект Сапфир · Завершён' }));
  assert.deepEqual([...group('done').querySelectorAll('[data-kanban-kind="issue"]')].map(e=>e.dataset.kanbanCardId).sort(), ['done-a','done-b']);
  assert.equal(new Set([...slot.container.querySelectorAll('[data-kanban-kind="issue"]')].map(e=>e.dataset.kanbanCardId)).size, 4);
  assert.ok(issues.filter(issue=>issue.id.startsWith('done')).every(issue=>issue.status==='done'));
  assert.equal(slot.inspection.rpcCalls.some(({ method }) => method === 'issueMove'), false);
});

test('nonempty project deletion confirms preserved cards and returns them visibly to their existing stages', async (t) => {
  const width = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });
  const folders = [folderFixture('delete-folder')];
  const issues = [{ ...issue('keep-todo', 'proj_0', 'Оставить активную'), folderId: 'delete-folder' },
    { ...issue('keep-done', 'proj_0', 'Оставить завершённую'), folderId: 'delete-folder', status: 'done' }];
  let deletes = 0;
  const { slot, user } = mount(['Infrastructure'], { folders, issues, rpc: {
    folderDelete: ({ id, version }) => {
      assert.equal(id, 'delete-folder'); assert.equal(version, 1); deletes++;
      for (const card of issues) { card.folderId = null; card.version++; }
      folders.splice(0, 1); return { deleted: true };
    },
  } });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); if (width) Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', width); else delete dom.window.HTMLElement.prototype.clientWidth; });
  await user.click((await slot.findAllByRole('button', { name: 'Действия с проектом: Проект Сапфир' }))[0]);
  await user.click(slot.getByRole('menuitem', { name: 'Удалить проект…' }));
  assert.equal(slot.getByRole('tab', { name: 'Карточки' }).getAttribute('aria-selected'), 'true');
  assert.ok(slot.getByText(/Карточки \(2\) останутся в разделе на своих этапах/));
  await user.click(slot.getByRole('button', { name: 'Отмена удаления' }));
  assert.equal(deletes, 0);
  await user.click(slot.getByRole('button', { name: 'Удалить проект…' }));
  await user.click(slot.getByRole('button', { name: 'Удалить проект, сохранив карточки' }));
  await waitFor(() => assert.equal(slot.queryByRole('dialog'), null));
  await slot.behavior.emitRealtime('issues-changed', null);
  await slot.behavior.emitRealtime('project-folders-changed', null);
  await waitFor(() => {
    assert.equal(slot.container.querySelectorAll('[data-kanban-kind="project"]').length, 0);
    assert.equal(slot.container.querySelector('[data-kanban-card-id="keep-todo"]')?.dataset.kanbanStage, 'todo');
    assert.equal(slot.container.querySelector('[data-kanban-card-id="keep-done"]')?.dataset.kanbanStage, 'done');
  });
  assert.equal(deletes, 1);
  assert.equal(slot.inspection.rpcCalls.some(({ method }) => ['issueDelete', 'issueMove', 'issueMoveMany'].includes(method)), false);
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
  const filter = slot.getByRole("combobox", { name: "Раздел" });
  await user.selectOptions(filter, "proj_1");
  await user.type(slot.getByRole("textbox", { name: "Найти задачу" }), "нет результатов");
  await user.click(slot.getByRole("button", { name: "Создать раздел" }));
  await user.click(within(await slot.findByRole("dialog")).getByRole("button", { name: "Отмена" }));
  assert.equal(filter.value, "proj_1");
  assert.equal(calls, 0);
  await user.click(slot.getByRole("button", { name: "Создать раздел" }));
  const dialog = within(await slot.findByRole("dialog"));
  await user.type(dialog.getByRole("textbox", { name: "Название раздела" }), "  Новый раздел  ");
  await user.type(dialog.getByRole("textbox", { name: "Папка раздела" }), "  D:\\QA  ");
  await user.click(dialog.getByRole("button", { name: "Создать раздел" }));
  await dialog.findByRole("alert");
  assert.match(dialog.getByRole("alert").textContent, /Нет доступа к папке/);
  assert.equal(filter.value, "proj_1");
  assert.equal(dialog.getByRole("textbox", { name: "Название раздела" }).value, "  Новый раздел  ");
  await user.dblClick(dialog.getByRole("button", { name: "Создать раздел" }));
  await user.keyboard("{Enter}{Enter}{Escape}");
  assert.ok(slot.getByRole("dialog"));
  assert.equal(dialog.getByRole("button", { name: "Создаю…" }).disabled, true);
  assert.equal(dialog.getByRole("button", { name: "Отмена" }).disabled, true);
  assert.equal(calls, 2);
  assert.deepEqual(inputs[1], { name: "Новый раздел", source: { type: "local_path", hostId: "host_qa", path: "D:\\QA" } });
  resolve({ id: "proj_created", name: "Новый раздел" });
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
  const filter = slot.getByRole("combobox", { name: "Раздел" });
  assert.equal(filter.value, "");
  await user.click(slot.getByRole("button", { name: "Создать раздел" }));
  const dialog = within(await slot.findByRole("dialog"));
  await user.type(dialog.getByRole("textbox", { name: "Название раздела" }), "Новый раздел");
  await user.type(dialog.getByRole("textbox", { name: "Папка раздела" }), "D:\\QA");
  await user.click(dialog.getByRole("button", { name: "Создать раздел" }));
  await waitFor(() => assert.ok(slot.queryByRole("dialog") === null));
  assert.equal(filter.value, "");
  assert.ok(slot.getByText("Существующий чат"));
  assert.ok(slot.getByRole("region", { name: "Первый" }));
  assert.ok(slot.getByRole("region", { name: "Второй" }));
  assert.ok(slot.getByRole("region", { name: "Новый раздел" }));
});

test("disconnected machines and host loading errors prevent creation and offer retry", async (t) => {
  let attempts = 0;
  const { slot, user } = mount([], { hosts: () => {
    if (++attempts === 1) throw new Error("Связь потеряна");
    return [{ id: "offline", name: "QA offline", status: "disconnected" }];
  } });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await user.click(slot.getByRole("button", { name: "Создать раздел" }));
  const dialog = within(await slot.findByRole("dialog"));
  assert.match((await dialog.findByRole("alert")).textContent, /Связь потеряна/);
  assert.equal(dialog.getByRole("button", { name: "Создать раздел" }).disabled, true);
  await user.click(dialog.getByRole("button", { name: "Обновить компьютеры" }));
  await dialog.findByRole("status");
  assert.equal(dialog.getByRole("option", { name: "QA offline · Не в сети" }).disabled, true);
  assert.equal(dialog.getByRole("button", { name: "Создать раздел" }).disabled, true);
});

test("a missing or inaccessible source folder never calls project creation", async (t) => {
  let creations = 0;
  const { slot, user } = mount(["Первый"], {
    directory: () => { throw new Error("Папка не найдена"); },
    create: () => { creations++; return { id: "unexpected", name: "Test" }; },
  });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  const filter = slot.getByRole("combobox", { name: "Раздел" });
  await user.selectOptions(filter, "proj_0");
  await user.click(slot.getByRole("button", { name: "Создать раздел" }));
  const dialog = within(await slot.findByRole("dialog"));
  await user.type(dialog.getByRole("textbox", { name: "Название раздела" }), "Test");
  await user.type(dialog.getByRole("textbox", { name: "Папка раздела" }), "D:\\missing");
  await user.click(dialog.getByRole("button", { name: "Создать раздел" }));
  assert.match((await dialog.findByRole("alert")).textContent, /Папка не найдена/);
  assert.equal(creations, 0);
  assert.equal(filter.value, "proj_0");
  await user.click(dialog.getByRole("button", { name: "Отмена" }));
  assert.equal(filter.value, "proj_0");
});

test("project menus target the right project, close outside, and validate rename and cancellation", async (t) => {
  const { slot, user } = mount(["Первый", "Второй"]);
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await user.click(await slot.findByRole("button", { name: "Действия с разделом: Второй" }));
  await user.click(await slot.findByRole("menuitem", { name: "Переименовать" }));
  assert.equal(slot.queryByRole("menu"), null);
  const input = await slot.findByRole("textbox", { name: "Название раздела" });
  assert.equal(input.value, "Второй");
  await user.clear(input);
  await user.type(input, "   ");
  assert.equal(slot.getByRole("button", { name: "Сохранить" }).disabled, true);
  await user.click(slot.getByRole("button", { name: "Отмена" }));
  assert.equal(slot.inspection.rpcCalls.filter(({ method }) => method === "projectRename").length, 0);
  await user.click(slot.getByRole("button", { name: "Действия с разделом: Второй" }));
  await user.click(await slot.findByRole("menuitem", { name: "Переименовать" }));
  const restored = await slot.findByRole("textbox", { name: "Название раздела" });
  assert.equal(restored.value, "Второй");
  await user.clear(restored);
  await user.type(restored, "Новое имя");
  await user.click(slot.getByRole("button", { name: "Сохранить" }));
  await waitFor(() => assert.equal(slot.queryByRole("dialog"), null));
  const rename = slot.inspection.rpcCalls.find(({ method }) => method === "projectRename");
  assert.deepEqual(rename.input, { projectId: "proj_1", name: "Новое имя" });
  await user.click(slot.getByRole("button", { name: "Действия с разделом: Первый" }));
  await slot.findByRole("menu");
  await user.click(slot.getByRole("heading", { name: "Задачи" }));
  await waitFor(() => assert.equal(slot.queryByRole("menu"), null));
});

test("movement respects boundaries and updates headings without moving cards", async (t) => {
  const { slot, user } = mount(["Первый", "Второй"]);
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await waitFor(() => assert.ok(slot.inspection.rpcCalls.some(({ method }) => method === "projectOrder")));
  await user.click(slot.getByRole("button", { name: "Действия с разделом: Первый" }));
  assert.equal((await slot.findByRole("menuitem", { name: "Поднять выше" })).getAttribute("aria-disabled"), "true");
  await user.click(slot.getByRole("menuitem", { name: "Опустить ниже" }));
  await waitFor(() => assert.deepEqual([...slot.container.querySelectorAll(".kb-project")].map((node) => node.getAttribute("aria-label")), ["Второй", "Первый"]));
  await user.click(slot.getByRole("button", { name: "Действия с разделом: Первый" }));
  assert.equal((await slot.findByRole("menuitem", { name: "Опустить ниже" })).getAttribute("aria-disabled"), "true");
  await user.click(slot.getByRole("menuitem", { name: "Поднять выше" }));
  await waitFor(() => assert.deepEqual([...slot.container.querySelectorAll(".kb-project")].map((node) => node.getAttribute("aria-label")), ["Первый", "Второй"]));
  assert.equal(slot.inspection.rpcCalls.filter(({ method }) => method === "issueMove").length, 0);
});

test("single project cannot move; cancelling removal preserves the project", async (t) => {
  const { slot, user } = mount(["Единственный"]);
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await user.click(await slot.findByRole("button", { name: "Действия с разделом: Единственный" }));
  for (const name of ["Поднять выше", "Опустить ниже"]) {
    assert.equal((await slot.findByRole("menuitem", { name })).getAttribute("aria-disabled"), "true");
  }
  await user.click(slot.getByRole("menuitem", { name: "Убрать раздел…" }));
  await slot.findByText("Убрать раздел в Personal?");
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
  await user.selectOptions(slot.getByRole("combobox", { name: "Раздел" }), "proj_0");
  await user.click(slot.getByRole("button", { name: "Действия с разделом: Первый" }));
  await user.click(await slot.findByRole("menuitem", { name: "Убрать раздел…" }));
  await slot.findByText("Убрать раздел в Personal?");
  await user.click(slot.getByRole("button", { name: "Убрать в Personal" }));
  await waitFor(() => assert.equal(slot.queryByRole("button", { name: "Действия с разделом: Первый" }), null));
  assert.equal(slot.getByRole("combobox", { name: "Раздел" }).value, "proj_personal");
  const personal = within(slot.getByRole("region", { name: "Personal" }));
  assert.ok(personal.getByRole("button", { name: "Открыть: Задача источника" }));
  assert.ok(personal.getByRole("button", { name: "Открыть: Личная задача" }));
  assert.ok(personal.getByRole("button", { name: "Открыть: Чат источника" }));
  assert.equal(slot.queryByRole("button", { name: "Открыть: Другой чат" }), null);
  await user.click(slot.getByRole("button", { name: "Действия с разделом: Personal" }));
  await user.click(await slot.findByRole("menuitem", { name: "Вернуть раздел в канбан…" }));
  assert.equal(slot.getByRole("combobox", { name: "Раздел для возврата" }).value, "proj_0");
  await user.click(slot.getByRole("button", { name: "Вернуть раздел" }));
  await waitFor(() => assert.equal(slot.queryByRole("dialog"), null));
  await user.selectOptions(slot.getByRole("combobox", { name: "Раздел" }), "");
  await slot.findByRole("button", { name: "Действия с разделом: Первый" });
  const original = within(slot.getByRole("region", { name: "Первый" }));
  assert.ok(original.getByRole("button", { name: "Открыть: Задача источника" }));
  assert.ok(original.getByRole("button", { name: "Открыть: Чат источника" }));
});

test("empty-project confirmation explicitly offers native deletion and preserves tasks in Personal", async (t) => {
  const { slot, user } = mount(["Пустой"], { empty: true, issues: [issue("remaining", "proj_0", "Задача без чата")] });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  await user.click(await slot.findByRole("button", { name: "Действия с разделом: Пустой" }));
  await user.click(await slot.findByRole("menuitem", { name: "Убрать раздел…" }));
  await slot.findByText("Удалить раздел?");
  assert.match(slot.getByRole("dialog").textContent, /задачи \(1\) сохранятся в Personal/);
  await user.click(slot.getByRole("button", { name: "Удалить раздел" }));
  await waitFor(() => assert.equal(slot.queryByRole("dialog"), null));
  assert.deepEqual(slot.inspection.rpcCalls.find(({ method }) => method === "projectRemove").input, { projectId: "proj_0", confirmation: "current" });
});
