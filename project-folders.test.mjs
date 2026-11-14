import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './dist/server.js';

async function fixture(t) {
  let clock = 1000;
  t.mock.method(Date, 'now', () => clock);
  const threads = new Map();
  let currentOutput = '{"reply":"Ответ с источником","materials":[]}';
  const { bb, harness } = createFakePluginHost({ agentSkillIds: ['thread-kanban'], sdk: {
    projects: { get: async ({ projectId }) => ({ id: projectId, name: projectId, sources: [] }) },
    threads: {
      get: async ({ threadId }) => threads.get(threadId) ?? makeThreadResponse({ id: threadId, projectId: 'section' }),
      getPluginMetadata: async () => ({}),
      list: async () => [],
      experimental_listCascade: async () => ({ threads: [] }),
      spawn: async (input) => {
        const thread = makeThreadResponse({ id: `worker-${threads.size}`, projectId: input.projectId, visibility: 'hidden' });
        threads.set(thread.id, thread); return thread;
      },
      wait: async () => ({}), output: async () => ({ output: currentOutput }), delete: async () => ({ ok: true }),
    },
  } });
  await plugin(bb);
  t.after(() => harness.lifecycle.dispose());
  const call = (method, input) => harness.behavior.callRpc(method, input);
  const list = () => call('folderList', null);
  const folder = (name = 'Папка', sectionId = 'section') => call('folderCreate', { name, sectionId });
  const card = (folderId, sectionId = 'section') => call('issueCreate', { projectId: sectionId, status: 'todo', ...(folderId ? { folderId } : {}), test: true });
  const issue = async (id) => (await call('issueList', null)).find((item) => item.id === id);
  const assign = async (id, folderId) => call('folderAssign', { issueId: id, folderId, version: (await issue(id)).version });
  const ready = async (id, status = 'ready') => {
    for (let n = 0; n < 100; n++) {
      const item = await call('folderMaterialRead', { id }); if (item.status === status) return item;
      await delay(5);
    }
    assert.fail(`material ${id} never reached ${status}`);
  };
  return { bb, harness, call, list, folder, card, issue, assign, ready, now: (value) => { clock = value; },
    output: (value) => { currentOutput = JSON.stringify(value); } };
}

test('activity ledger covers empty, done-only, partial completion, pause, resume, emptying, reload and deletion with controlled timestamps', async (t) => {
  const f = await fixture(t);
  const p = await f.folder();
  assert.deepEqual([p.elapsedMs, p.activeSince, p.count], [0, null, 0]);
  const first = await f.card();
  await f.call('issueMove', { id: first.id, status: 'done' });
  f.now(2000); await f.assign(first.id, p.id);
  assert.equal((await f.list())[0].activeSince, null);
  f.now(3000); await f.call('issueMove', { id: first.id, status: 'todo' });
  assert.equal((await f.list())[0].activeSince, 3000);
  f.now(4000); const second = await f.card(p.id);
  f.now(5000); await f.call('issueMove', { id: first.id, status: 'done' });
  assert.equal((await f.list())[0].activeSince, 3000);
  f.now(8000); await f.call('issueMove', { id: second.id, status: 'done' });
  assert.deepEqual([(await f.list())[0].elapsedMs, (await f.list())[0].activeSince], [5000, null]);
  f.now(15000); await f.call('issueMove', { id: first.id, status: 'todo' });
  assert.deepEqual([(await f.list())[0].elapsedMs, (await f.list())[0].activeSince], [5000, 15000]);
  f.now(18000); await f.assign(first.id, null);
  assert.deepEqual([(await f.list())[0].elapsedMs, (await f.list())[0].activeSince], [8000, null]);
  f.now(20000); const third = await f.card(p.id);
  f.now(25000);
  const reloaded = await f.harness.lifecycle.reload(plugin);
  t.after(() => reloaded.harness.lifecycle.dispose());
  assert.deepEqual((await reloaded.harness.behavior.callRpc('folderList', null)).map(({ elapsedMs, activeSince }) => ({ elapsedMs, activeSince })),
    [{ elapsedMs: 8000, activeSince: 20000 }]);
  const preview = await reloaded.harness.behavior.callRpc('issueDeletePreview', { id: third.id });
  await reloaded.harness.behavior.callRpc('issueDelete', { id: third.id, confirmation: preview.confirmation });
  assert.deepEqual((await reloaded.harness.behavior.callRpc('folderList', null)).map(({ elapsedMs, activeSince }) => ({ elapsedMs, activeSince })),
    [{ elapsedMs: 13000, activeSince: null }]);
});

test('membership preserves status, chats and history; rejects cross-section and stale moves; restart preserves old payloads and links', async (t) => {
  const f = await fixture(t);
  const a = await f.folder('A'), b = await f.folder('B'), foreign = await f.folder('Other', 'other-section');
  const card = await f.card();
  const db = f.bb.storage.database();
  const old = { ...card, threadIds: ['old-chat'], messages: [{ role: 'user', text: 'Старая история' }], status: 'review' };
  delete old.folderId;
  db.prepare('UPDATE kanban_issues SET payload=? WHERE id=?').run(JSON.stringify(old), card.id);
  await f.assign(card.id, a.id);
  await f.assign(card.id, b.id);
  await assert.rejects(f.assign(card.id, foreign.id), /одном разделе/);
  await assert.rejects(f.call('folderAssign', { issueId: card.id, folderId: null, version: card.version }), /изменилась/);
  let current = await f.issue(card.id);
  assert.equal(current.status, 'review'); assert.deepEqual(current.messages, old.messages); assert.deepEqual(current.threadIds, old.threadIds);
  assert.equal(current.projectId, card.projectId); assert.equal(current.folderId, b.id);
  await f.assign(card.id, null);
  const result = await f.harness.lifecycle.reload(plugin); t.after(() => result.harness.lifecycle.dispose());
  current = (await result.harness.behavior.callRpc('issueList', null))[0];
  assert.equal(current.folderId, null); assert.deepEqual(current.threadIds, ['old-chat']); assert.deepEqual(current.messages, old.messages);
  assert.equal(f.harness.inspection.sdk.callsTo('projects.update').length, 0);
  assert.equal(f.harness.inspection.sdk.callsTo('threads.update').length, 0);
});

test('atomic project moves change membership and stage together, preserve chats, and undo their positions and clocks', async t => {
  const f = await fixture(t);
  const a = await f.folder('A'), b = await f.folder('B');
  const first = await f.card(a.id), second = await f.card(a.id);
  await f.call('issueLink', { id: first.id, threadId: 'kept-chat', linked: true });
  const previous = await Promise.all([f.issue(first.id), f.issue(second.id)]);
  f.now(2000);
  const result = await f.call('folderRelocate', { cards: previous.map(i => ({ id: i.id, version: i.version })), folderId: b.id, status: 'review' });
  assert.equal(result.moved, 2); assert.ok(result.undoToken);
  for (const id of [first.id, second.id]) { const i = await f.issue(id); assert.equal(i.folderId, b.id); assert.equal(i.status, 'review'); }
  assert.deepEqual((await f.issue(first.id)).threadIds, ['kept-chat']);
  assert.equal((await f.list()).find(i => i.id === a.id).activeSince, null);
  assert.equal((await f.list()).find(i => i.id === b.id).activeSince, 2000);
  f.now(3000); await f.call('folderUndoMove', { token: result.undoToken });
  for (const old of previous) { const i = await f.issue(old.id); assert.equal(i.folderId, a.id); assert.equal(i.status, old.status); assert.equal(i.order, old.order); assert.deepEqual(i.threadIds, old.threadIds); }
  assert.equal((await f.list()).find(i => i.id === b.id).activeSince, null);
  assert.equal((await f.list()).find(i => i.id === a.id).activeSince, 3000);
  await assert.rejects(f.call('folderUndoMove', { token: result.undoToken }), /истекло/);
});

test('a stale, busy or foreign member rejects the entire batch without partial membership or stage writes', async t => {
  const f = await fixture(t);
  const a = await f.folder('A'), foreign = await f.folder('Other', 'other');
  const first = await f.card(), second = await f.card();
  const cards = [first, second].map(i => ({ id: i.id, version: i.version }));
  await f.call('issueMove', { id: second.id, status: 'review' });
  await assert.rejects(f.call('folderRelocate', { cards, folderId: a.id, status: 'done' }), /изменилась/);
  assert.equal((await f.issue(first.id)).folderId, null); assert.equal((await f.issue(first.id)).status, 'todo');
  await assert.rejects(f.call('folderRelocate', { cards: [{ id: first.id, version: first.version }], folderId: foreign.id }), /одном разделе/);
  await assert.rejects(f.call('folderRelocate', { cards: [{ id: first.id, version: first.version }], folderId: a.id, status: 'done', beforeId: second.id }), /назначения/);
  const current = await f.issue(second.id);
  f.bb.storage.database().prepare('UPDATE kanban_issues SET payload=? WHERE id=?').run(JSON.stringify({ ...current, busy: { kind: 'planning', token: 'busy', at: 1000 } }), second.id);
  await assert.rejects(f.call('folderRelocate', { cards: [first, current].map(i => ({ id: i.id, version: i.version })), folderId: a.id }), /текущего действия/);
  assert.equal((await f.issue(first.id)).version, first.version);
});

test('bulk stage changes preserve each section and project and remain undoable across sections', async t => {
  const f = await fixture(t); const a = await f.folder('A'), other = await f.folder('Other', 'other');
  const first = await f.card(a.id), second = await f.card(other.id, 'other');
  const result = await f.call('folderRelocate', { cards: [first, second].map(i => ({ id: i.id, version: i.version })), status: 'done' });
  assert.equal(result.moved, 2);
  assert.equal((await f.issue(first.id)).folderId, a.id); assert.equal((await f.issue(second.id)).folderId, other.id);
  assert.equal((await f.issue(second.id)).projectId, 'other');
  await f.call('folderUndoMove', { token: result.undoToken });
  assert.equal((await f.issue(first.id)).status, 'todo'); assert.equal((await f.issue(second.id)).status, 'todo');
});

test('storage failure rolls back every card and mixed batches append after existing unchanged members', async t => {
  const f = await fixture(t); const a = await f.folder('A');
  const first = await f.card(), second = await f.card();
  const db = f.bb.storage.database();
  db.exec(`CREATE TEMP TRIGGER reject_second_move BEFORE UPDATE ON kanban_issues WHEN NEW.id='${second.id}' BEGIN SELECT RAISE(ABORT, 'storage failure'); END`);
  await assert.rejects(f.call('folderRelocate', { cards: [first, second].map(i => ({ id: i.id, version: i.version })), folderId: a.id, status: 'done' }), /storage failure/);
  for (const old of [first, second]) { const item = await f.issue(old.id); assert.equal(item.version, old.version); assert.equal(item.folderId, null); assert.equal(item.status, 'todo'); }
  db.exec('DROP TRIGGER reject_second_move');
  await f.assign(first.id, a.id);
  const current = await f.issue(first.id);
  db.prepare('UPDATE kanban_issues SET payload=? WHERE id=?').run(JSON.stringify({ ...current, order: 100 }), first.id);
  await f.call('folderRelocate', { cards: [await f.issue(first.id), await f.issue(second.id)].map(i => ({ id: i.id, version: i.version })), folderId: a.id });
  assert.equal((await f.issue(first.id)).order, 100); assert.equal((await f.issue(second.id)).order, 101);
});

test('dropping on a card adopts its project and position; undo refuses to overwrite a newer edit on any affected card', async t => {
  const f = await fixture(t);
  const a = await f.folder('A'), b = await f.folder('B');
  const first = await f.card(a.id), second = await f.card(a.id), incoming = await f.card(b.id);
  const result = await f.call('folderRelocate', { cards: [{ id: incoming.id, version: incoming.version }], folderId: a.id, status: 'todo', beforeId: second.id });
  const moved = await f.issue(incoming.id), target = await f.issue(second.id);
  assert.equal(moved.folderId, a.id); assert.equal(moved.order + 1, target.order);
  await f.call('issueSave', { id: target.id, version: target.version, fields: { ...target, title: 'Новая правка' } });
  await assert.rejects(f.call('folderUndoMove', { token: result.undoToken }), /изменилась/);
  assert.equal((await f.issue(incoming.id)).folderId, a.id); assert.equal((await f.issue(second.id)).title, 'Новая правка');
  const noOp = await f.call('folderRelocate', { cards: [{ id: moved.id, version: moved.version }], folderId: a.id, status: 'todo' });
  assert.equal(noOp.moved, 0); assert.equal(noOp.undoToken, null); assert.equal((await f.issue(incoming.id)).version, moved.version);
  const self = await f.call('folderRelocate', { cards: [{ id: moved.id, version: moved.version }], beforeId: moved.id });
  assert.equal(self.moved, 0);
});

test('list reordering preserves different stages, supports dropping at the end and ignores repeated last-position drops', async t => {
  const f = await fixture(t); const a = await f.folder('A');
  const first = await f.card(a.id), second = await f.card(a.id);
  await f.call('issueMove', { id: second.id, status: 'done' });
  const moved = await f.call('folderRelocate', { cards: [{ id: first.id, version: first.version }], folderId: a.id, beforeId: second.id, positionScope: 'project' });
  assert.equal((await f.issue(first.id)).status, 'todo'); assert.equal((await f.issue(second.id)).status, 'done');
  const current = await f.issue(first.id);
  await f.call('folderRelocate', { cards: [{ id: first.id, version: current.version }], folderId: a.id, atEnd: true, positionScope: 'project' });
  const last = await f.issue(first.id); assert.ok(last.order > (await f.issue(second.id)).order);
  const noOp = await f.call('folderRelocate', { cards: [{ id: first.id, version: last.version }], folderId: a.id, atEnd: true, positionScope: 'project' });
  assert.equal(noOp.moved, 0); assert.equal((await f.issue(first.id)).version, last.version);
  assert.ok(moved.undoToken);
});

test('undo expires and a deleted original project cannot be resurrected or leave a partial restore', async t => {
  const f = await fixture(t);
  const a = await f.folder('A'), b = await f.folder('B'); const card = await f.card(a.id);
  const moved = await f.call('folderRelocate', { cards: [{ id: card.id, version: card.version }], folderId: b.id });
  const original = (await f.list()).find(i => i.id === a.id);
  await f.call('folderDelete', { id: a.id, version: original.version });
  await assert.rejects(f.call('folderUndoMove', { token: moved.undoToken }), /не найден/);
  assert.equal((await f.issue(card.id)).folderId, b.id);
  const extracted = await f.call('folderRelocate', { cards: [{ id: card.id, version: (await f.issue(card.id)).version }], folderId: null });
  f.now(62000); await assert.rejects(f.call('folderUndoMove', { token: extracted.undoToken }), /истекло/);
  assert.equal((await f.issue(card.id)).folderId, null);
});

test('FTS retrieves source and revision, invalidates old chunks immediately, isolates projects, and exposes extraction errors', async (t) => {
  const f = await fixture(t);
  const a = await f.folder('A'), b = await f.folder('B');
  const saved = await f.call('folderMaterialSave', { folderId: a.id, title: 'Контрольный факт', format: 'md', text: 'Код обсерватории Сапфир — АЛЬФА729.' });
  assert.equal(saved.status, 'processing');
  const ready = await f.ready(saved.id);
  assert.equal(ready.chunks, 1);
  const search = (folderId, query) => f.call('folderSearch', { folderId, query });
  let hits = await search(a.id, 'Код обсерватории');
  assert.equal(hits[0].materialId, saved.id); assert.equal(hits[0].version, 1); assert.match(hits[0].text, /АЛЬФА729/);
  assert.deepEqual(await search(b.id, 'АЛЬФА729'), []);
  assert.deepEqual(await search(a.id, '" OR * : !!!'), []);
  const updated = await f.call('folderMaterialSave', { ...saved, text: 'Код обсерватории Сапфир — БЕТА914.' });
  assert.deepEqual(await search(a.id, 'АЛЬФА729'), []);
  await f.ready(saved.id);
  hits = await search(a.id, 'БЕТА914'); assert.equal(hits[0].version, 2);
  await assert.rejects(f.call('folderMaterialSave', { ...saved, text: 'stale' }), /изменился/);
  await f.call('folderMaterialSave', { ...updated, format: 'json', text: '{broken' });
  const failed = await f.ready(saved.id, 'error'); assert.ok(failed.error);
  assert.deepEqual(await search(a.id, 'БЕТА914'), []);
  const repaired = await f.call('folderMaterialSave', { ...failed, format: 'html', text: '<script>SECRET</script><p>Код ГАММА532</p>' });
  await f.ready(saved.id); assert.deepEqual(await search(a.id, 'SECRET'), []); assert.equal((await search(a.id, 'ГАММА532')).length, 1);
  await f.call('folderMaterialDelete', { id: repaired.id, version: repaired.version });
  assert.deepEqual(await search(a.id, 'ГАММА532'), []);
  await assert.rejects(f.call('folderMaterialRead', { id: saved.id }), /не найден/);
});

test('current membership gates agent retrieval and instructions, including linked old chats and task planning helpers', async (t) => {
  const f = await fixture(t);
  const a = await f.folder('A'), b = await f.folder('B');
  const card = await f.card(a.id);
  const item = await f.call('folderMaterialSave', { folderId: a.id, title: 'Источник', format: 'txt', text: 'Контрольный код ИРИС418.' });
  await f.ready(item.id);
  await f.call('issueLink', { id: card.id, threadId: 'linked', linked: true });
  const retrieve = async (threadId) => JSON.parse(await f.harness.behavior.callAgentTool('kanban_project_search', { query: 'ИРИС418' }, { threadId }));
  assert.match((await retrieve('linked')).hits[0].text, /ИРИС418/);
  assert.deepEqual((await retrieve('outsider')).hits, []);
  const config = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: 'linked' } }));
  assert.match(config.instructions, /Текущий проект: «A»/);
  assert.ok(config.tools.some((tool) => tool.name === 'kanban_project_search'));
  await f.assign(card.id, b.id);
  assert.deepEqual((await retrieve('linked')).hits, []);
  const changed = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: 'linked' } }));
  assert.match(changed.instructions, /Текущий проект: «B»/); assert.doesNotMatch(changed.instructions, /ИРИС418/);
  await f.assign(card.id, a.id);
  await f.call('issueAsk', { id: card.id, text: 'Какой контрольный код ИРИС418?' });
  const planning = f.harness.inspection.sdk.callsTo('threads.spawn').at(-1);
  assert.match(planning.input?.prompt ?? planning.args?.[0]?.prompt ?? JSON.stringify(planning), /ИРИС418/);
});

test('project assistant receives retrieved facts and can prepare indexed materials; deleting empty folders removes their index', async (t) => {
  const f = await fixture(t);
  const a = await f.folder('A');
  const item = await f.call('folderMaterialSave', { folderId: a.id, title: 'Факт', format: 'md', text: 'Уникальный код РУБИН268.' });
  await f.ready(item.id);
  f.output({ reply: 'Код РУБИН268 [Факт v1]. Материал сохранён.', materials: [{ title: 'Инструкция', text: 'Запомнить шифр НЕОН820.' }] });
  await f.call('folderAsk', { id: a.id, text: 'Найди РУБИН268 и сохрани инструкцию.' });
  for (let n = 0; n < 100 && (await f.list())[0].assistant; n++) await delay(5);
  const current = (await f.list())[0]; assert.equal(current.assistant, null); assert.equal(current.error, null);
  assert.match((await f.call('folderRead', { id: a.id })).messages.at(-1).text, /РУБИН268/);
  const docs = await f.call('folderMaterials', { folderId: a.id }); assert.equal(docs.length, 2);
  const prepared = docs.find((doc) => doc.title === 'Инструкция'); await f.ready(prepared.id);
  assert.equal((await f.call('folderSearch', { folderId: a.id, query: 'НЕОН820' })).length, 1);
  await f.call('folderDelete', { id: a.id, version: current.version });
  assert.deepEqual(await f.list(), []);
  assert.equal(f.bb.storage.database().prepare('SELECT COUNT(*) AS count FROM kanban_project_chunks').get().count, 0);
});

test('interrupted indexing resumes from persisted material after reload', async (t) => {
  const f = await fixture(t);
  const folder = await f.folder();
  const doc = await f.call('folderMaterialSave', { folderId: folder.id, title: 'После перезапуска', format: 'txt', text: 'Маяк АМЕТИСТ651.' });
  const reloaded = await f.harness.lifecycle.reload(plugin); t.after(() => reloaded.harness.lifecycle.dispose());
  await reloaded.harness.behavior.runService('project-folder-recovery').done;
  for (let i = 0; i < 100; i++) {
    const material = await reloaded.harness.behavior.callRpc('folderMaterialRead', { id: doc.id });
    if (material.status === 'ready') break;
    await delay(5);
  }
  const result = await reloaded.harness.behavior.callRpc('folderSearch', { folderId: folder.id, query: 'АМЕТИСТ651' });
  assert.equal(result[0].materialId, doc.id);
});

test('native section deletion preserves folders and cards in Personal and blocks concurrent folder creation', async (t) => {
  const f = await fixture(t);
  const folder = await f.folder();
  const card = await f.card(folder.id);
  await assert.rejects(f.card(folder.id, 'other-section'), /одном разделе/);
  f.harness.sdk.stub('projects.delete', async () => {
    await assert.rejects(f.folder('Concurrent'), /Раздел удаляется/);
    return { ok: true };
  });
  const preview = await f.call('projectRemovalPreview', { projectId: 'section' });
  await f.call('projectRemove', { projectId: 'section', confirmation: preview.confirmation });
  assert.equal((await f.list())[0].sectionId, 'proj_personal');
  assert.equal((await f.issue(card.id)).projectId, 'proj_personal');
  assert.equal((await f.issue(card.id)).folderId, folder.id);
  assert.equal((await f.list())[0].activeSince, 1000);
});

test('folder summaries omit conversation bodies while paged history preserves earlier messages', async (t) => {
  const f = await fixture(t);
  const folder = await f.folder();
  const messages = Array.from({ length: 85 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `message-${i}` }));
  f.bb.storage.database().prepare('UPDATE kanban_project_folders SET payload=? WHERE id=?').run(JSON.stringify({ ...folder, messages }), folder.id);
  assert.deepEqual((await f.list())[0].messages, []);
  const latest = await f.call('folderRead', { id: folder.id });
  assert.equal(latest.messagesTotal, 85); assert.equal(latest.messages[0].text, 'message-45'); assert.equal(latest.nextMessageOffset, 40);
  const earliest = await f.call('folderRead', { id: folder.id, messageOffset: 80 });
  assert.equal(earliest.messages[0].text, 'message-0'); assert.equal(earliest.messages.length, 5); assert.equal(earliest.nextMessageOffset, null);
});

test('deleting a nonempty project extracts every stage in place and preserves chats, history, ordering and busy card work', async (t) => {
  const f = await fixture(t);
  const target = await f.folder('Удаляемая папка'), other = await f.folder('Другая папка');
  const kept = await f.card(other.id);
  const members = [];
  for (const status of ['backlog', 'todo', 'working', 'review', 'done', 'cancelled']) {
    const created = await f.card(target.id);
    await f.call('issueMove', { id: created.id, status });
    members.push(created.id);
  }
  await f.call('issueLink', { id: members[2], threadId: 'working-chat', linked: true });
  const material = await f.call('folderMaterialSave', { folderId: target.id, title: 'Источник', format: 'txt', text: 'Удаляемый факт КВАРЦ701.' });
  await f.ready(material.id);
  const db = f.bb.storage.database();
  const read = (id) => JSON.parse(db.prepare('SELECT payload FROM kanban_issues WHERE id=?').get(id).payload);
  const working = { ...read(members[2]), messages: [{ role: 'user', text: 'Исходная история' }],
    busy: { kind: 'planning', token: 'running-token', at: 1000, threadId: 'planning-chat' }, legacyExtra: { keep: true } };
  db.prepare('UPDATE kanban_issues SET payload=? WHERE id=?').run(JSON.stringify(working), working.id);
  const before = members.map(read), unrelated = read(kept.id);
  const current = await f.call('folderRead', { id: target.id });
  f.now(8000);
  await f.call('folderDelete', { id: target.id, version: current.version });
  for (const expected of before) assert.deepEqual(read(expected.id), { ...expected, folderId: null, version: expected.version + 1 });
  assert.deepEqual(read(kept.id), unrelated);
  assert.equal((await f.list()).length, 1);
  await assert.rejects(f.call('folderRead', { id: target.id }), /не найден/);
  await assert.rejects(f.call('folderMaterialRead', { id: material.id }), /не найден/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kanban_project_chunks WHERE folder_id=?').get(target.id).n, 0);
  const search = JSON.parse(await f.harness.behavior.callAgentTool('kanban_project_search', { query: 'КВАРЦ701' }, { threadId: 'working-chat' }));
  assert.deepEqual(search.hits, []);
  assert.equal(f.harness.inspection.sdk.callsTo('threads.delete').length, 0);
  assert.equal(f.harness.inspection.sdk.callsTo('environments.experimental_cleanup').length, 0);
  const reloaded = await f.harness.lifecycle.reload(plugin); t.after(() => reloaded.harness.lifecycle.dispose());
  const stored = JSON.parse(reloaded.bb.storage.database().prepare('SELECT payload FROM kanban_issues WHERE id=?').get(members[4]).payload);
  assert.equal(stored.folderId, null); assert.equal(stored.status, 'done');
});

test('project deletion rejects a stale confirmation or active project helper and rolls back extraction on a storage failure', async (t) => {
  const f = await fixture(t), folder = await f.folder(), card = await f.card(folder.id);
  const material = await f.call('folderMaterialSave', { folderId: folder.id, title: 'Источник', format: 'md', text: 'Факт ТИТАН554.' });
  await f.ready(material.id);
  const current = await f.call('folderRead', { id: folder.id });
  await assert.rejects(f.call('folderDelete', { id: folder.id, version: folder.version }), /Проект изменился/);
  const db = f.bb.storage.database();
  const readCard = () => db.prepare('SELECT payload FROM kanban_issues WHERE id=?').get(card.id).payload;
  const before = readCard();
  db.prepare('UPDATE kanban_project_folders SET payload=json_set(payload,\'$.assistant\',json(?)) WHERE id=?')
    .run(JSON.stringify({ token: 'project-helper', startedAt: 1000, threadId: 'project-helper-chat' }), folder.id);
  await assert.rejects(f.call('folderDelete', { id: folder.id, version: current.version }), /помощника проекта/);
  db.prepare('UPDATE kanban_project_folders SET payload=json_set(payload,\'$.assistant\',NULL) WHERE id=?').run(folder.id);
  db.exec("CREATE TRIGGER qa_folder_delete_failure BEFORE DELETE ON kanban_project_folders BEGIN SELECT RAISE(ABORT, 'QA delete failed'); END");
  await assert.rejects(f.call('folderDelete', { id: folder.id, version: current.version }), /QA delete failed/);
  assert.equal(readCard(), before);
  assert.equal((await f.call('folderMaterialRead', { id: material.id })).status, 'ready');
  assert.equal((await f.call('folderSearch', { folderId: folder.id, query: 'ТИТАН554' }))[0].materialId, material.id);
  db.exec('DROP TRIGGER qa_folder_delete_failure');
});
