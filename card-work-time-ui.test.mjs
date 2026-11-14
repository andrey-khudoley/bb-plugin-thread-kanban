import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
await build({ entryPoints: ['card-work-time-ui.tsx'], outfile: 'dist/card-work-time-ui-test.mjs', bundle: true, packages: 'external', platform: 'node', format: 'esm' });
const { CardWorkTime } = await import('./dist/card-work-time-ui-test.mjs');
const React = await import('react');
const { render, act, cleanup } = await import('@testing-library/react');

test('all cards share one local tick, catch up after hiding, survive remount and clean up on exit', t => {
  let now = 760000, tick, intervals = 0, cleared = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setInterval', (callback, delay) => { assert.equal(delay, 1000); intervals++; tick = callback; return 42; });
  t.mock.method(globalThis, 'clearInterval', () => { cleared++; });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('a tick must not use the network'); });
  t.after(cleanup);
  const card = (key, stage, startedAt) => React.createElement(CardWorkTime, { key, stage, startedAt });
  const slot = render(React.createElement(React.Fragment, null, card('a', 'working', 6000), card('b', 'working', 66000)));
  assert.equal(intervals, 1);
  assert.deepEqual([...slot.container.querySelectorAll('.kb-card-work-value')].map(node => node.textContent), ['12:34', '11:34']);
  act(() => { now += 1000; tick(); });
  assert.match(slot.container.textContent, /12:35/);
  act(() => { now += 3600000; document.dispatchEvent(new dom.window.Event('visibilitychange')); });
  assert.match(slot.container.textContent, /1:12:35/);
  slot.rerender(card('a', 'review', 6000));
  assert.equal(slot.container.textContent, '');
  assert.equal(cleared, 1);
  slot.rerender(card('a', 'working', 6000));
  assert.match(slot.container.textContent, /1:12:35/);
  slot.rerender(card('a', 'working', now));
  assert.match(slot.container.textContent, /00:00/);
  for (const stage of ['backlog', 'todo', 'review', 'done', 'cancelled']) {
    slot.rerender(card('a', stage, 6000)); assert.equal(slot.container.textContent, '');
  }
  slot.rerender(card('a', 'working', null)); assert.equal(slot.container.textContent, '');
  slot.unmount();
});
