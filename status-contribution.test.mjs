import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { createElement } from 'react';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window','document','location','navigator','HTMLElement','Element','Node','MutationObserver','Event','CustomEvent','sessionStorage'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
const { renderSlot } = await import('@get-bb/plugin-sdk/testing/app');
const { waitFor, cleanup, act } = await import('@testing-library/react');
await build({ stdin: { contents: `export {StatusContribution} from './status-contribution'; export {createActivityStore,activityStore} from './activity-store';`, resolveDir: process.cwd(), loader: 'tsx' },
  outfile: 'dist/status-contribution-test.mjs', bundle: true, packages: 'external', platform: 'node', format: 'esm', jsx: 'automatic' });
const { StatusContribution, createActivityStore, activityStore } = await import('./dist/status-contribution-test.mjs');
const selection = { source: { kind: 'thread', id: 'a' }, mode: 'single', title: 'Test A', test: true };

test('activity migration preserves Test jobs and deduplicates the former per-pane records', () => {
  sessionStorage.clear();
  const jobId = 'd4f67d49-4234-4b70-97fe-74aa38b043cf';
  for (const scope of ['board', 'issue:a']) sessionStorage.setItem(`thread-kanban:derivations:${scope}`,
    JSON.stringify({ runs: [{ key: 1, id: jobId, selection }] }));
  const store = createActivityStore(sessionStorage);
  assert.equal(store.getSnapshot().length, 1); assert.equal(store.getSnapshot()[0].selection.test, true);
  let changes = 0; const unsubscribe = store.subscribe(() => changes++);
  const one = store.add('board', selection, 'run'), two = store.add('issue:a', selection, 'run');
  assert.equal(one.created, true); assert.equal(two.created, false); assert.equal(one.key, two.key);
  store.update(one.key, { error: 'failed' }); store.dismiss(one.key); assert.equal(changes, 3);
  unsubscribe(); store.dismiss(1); assert.equal(changes, 3); sessionStorage.clear();
});

test('optional contribution keeps its count without status-bar, restores its portal and cleans up on unload', async t => {
  const store = activityStore(); const run = store.add('board', selection, 'run');
  store.update(run.key, { error: 'test failure' });
  const slot = renderSlot({ component: StatusContribution }, {}, {});
  t.after(() => { slot.lifecycle.unmount(); store.dismiss(run.key); cleanup(); });
  assert.equal(document.querySelectorAll('[data-kanban-status-bar]').length, 0);
  assert.equal(document.querySelector('[data-bb-status-contribution-count]').dataset.bbStatusContributionCount, '1');
  const target = document.createElement('div'); target.setAttribute('data-bb-status-notification-contributions', '');
  document.body.append(target);
  await waitFor(() => assert.match(target.textContent, /Test A/));
  await act(async () => target.remove());
  assert.equal(document.querySelectorAll('[data-bb-status-notification-contributions]').length, 0);
  document.body.append(target); await waitFor(() => assert.match(target.textContent, /Test A/));
  slot.lifecycle.unmount(); assert.equal(target.textContent, '');
  assert.equal(document.querySelectorAll('[data-bb-status-contribution-count]').length, 0); target.remove();
});

test('a hidden running derivation stays tracked across restoration and no longer appears in the bell', () => {
 sessionStorage.clear(); const store=createActivityStore(sessionStorage);
 const {key}=store.add('board',selection,'run');
 store.update(key,{jobId:'d4f67d49-4234-4b70-97fe-74aa38b043cf'}); store.hide(key);
 const restored=createActivityStore(sessionStorage);
 assert.equal(restored.getSnapshot().length,1); assert.equal(restored.getSnapshot()[0].hidden,true);
 restored.update(key,{pollError:true}); assert.equal(restored.getSnapshot()[0].hidden,true);
 sessionStorage.clear();
});

test('clear all hides all derivations through the contribution bridge while keeping running jobs', async t => {
 const store=activityStore();
 const first=store.add('board',selection,'clear-one');
 const second=store.add('board',{...selection,title:'Test second',source:{kind:'thread',id:'b'}},'clear-two');
 store.update(first.key,{jobId:'d4f67d49-4234-4b70-97fe-74aa38b043cf'});
 const slot=renderSlot({component:StatusContribution},{},{});
 t.after(()=>{slot.lifecycle.unmount();store.dismiss(first.key);store.dismiss(second.key);cleanup();});
 await act(async()=>window.dispatchEvent(new Event('bb:clear-status-notifications')));
 assert.equal(document.querySelector('[data-bb-status-contribution-count]').dataset.bbStatusContributionCount,'0');
 assert.equal(store.getSnapshot().length,2);
 assert.ok(store.getSnapshot().every(run=>run.hidden));
 assert.equal(store.getSnapshot().find(run=>run.key===first.key).jobId,'d4f67d49-4234-4b70-97fe-74aa38b043cf');
});
