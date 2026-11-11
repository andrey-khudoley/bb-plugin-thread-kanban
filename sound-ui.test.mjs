import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { createElement } from 'react';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
const { renderSlot } = await import('@get-bb/plugin-sdk/testing/app');
const { waitFor, act, cleanup } = await import('@testing-library/react');
await build({ entryPoints: ['use-notification-sound.tsx'], outfile: 'dist/sound-ui-test.mjs', bundle: true,
  packages: 'external', platform: 'node', format: 'esm', jsx: 'automatic' });
const { useNotificationSound, NotificationSoundControls } = await import('./dist/sound-ui-test.mjs');

function setup(t, state = 'running') {
  const starts = [], contexts = [], settings = { soundEnabled: true };
  class Context {
    state = state; currentTime = 0; destination = {};
    constructor() { contexts.push(this); }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createOscillator() { return { frequency: {}, connect() {}, disconnect() {}, start(at) { starts.push(at); }, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
  }
  window.AudioContext = Context;
  let sound, resolveClaim;
  const rpc = { 'notifications.sound.presence': () => ({ ok: true }), 'notifications.sound.claim': () => ({ play: true, reason: 'play' }),
    'notifications.sound.setEnabled': ({ enabled }) => { settings.soundEnabled = enabled; return { enabled }; } };
  function Fixture() { sound = useNotificationSound(); return createElement(NotificationSoundControls, { sound }); }
  const slot = renderSlot({ component: Fixture }, {}, { settings, rpc });
  t.after(() => { slot.lifecycle.unmount(); cleanup(); });
  const event = id => slot.behavior.emitRealtime('sound-arrival', { id, kind: 'question', threadId: 'a', at: Date.now() });
  return { slot, settings, contexts, starts, event, rpc, get sound() { return sound; },
    async rerender() { await act(async () => slot.rerender(createElement(Fixture))); },
    deferredClaim() { rpc['notifications.sound.claim'] = () => new Promise(resolve => { resolveClaim = resolve; }); },
    finishClaim() { resolveClaim({ play: true, reason: 'play' }); },
  };
}

test('web activation skips arrivals without claiming them and never plays missed arrivals after activation', async t => {
  const s = setup(t, 'suspended');
  await s.event('blocked'); await new Promise(resolve => setTimeout(resolve, 230));
  assert.equal(s.slot.inspection.rpcCalls.filter(call => call.method === 'notifications.sound.claim').length, 0);
  assert.equal(s.starts.length, 0);
  await act(async () => { s.contexts[0].state = 'running'; s.contexts[0].onstatechange(); });
  assert.equal(s.starts.length, 0);
  await s.event('fresh'); await waitFor(() => assert.equal(s.starts.length, 2));
  assert.equal(s.sound.played, 1);
});

test('disabled sound and reconnecting during an in-flight claim cancel playback; teardown closes audio', async t => {
  const s = setup(t);
  s.deferredClaim(); await s.event('in-flight');
  await waitFor(() => assert.ok(s.slot.inspection.rpcCalls.some(call => call.method === 'notifications.sound.claim')));
  await s.slot.behavior.setRealtimeConnectionState('reconnecting');
  await act(async () => s.finishClaim()); assert.equal(s.starts.length, 0);
  s.settings.soundEnabled = false; await s.rerender();
  await s.event('disabled'); await new Promise(resolve => setTimeout(resolve, 230));
  assert.equal(s.starts.length, 0); assert.equal(s.sound.state, 'off');
  s.slot.lifecycle.unmount(); assert.equal(s.contexts[0].state, 'closed');
});

test('system ownership skips bell audio, while the explicit preview plays locally', async t => {
  const s = setup(t);
  s.rpc['notifications.sound.claim'] = () => ({ play: false, reason: 'system' });
  await s.event('system'); await waitFor(() => assert.equal(s.sound.state, 'system'));
  assert.equal(s.starts.length, 0);
  await act(async () => s.sound.preview());
  await waitFor(() => assert.equal(s.starts.length, 2));
});
