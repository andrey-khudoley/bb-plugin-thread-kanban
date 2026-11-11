import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { createElement } from 'react';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','Event','CustomEvent','localStorage','sessionStorage'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
const { renderSlot } = await import('@get-bb/plugin-sdk/testing/app');
const { act, cleanup } = await import('@testing-library/react');
await build({ stdin: { contents: `export * from './status-navigation';
  export {sectionStore} from './panel-context'; export {setContextPluginId} from './panel-context-actions';
  export {artifactStore,artifactOwner} from './panel-artifacts'; export {usePanelState} from './panel-view-state';
  export {SectionContext} from './panel-section-ui';`, resolveDir: process.cwd(), loader: 'tsx' },
  outfile: 'dist/status-navigation-test.mjs', bundle: true, packages: 'external', platform: 'node', format: 'esm', jsx: 'automatic' });
const { registerStatusPanel, focusStatusChat, focusStatusIssue, sectionStore, setContextPluginId,
  artifactStore, artifactOwner, usePanelState, SectionContext } = await import('./dist/status-navigation-test.mjs');
setContextPluginId('thread-kanban');

function tab(context) {
  const id = crypto.randomUUID();
  sectionStore.replace(id, context);
  return { key: id, title: context.title, detail: { kind: 'plugin', pluginId: 'thread-kanban',
    tab: { id: 'context', context: { kind: 'nav-panel', panelId: 'board' } }, params: { sectionId: id } } };
}
function fixture(t, { tabs = [], issues = [], visible = true } = {}) {
  const root = document.createElement('main'); document.body.append(root);
  root.getClientRects = () => visible ? [{}] : [];
  root.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 500, right: 700, width: 700, height: 500 });
  const snapshot = { open: false, tabs, selectedKey: tabs.at(-1)?.key ?? null };
  const opened = [], selected = [];
  const panel = { getTabs: () => snapshot,
    selectTab(key) { selected.push(key); snapshot.open = true; snapshot.selectedKey = key; return true; },
    openTab(input) { opened.push(input); return true; } };
  const release = registerStatusPanel(root, panel, issues);
  t.after(() => { release(); root.remove(); cleanup(); });
  return { root, panel, snapshot, opened, selected };
}
const chat = (id, view = 'chat') => ({ kind: 'chat', threadId: id, title: `Чат ${id}`, view });
const issue = (id, threadId = null, view = 'overview') => ({ kind: 'issue', issueId: id, threadId,
  title: `Задача ${id}`, startWithAssistant: false, request: 7, view });

test('a notification opens a missing chat in the current board panel, without a main route change', t => {
  const f = fixture(t);
  assert.equal(focusStatusChat('new', 'Нужный чат'), true);
  assert.equal(f.opened.length, 1);
  assert.deepEqual(sectionStore.get(f.opened[0].params.sectionId).context, { ...chat('new'), title: 'Нужный чат' });
});

test('a linked notification opens its task and exact chat even when a different linked chat is newer', t => {
  const f = fixture(t, { issues: [{ id: 'task', title: 'Общая задача', threadIds: ['question', 'newer'] }] });
  assert.equal(focusStatusChat('question'), true);
  const context = sectionStore.get(f.opened[0].params.sectionId).context;
  assert.equal(context.kind, 'issue'); assert.equal(context.issueId, 'task');
  assert.equal(context.threadId, 'question'); assert.equal(context.view, 'chat');
  assert.equal(context.startWithAssistant, false);
});

test('an existing card is selected, its chat revealed, and unrelated card state preserved', t => {
  const target = tab(issue('task', 'other', 'changes')), unrelated = tab(issue('unrelated'));
  const f = fixture(t, { tabs: [target, unrelated], issues: [{ id: 'task', title: 'Задача task', threadIds: ['answer', 'other'] }] });
  artifactStore.select(artifactOwner(target.key, 'issue:task'), 'browser:preview');
  assert.equal(focusStatusChat('answer'), true);
  assert.deepEqual(f.selected, [target.key]); assert.equal(f.opened.length, 0);
  const context = sectionStore.get(target.key).context;
  assert.equal(context.threadId, 'answer'); assert.equal(context.view, 'chat'); assert.ok(context.request > 7);
  assert.equal(artifactStore.get(artifactOwner(target.key, 'issue:task')), null);
  assert.deepEqual(sectionStore.get(unrelated.key).context, issue('unrelated'));
});

test('selecting an existing standalone chat switches its mounted presentation from changes to chat', async t => {
  const target = tab(chat('answer', 'changes')); fixture(t, { tabs: [target] });
  function View() { const [view] = usePanelState('answer:workspace-view', 'changes'); return createElement('p', {}, view); }
  function Mounted() { return createElement(SectionContext.Provider, { value: target.key }, createElement(View)); }
  const slot = renderSlot({ component: Mounted }, {}, {}); t.after(() => slot.lifecycle.unmount());
  assert.equal(slot.container.textContent, 'changes');
  await act(async () => assert.equal(focusStatusChat('answer'), true));
  assert.equal(slot.container.textContent, 'chat');
});

test('mounted hidden, offscreen and disconnected boards decline, leaving native chat navigation available', t => {
  const f = fixture(t);
  f.root.hidden = true; assert.equal(focusStatusChat('a'), false);
  f.root.hidden = false; f.root.setAttribute('aria-hidden', 'true'); assert.equal(focusStatusChat('a'), false);
  f.root.removeAttribute('aria-hidden'); f.root.getBoundingClientRect = () => ({ top: 0, left: 99999, right: 100500, bottom: 500, width: 501, height: 500 });
  assert.equal(focusStatusChat('a'), false);
  f.root.remove(); assert.equal(focusStatusChat('a'), false); assert.equal(f.opened.length, 0);
});

test('a created chatless card opens without creating a chat and reuses its existing tab', t => {
  const target = tab(issue('new-task'));
  const f = fixture(t, { tabs: [target] });
  assert.equal(focusStatusIssue('new-task'), true); assert.equal(f.opened.length, 0);
  assert.equal(sectionStore.get(target.key).context.threadId, null);
  f.snapshot.tabs = [];
  assert.equal(focusStatusIssue('other-new-task'), true);
  const context = sectionStore.get(f.opened[0].params.sectionId).context;
  assert.equal(context.kind, 'issue'); assert.equal(context.issueId, 'other-new-task');
  assert.equal(context.threadId, null); assert.equal(context.startWithAssistant, false);
});

test('another visible board is used instead of a hidden registered board', t => {
  const hidden = fixture(t, { visible: false }), shown = fixture(t);
  assert.equal(focusStatusChat('a'), true); assert.equal(hidden.opened.length, 0); assert.equal(shown.opened.length, 1);
});

test('a tab that cannot be selected never causes another card to be replaced', t => {
  const target = tab(chat('a')), other = tab(chat('b'));
  const f = fixture(t, { tabs: [target, other] }); f.panel.selectTab = () => false;
  assert.equal(focusStatusChat('a'), false); assert.equal(f.opened.length, 0);
  assert.deepEqual(sectionStore.get(other.key).context, chat('b'));
});
