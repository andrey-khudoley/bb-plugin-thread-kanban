import assert from 'node:assert/strict';
import test from 'node:test';
import { chatPreviewLines } from './card-chat-preview.ts';
import { build } from 'esbuild';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';

await build({ entryPoints: ['card-chat-preview-server.ts'], outfile: 'dist/card-chat-preview-server-test.mjs', bundle: true,
  packages: 'external', platform: 'node', format: 'esm' });
const { registerCardChatPreview } = await import('./dist/card-chat-preview-server-test.mjs');

const message = (id, seq, text, role = 'assistant', extra = {}) => ({ id, kind: 'conversation', role, text,
  sourceSeqStart: seq, sourceSeqEnd: seq, senderThreadId: null, systemMessageKind: 'unlabeled', ...extra });

test('returns exactly the last eight nonempty dialogue lines in chronological order', () => {
  const rows = [message('user', 1, 'Вопрос\r\n\r\nУточнение', 'user'), { kind: 'turn', children: [
    message('answer', 2, '1\n2\n3\n4\n5\n6\n7\n8\n9\n'),
  ] }];
  assert.deepEqual(chatPreviewLines(rows).map(line => line.text), ['2', '3', '4', '5', '6', '7', '8', '9']);
  assert.ok(chatPreviewLines(rows).every(line => line.role === 'assistant'));
  const short = chatPreviewLines([message('u', 1, 'Вопрос', 'user'), message('a', 2, 'Ответ')]);
  assert.deepEqual(short.map(({role, text}) => [role, text]), [['user', 'Вопрос'], ['assistant', 'Ответ']]);
});

test('ignores tools, reasoning, system messages, agent injections and hidden memory markup', () => {
  const lines = chatPreviewLines([{ kind: 'work', text: 'SECRET TOOL OUTPUT' }, { kind: 'system', text: 'SECRET ERROR' },
    { kind: 'turn', children: [{ kind: 'reasoning', text: 'SECRET REASONING' }, message('child', 1, 'SECRET', 'user', { senderThreadId: 'child' }),
      message('system', 2, 'SECRET', 'user', { systemMessageKind: 'child-completed' }),
      message('a', 3, 'Ответ\n<oai-mem-citation>SECRET\nmetadata</oai-mem-citation>')] }]);
  assert.deepEqual(lines.map(line => line.text), ['Ответ']);
});

test('deduplicates overlapping pages, takes a fresh streaming snapshot and bounds long text', () => {
  const lines = chatPreviewLines([message('same', 1, 'Старый'), message('same', 1, 'Текущий', 'assistant', { sourceSeqEnd: 5 }),
    message('long', 6, 'Я'.repeat(2000))]);
  assert.equal(lines.length, 2); assert.equal(lines[0].text, 'Текущий'); assert.equal(lines[1].text.length, 600);
  assert.deepEqual(chatPreviewLines([]), []);
});

test('previews readable Markdown labels instead of link destinations and formatting markers', () => {
  const rows=[message('a',1,'## Итог\n| Экран | Состояние |\n| --- | --- |\n| [Общий вид](D:/private/screen.png) | **Готово** |\n```txt\nПроверка `файла`\n```')];
  assert.deepEqual(chatPreviewLines(rows).map(line=>line.text),['Итог','Экран · Состояние','Общий вид · Готово','Проверка файла']);
});

test('preview RPC pages past tools, stays read-only and returns only eight lines', async t => {
  const calls = [];
  const host = createFakePluginHost({ sdk: { threads: {
    timeline: async args => {
      calls.push(args);
      return args.beforeAnchorId
        ? { rows: [message('older', 1, '1\n2\n3\n4\n5\n6\n7\n8', 'user')], timelinePage: {} }
        : { rows: [{ kind: 'work', text: 'SECRET' }], timelinePage: { olderCursor: { anchorId: 'older', anchorSeq: 9 } } };
    },
  } } });
  registerCardChatPreview(host.bb); t.after(() => host.harness.lifecycle.dispose());
  const result = await host.harness.behavior.callRpc('cardChatPreview', { threadId: 'a' });
  assert.equal(result.lines.length, 8); assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal(calls.length, 2); assert.equal(calls[1].beforeAnchorSeq, '9');
  assert.ok(calls.every(call => call.threadId === 'a' && call.segmentLimit === '8' && call.includeNestedRows === 'true'));
  assert.deepEqual(host.harness.inspection.sdk.callsTo('threads.markRead'), []);
});

test('preview RPC stops on an exhausted or repeated cursor and bounds recovery work', async t => {
  let count = 0;
  const host = createFakePluginHost({ sdk: { threads: { timeline: async () => {
    count++; return { rows: [], timelinePage: { olderCursor: { anchorId: 'same', anchorSeq: 1 } } };
  } } } });
  registerCardChatPreview(host.bb); t.after(() => host.harness.lifecycle.dispose());
  assert.deepEqual((await host.harness.behavior.callRpc('cardChatPreview', { threadId: 'empty' })).lines, []);
  assert.equal(count, 2);
});
