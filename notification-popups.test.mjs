import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { createElement } from 'react';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','Event','CustomEvent','sessionStorage'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
const { render, screen, waitFor, act, cleanup, fireEvent } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');
await build({ entryPoints: ['notification-popups.tsx'], outfile: 'dist/notification-popups-test.mjs', bundle: true,
  packages: 'external', platform: 'node', format: 'esm', jsx: 'automatic' });
const { createArrivalTracker, usePopupArrivals, NotificationPopups } = await import('./dist/notification-popups-test.mjs');
const notice = (id, extra = {}) => ({ id, threadId: `chat-${id}`, title: `Chat ${id}`, kind: 'completed', detail: '', createdAt: 110, readAt: null, ...extra });
const popup = id => ({ id, label: 'Done', title: `Chat ${id}`, threadId: `chat-${id}` });

test('history is silent; new completions and questions each appear once, even on repeat fetch or a remount', () => {
  sessionStorage.clear(); const tracker = createArrivalTracker(sessionStorage, 100);
  assert.deepEqual(tracker.observe([notice('old', { createdAt: 99 })]), []);
  const first = tracker.observe([notice('a'), notice('b', { kind: 'question' }), notice('notifications.read', { readAt: 111 })]);
  assert.equal(first.length, 2); assert.equal(first[0].label, 'Работа завершена'); assert.equal(first[1].label, 'Требуется ответ');
  assert.deepEqual(tracker.observe([notice('a'), notice('b')]), []);
  const restored = createArrivalTracker(sessionStorage, 105);
  assert.deepEqual(restored.observe([notice('a'), notice('b')]), []);
  assert.equal(restored.observe([notice('c', { createdAt: 120 })]).length, 1);
});

test('unavailable or corrupt storage retains in-memory deduplication', () => {
  for (const storage of [undefined, { getItem: () => '{bad', setItem: () => { throw Error('blocked'); } }]) {
    const tracker = createArrivalTracker(storage, 100);
    assert.equal(tracker.observe([notice('a')]).length, 1); assert.equal(tracker.observe([notice('a')]).length, 0);
  }
});

test('popup open and dismiss have separate effects; dismissing never marks a notification read', async t => {
  t.after(cleanup); const opened = [], dismissed = [];
  render(createElement(NotificationPopups, { items: [popup('a'), popup('b')], open: item => opened.push(item), dismiss: id => dismissed.push(id), duration: 10000 }));
  const user = userEvent.setup({ document });
  await user.click(screen.getAllByRole('button', { name: 'Открыть' })[0]);
  assert.equal(opened[0].threadId, 'chat-a'); assert.deepEqual(dismissed, ['a']);
  await user.click(screen.getByRole('button', { name: 'Скрыть уведомление: Chat b' }));
  assert.equal(opened.length, 1); assert.deepEqual(dismissed, ['a', 'b']);
});

test('at most three popups are visible; hover pauses expiry and timer cleanup prevents a stale callback', async t => {
  t.after(cleanup); const dismissed = [];
  const view = render(createElement(NotificationPopups, { items: ['a','b','c','d'].map(popup), open() {}, dismiss: id => dismissed.push(id), duration: 80 }));
  assert.equal(document.querySelectorAll('[data-notification-popup]').length, 3);
  assert.match(screen.getByText('Ещё уведомлений: 1').textContent, /1/);
  const card = document.querySelector('[data-notification-popup="a"]'); fireEvent.mouseEnter(card);
  await act(() => new Promise(resolve => setTimeout(resolve, 110)));
  assert.ok(!dismissed.includes('a')); assert.ok(dismissed.includes('b'));
  fireEvent.mouseLeave(card);
  await waitFor(() => assert.ok(dismissed.includes('a')));
  const count = dismissed.length; view.unmount();
  await act(() => new Promise(resolve => setTimeout(resolve, 100))); assert.equal(dismissed.length, count);
});

test('arrival hook ignores replay, dismisses read events and unregisters contribution listener', async t => {
  sessionStorage.clear(); let state;
  function Fixture({ notices }) { state = usePopupArrivals(notices); return createElement(NotificationPopups, { items: state.queue, dismiss: state.dismiss, open() {}, duration: 10000 }); }
  const view = render(createElement(Fixture, { notices: [] })); t.after(cleanup);
  const fresh = notice('new', { createdAt: Date.now() + 1 });
  view.rerender(createElement(Fixture, { notices: [fresh] }));
  await waitFor(() => assert.equal(state.queue.length, 1));
  view.rerender(createElement(Fixture, { notices: [{ ...fresh }] })); assert.equal(state.queue.length, 1);
  view.rerender(createElement(Fixture, { notices: [{ ...fresh, readAt: Date.now() + 2 }] }));
  await waitFor(() => assert.equal(state.queue.length, 0));
  const detail = { id: 'derivation-one', label: 'Decomposition', title: 'Test job' };
  await act(async () => { window.dispatchEvent(new CustomEvent('bb:status-popup', { detail })); window.dispatchEvent(new CustomEvent('bb:status-popup', { detail })); });
  assert.equal(state.queue.length, 1); view.unmount();
  window.dispatchEvent(new CustomEvent('bb:status-popup', { detail: { ...detail, id: 'after-unmount' } }));
  assert.equal(document.querySelectorAll('[data-notification-popup]').length, 0);
});
