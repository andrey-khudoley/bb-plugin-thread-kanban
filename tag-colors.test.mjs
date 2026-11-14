import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from './dist/server.js';

test('tag colors persist across reload, canonicalize Test and retain concurrent edits', async t => {
  const { bb, harness } = createFakePluginHost();
  await plugin(bb);
  t.after(() => harness.lifecycle.dispose());
  const call = async (method, input = null) => Object.fromEntries((await harness.behavior.callRpc(method, input)).map(({ tag, color }) => [tag, color]));
  assert.deepEqual(await call('tagColorsRead'), {});
  await Promise.all([
    call('tagColorsSave', [{ tag: 'Orange', color: '#F97316' }]),
    call('tagColorsSave', [{ tag: 'test', color: '#112233' }]),
  ]);
  assert.deepEqual(await call('tagColorsRead'), { Orange: '#f97316', Test: '#112233' });
  const next = await harness.lifecycle.reload(plugin);
  t.after(() => next.harness.lifecycle.dispose());
  assert.deepEqual(await next.harness.behavior.callRpc('tagColorsRead', null), [{ tag: 'Orange', color: '#f97316' }, { tag: 'Test', color: '#112233' }]);
  assert.deepEqual(await next.harness.behavior.callRpc('tagColorsSave', [{ tag: 'TEST', color: null }]), [{ tag: 'Orange', color: '#f97316' }]);
  assert.ok(harness.realtimeSignals.some(signal => signal.channel === 'tag-colors-changed'));
});

test('invalid colors cannot be stored and a rejected batch leaves all colors intact', async t => {
  const { bb, harness } = createFakePluginHost();
  await plugin(bb);
  t.after(() => harness.lifecycle.dispose());
  const call = async (method, input = null) => Object.fromEntries((await harness.behavior.callRpc(method, input)).map(({ tag, color }) => [tag, color]));
  await call('tagColorsSave', [{ tag: '__proto__', color: '#abcdef' }]);
  for (const color of ['red', 'url(https://example.com)', '#abc', '#12345678']) {
    await assert.rejects(call('tagColorsSave', [{ tag: 'A', color: '#123456' }, { tag: 'B', color }]));
    assert.deepEqual(await call('tagColorsRead'), JSON.parse('{"__proto__":"#abcdef"}'));
  }
});
