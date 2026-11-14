import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'localStorage'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
await build({ stdin: { contents: `export { useChatHighlight } from './open-chats-ui';
  export { openChatStore } from './open-chats'; export { sectionStore } from './panel-context';
  export { setContextPluginId } from './panel-context-actions';`, resolveDir: process.cwd(), loader: 'ts' },
  outfile: 'dist/open-chats-ui-test.mjs', bundle: true, packages: 'external', platform: 'node', format: 'esm' });
const { useChatHighlight, openChatStore, sectionStore, setContextPluginId } = await import('./dist/open-chats-ui-test.mjs');
const React = await import('react');
const { renderSlot } = await import('@get-bb/plugin-sdk/testing/app');
const { act, cleanup } = await import('@testing-library/react');
setContextPluginId('thread-kanban');
const chat = threadId => ({ kind: 'chat', threadId, title: 'Одинаковое название', view: 'chat' });
function tab(context, pluginId = 'thread-kanban') {
  const id = crypto.randomUUID();
  if (context) sectionStore.replace(id, context); else sectionStore.clear(id);
  return { key: id, title: 'Одинаковое название', status: null, closable: true,
    detail: { kind: 'plugin', pluginId, tab: { id: 'context', context: { kind: 'nav-panel', panelId: 'board' } }, params: { sectionId: id } } };
}
function Card({ id }) {
  const issueId = id === 'issue' ? 'task' : id.startsWith('chatless') ? id : undefined;
  const { chatOpen, chatActive, cardActive } = useChatHighlight(id === 'issue' ? ['a', 'b'] : issueId ? [] : [id], issueId);
  return React.createElement('article', { 'data-testid': id, 'data-chat-open': chatOpen, 'data-chat-active': chatActive, 'data-card-active': cardActive });
}
function Cards() { return ['a', 'b', 'closed', 'issue', 'chatless-a', 'chatless-b'].map(id => React.createElement(Card, { key: id, id })); }
function fixture(t, tabs) {
  const panel = { open: true, selectedKey: tabs[0]?.key ?? null, tabs };
  const releases = [];
  const slot = renderSlot({ component: Cards }, {}, { experimental_panelTabs: panel });
  t.after(() => { slot.lifecycle.unmount(); releases.forEach(release => release()); cleanup(); });
  return {
    panel,
    change(change) { Object.assign(panel, change); slot.lifecycle.rerender(React.createElement(Cards)); },
    open(id) { let close; act(() => { close = openChatStore.open(id); }); releases.push(close); return () => act(close); },
    state(id) { const card = slot.getByTestId(id); return [card.dataset.chatOpen === 'true', card.dataset.chatActive === 'true']; },
    active(id) { return slot.getByTestId(id).dataset.cardActive === 'true'; },
  };
}

test('selection moves the stronger accent while open membership stays unchanged', t => {
  const a = tab(chat('a')), b = tab(chat('b'));
  const f = fixture(t, [a, b]); f.open('a'); const closeB = f.open('b');
  assert.deepEqual(f.state('a'), [true, true]);
  assert.deepEqual(f.state('b'), [true, false]);
  assert.deepEqual(f.state('closed'), [false, false]);
  f.change({ selectedKey: b.key });
  assert.deepEqual(f.state('a'), [true, false]);
  assert.deepEqual(f.state('b'), [true, true]);
  assert.deepEqual(f.state('issue'), [true, true]);
  f.change({ tabs: [a], selectedKey: a.key }); closeB();
  assert.deepEqual(f.state('a'), [true, true]);
  assert.deepEqual(f.state('b'), [false, false]);
  assert.deepEqual(f.state('closed'), [false, false]);
});

test('chatless card selection follows native tabs and section replacement without opening chats', t => {
  const issue = issueId => ({ kind: 'issue', issueId, title: 'Одинаковое название', threadId: null,
    startWithAssistant: false, request: 1, view: 'overview' });
  const a = tab(issue('chatless-a')), b = tab(issue('chatless-b')), linked = tab(chat('a'));
  const f = fixture(t, [a, b, linked]);
  assert.equal(f.active('chatless-a'), true);
  assert.equal(f.active('chatless-b'), false);
  assert.deepEqual(f.state('chatless-a'), [false, false]);
  const opened = openChatStore.getSnapshot();
  f.change({ selectedKey: a.key }); // Repeated selection is not a toggle.
  assert.equal(f.active('chatless-a'), true);
  f.change({ selectedKey: b.key });
  assert.equal(f.active('chatless-a'), false);
  assert.equal(f.active('chatless-b'), true);
  act(() => sectionStore.replace(b.key, issue('chatless-a')));
  assert.equal(f.active('chatless-a'), true);
  assert.equal(f.active('chatless-b'), false);
  act(() => sectionStore.replace(b.key, { ...issue('chatless-a'), view: 'relations' }));
  assert.equal(f.active('chatless-a'), true);
  f.change({ selectedKey: linked.key });
  assert.equal(f.active('chatless-a'), false);
  assert.equal(f.active('a'), true);
  assert.equal(f.active('issue'), true);
  assert.deepEqual(f.state('a'), [true, true]);
  assert.strictEqual(openChatStore.getSnapshot(), opened);
  f.change({ selectedKey: a.key, open: false });
  assert.equal(f.active('chatless-a'), false);
  f.change({ tabs: [], selectedKey: null, open: true });
  assert.equal(f.active('chatless-a'), false);
});

test('native files, launchers, foreign plugins and closed panels have no active chat', t => {
  const a = tab(chat('a')), empty = tab(null), foreign = tab(chat('b'), 'qa-kanban');
  const file = { key: 'file', title: 'a.md', detail: { kind: 'file', path: 'a.md' } };
  const launcher = { key: 'new', title: 'New tab', detail: { kind: 'new-tab' } };
  const f = fixture(t, [a, empty, foreign, file, launcher]); f.open('a'); f.open('b');
  for (const selectedKey of [empty.key, foreign.key, file.key, launcher.key, 'closed-key', null]) {
    f.change({ selectedKey });
    assert.deepEqual(f.state('a'), [true, false]);
    assert.deepEqual(f.state('b'), [true, false]);
    assert.equal(f.active('chatless-a'), false);
  }
  f.change({ selectedKey: a.key, open: false });
  assert.deepEqual(f.state('a'), [true, false]);
});

test('replacing a selected section and changing its working chat or view updates without a tab event', t => {
  const a = tab(chat('a')); const f = fixture(t, [a]); f.open('a'); f.open('b');
  const context = { kind: 'issue', issueId: 'task', title: 'Задача', threadId: 'b', startWithAssistant: false, request: 1, view: 'chat' };
  act(() => sectionStore.replace(a.key, context));
  assert.deepEqual(f.state('a'), [true, false]);
  assert.deepEqual(f.state('b'), [true, true]);
  act(() => sectionStore.replace(a.key, { ...context, threadId: 'a' }));
  assert.deepEqual(f.state('a'), [true, true]);
  assert.deepEqual(f.state('b'), [true, false]);
  act(() => sectionStore.replace(a.key, { ...context, view: 'overview' }));
  assert.deepEqual(f.state('a'), [true, false]);
  assert.deepEqual(f.state('b'), [true, false]);
  assert.equal(f.active('issue'), true);
});

test('closing one duplicate keeps the chat active until its last native tab closes', t => {
  const a = tab(chat('a')), copy = tab(chat('a')); const f = fixture(t, [a, copy]);
  const closeFirst = f.open('a'), closeCopy = f.open('a');
  f.change({ tabs: [copy], selectedKey: copy.key }); closeFirst();
  assert.deepEqual(f.state('a'), [true, true]);
  f.change({ tabs: [], selectedKey: null }); closeCopy();
  assert.deepEqual(f.state('a'), [false, false]);
});
