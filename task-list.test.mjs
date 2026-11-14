import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { compareListItems } from "./task-list-order.ts";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "sessionStorage", "getComputedStyle", "NodeFilter"])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
window.PointerEvent = window.MouseEvent;
HTMLElement.prototype.hasPointerCapture = () => false;
HTMLElement.prototype.setPointerCapture = () => {};
HTMLElement.prototype.releasePointerCapture = () => {};
HTMLElement.prototype.scrollIntoView = () => {};
await build({ stdin: { contents: `export { TaskListRow } from './task-list-row'; export { useListViewContext } from './list-view-context';`,
  resolveDir: process.cwd(), loader: "ts" }, outfile: "dist/task-list-test.mjs", bundle: true, packages: "external", platform: "node", format: "esm", jsx: "automatic" });
const { TaskListRow, useListViewContext } = await import("./dist/task-list-test.mjs");
const React = await import("react");
const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
afterEach(() => { cleanup(); sessionStorage.clear(); });
function fixture(overrides = {}) {
  const calls = { open: 0, toggle: 0, menu: 0, parent: 0 };
  const props = { id: "a", kind: "issue", projectId: "project", title: "Длинное название задачи", stage: "review", stageLabel: "На проверке",
    summary: "Задача · Без чата", updatedAt: 123456, chatOpen: false, chatActive: false, cardActive: false,
    open: () => calls.open++, toggle: () => calls.toggle++,
    details: React.createElement("button", { onClick: () => calls.parent++ }, "Родительская задача"),
    groups: [{ label: "Навигация", items: [{ label: "Открыть ветку", action: () => calls.menu++ }] }], ...overrides };
  return { ...render(React.createElement(TaskListRow, props)), calls, user: userEvent.setup({ document }) };
}

test("selected chatless row exposes its card accent independently of chat state", () => {
  const f = fixture({ cardActive: true });
  const row = f.container.querySelector('article');
  assert.equal(row.dataset.cardActive, 'true');
  assert.equal(row.dataset.chatOpen, 'false');
  assert.equal(row.dataset.chatActive, 'false');
});

test("row, primary button and modifiers do not overlap with secondary actions", async () => {
  const f = fixture();
  fireEvent.click(f.container.querySelector("article"));
  await f.user.click(f.getByRole("button", { name: /^Открыть:/ }));
  assert.equal(f.calls.open, 2);
  await f.user.click(f.getByRole("button", { name: /^Подробнее:/ }));
  assert.equal(f.getByRole("button", { name: /^Скрыть сведения:/ }).getAttribute("aria-expanded"), "true");
  fireEvent.click(f.container.querySelector(".kb-list-details"));
  fireEvent.click(f.container.querySelector(".kb-list-details"), { ctrlKey: true });
  await f.user.click(f.getByRole("button", { name: "Родительская задача" }));
  assert.equal(f.calls.parent, 1);
  assert.equal(f.calls.open, 2);
  assert.equal(f.calls.toggle, 0);
  fireEvent.click(f.getByRole("button", { name: /^Открыть:/ }), { ctrlKey: true });
  assert.equal(f.calls.toggle, 1);
  assert.equal(f.calls.open, 2);
});

test("menu works by keyboard, returns focus and never opens its row", async () => {
  const f = fixture();
  const menu = f.getByRole("button", { name: /^Действия с задачей:/ });
  menu.focus();
  await f.user.keyboard("{Enter}");
  await f.user.click(f.getByRole("menuitem", { name: "Открыть ветку" }));
  assert.equal(f.calls.menu, 1);
  assert.equal(f.calls.open, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(document.activeElement, menu);
  await f.user.keyboard("{Enter}{Escape}");
  assert.equal(f.queryByRole("menu"), null);
  assert.equal(f.calls.open, 0);
});

test("selection controls toggle once and replace opening while selecting", async () => {
  const f = fixture({ selected: false });
  await f.user.click(f.getByRole("checkbox"));
  assert.equal(f.calls.toggle, 1);
  await f.user.click(f.getByRole("button", { name: /^Выбрать:/ }));
  assert.equal(f.calls.toggle, 2);
  fireEvent.click(f.container.querySelector("article"));
  assert.equal(f.calls.toggle, 3);
  assert.equal(f.calls.open, 0);
});

test("title starts row dragging, ignores the release click, and remains a normal open button", async () => {
  let dragged = null, suppress = false;
  const f = fixture({ drag: { draggable: true, onDragStart: event => { dragged = event.currentTarget; }, onDragEnd: () => { suppress = true; } },
    suppressClick: () => suppress });
  const row = f.container.querySelector('article'), title = f.getByRole('button', { name: /^Открыть:/ });
  assert.equal(title.draggable, true);
  fireEvent.dragStart(title.querySelector('.kb-card-title'));
  assert.equal(dragged, row);
  fireEvent.dragEnd(title);
  fireEvent.click(title);
  assert.equal(f.calls.open, 0);
  suppress = false;
  await f.user.click(title);
  title.focus(); await f.user.keyboard('{Enter}');
  assert.equal(f.calls.open, 2);
  await f.user.click(f.getByRole('button', { name: /^Подробнее:/ }));
  assert.ok(f.getByRole('button', { name: /^Скрыть сведения:/ }));
});

test("keyboard primary and disclosure have distinct targets and unique panel IDs", async () => {
  const f = fixture();
  await f.user.tab();
  assert.equal(document.activeElement, f.getByRole("button", { name: /^Открыть:/ }));
  await f.user.keyboard("{Enter}");
  assert.equal(f.calls.open, 1);
  await f.user.tab();
  await f.user.keyboard(" ");
  const disclosure = f.getByRole("button", { name: /^Скрыть сведения:/ });
  assert.ok(document.getElementById(disclosure.getAttribute("aria-controls")));
  assert.equal(f.calls.open, 1);
});

test("sort compares kinds and stages together, manual retains stage and stored order", () => {
  const items = [
    { id: "old", updatedAt: 1, createdAt: 20, priority: "urgent", stage: "done", order: 3 },
    { id: "chat", updatedAt: 8, createdAt: 5, priority: null, stage: "working" },
    { id: "new", updatedAt: 10, createdAt: 10, priority: "low", stage: "done", order: 1 },
  ];
  const ids = (sort) => [...items].sort((a, b) => compareListItems(a, b, sort)).map((item) => item.id);
  assert.deepEqual(ids("updated"), ["new", "chat", "old"]);
  assert.deepEqual(ids("created"), ["old", "new", "chat"]);
  assert.deepEqual(ids("priority"), ["old", "new", "chat"]);
  assert.deepEqual(ids("manual"), ["chat", "new", "old"]);
});

test("mode and filter scroll positions and project expansion survive remount", () => {
  let context;
  function Harness({ listView = true, query = "" }) {
    context = useListViewContext({ ready: true, listView, query, subPath: "" });
    return React.createElement("div", { ref: context.scrollRef, onScroll: context.saveScroll, "data-testid": "scroll" });
  }
  const f = render(React.createElement(Harness));
  const scroll = f.getByTestId("scroll");
  scroll.scrollTop = 500; fireEvent.scroll(scroll);
  f.rerender(React.createElement(Harness, { listView: false }));
  assert.equal(scroll.scrollTop, 0);
  scroll.scrollTop = 100; fireEvent.scroll(scroll);
  f.rerender(React.createElement(Harness));
  assert.equal(scroll.scrollTop, 500);
  f.rerender(React.createElement(Harness, { query: "Test" }));
  assert.equal(scroll.scrollTop, 0);
  f.rerender(React.createElement(Harness));
  assert.equal(scroll.scrollTop, 500);
  act(() => context.setProjectExpansion(new Map([["project", false]])));
  f.unmount();
  const back = render(React.createElement(Harness));
  assert.equal(back.getByTestId("scroll").scrollTop, 500);
  assert.equal(context.projectExpansion.get("project"), false);
});
