import { randomUUID } from 'node:crypto';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { kanbanDatabase } from './database';
import { issueSchema, issuesChanged, type Issue } from './issues';
import { folderChanged, type RelocateCardsInput } from './project-folders';

type Position = Pick<Issue, 'folderId' | 'status' | 'order' | 'updatedAt'>;
type UndoEntry = { id: string; version: number; previous: Position };

/** One transaction for membership, stage and position. Undo never overwrites a
 * newer edit, agent lifecycle change, deletion or project removal. */
export function projectCardMoves(bb: BbPluginApi, policy: {
  validate: (issue: Pick<Issue, 'folderId' | 'projectId'>) => void;
  availableSection: (id: string) => void; reconcile: (ids: (string | null | undefined)[]) => void;
}) {
  const db = kanbanDatabase(bb);
  const undo = new Map<string, { expires: number; entries: UndoEntry[] }>();
  bb.onDispose(() => undo.clear());
  const list = () => db.prepare('SELECT payload FROM kanban_issues').all()
    .map(row => issueSchema.parse(JSON.parse((row as { payload: string }).payload)));
  const write = db.prepare('UPDATE kanban_issues SET payload=? WHERE id=?');
  const publish = () => { bb.realtime.publish(issuesChanged, null); bb.realtime.publish(folderChanged, null); };
  const check = (issue: Issue | undefined, version: number) => {
    if (!issue || issue.version !== version) throw new Error('Карточка изменилась. Обнови список и повтори перенос.');
    if (issue.busy) throw new Error('Дождись завершения текущего действия карточки.');
    policy.availableSection(issue.projectId);
    return issue;
  };
  function relocate(input: RelocateCardsInput) {
    const now = Date.now();
    for (const [key, value] of undo) if (value.expires < now) undo.delete(key);
    const all = list(), byId = new Map(all.map(issue => [issue.id, issue]));
    const ids = new Set(input.cards.map(card => card.id));
    if (ids.size !== input.cards.length) throw new Error('Одна карточка указана несколько раз.');
    const sources = input.cards.map(card => check(byId.get(card.id), card.version));
    if (new Set(sources.map(issue => issue.projectId)).size !== 1 && (input.folderId !== undefined || input.beforeId))
      throw new Error('Выбери карточки одного раздела.');
    const changes = new Map<string, Issue>();
    const relocating = new Set(sources.filter(issue => !!input.beforeId || !!input.atEnd ||
      (input.folderId !== undefined && input.folderId !== (issue.folderId ?? null)) ||
      (input.status !== undefined && input.status !== issue.status)).map(issue => issue.id));
    const position = (issue: Issue): Position => ({ folderId: issue.folderId ?? null, status: issue.status, order: issue.order, updatedAt: issue.updatedAt });
    const set = (issue: Issue, fields: Partial<Issue>) => changes.set(issue.id, issueSchema.parse({ ...issue, ...fields, version: issue.version + 1 }));
    if (input.beforeId && ids.has(input.beforeId)) return { moved: 0, undoToken: null };
    for (const issue of sources) {
      const target = { ...issue, folderId: input.folderId === undefined ? issue.folderId ?? null : input.folderId,
        status: input.status ?? issue.status };
      policy.validate(target);
      const sameGroup = target.folderId === (issue.folderId ?? null) && target.status === issue.status;
      if (sameGroup && !input.beforeId && !input.atEnd) continue;
      const members = all.filter(candidate => candidate.projectId === issue.projectId && (input.positionScope === 'project' || candidate.status === target.status) &&
        (candidate.folderId ?? null) === target.folderId && !relocating.has(candidate.id));
      if (sameGroup && input.atEnd && [...members, issue].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).at(-1)?.id === issue.id) continue;
      let order = Math.max(-1, ...members.map(candidate => candidate.order)) + 1;
      if (input.beforeId) {
        if (sources.length !== 1) throw new Error('Переставляй по одной карточке.');
        const before = byId.get(input.beforeId);
        if (!before || !members.some(member => member.id === before.id)) throw new Error('Карточка назначения уже перемещена. Повтори перенос.');
        members.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        order = members.findIndex(member => member.id === before.id);
        members.forEach((member, index) => {
          const next = index < order ? index : index + 1;
          if (member.order !== next) set(member, { order: next });
        });
      } else {
        order += sources.slice(0, sources.indexOf(issue)).filter(other => changes.has(other.id) && (input.status ?? other.status) === target.status &&
          (input.folderId === undefined ? other.folderId ?? null : input.folderId) === target.folderId).length;
      }
      set(issue, { folderId: target.folderId, status: target.status, order, updatedAt: now });
    }
    if (!changes.size) return { moved: 0, undoToken: null };
    const entries = [...changes.values()].map(issue => ({ id: issue.id, version: issue.version, previous: position(byId.get(issue.id)!) }));
    const affected = [...sources.flatMap(issue => [issue.folderId, changes.get(issue.id)?.folderId])];
    db.transaction(() => {
      for (const issue of changes.values()) write.run(JSON.stringify(issue), issue.id);
      policy.reconcile(affected);
    })();
    while (undo.size >= 50) undo.delete(undo.keys().next().value!);
    const token = randomUUID(); undo.set(token, { expires: now + 60000, entries });
    publish(); return { moved: sources.filter(issue => changes.has(issue.id)).length, undoToken: token };
  }
  function undoMove({ token }: { token: string }) {
    const saved = undo.get(token);
    if (!saved || saved.expires < Date.now()) { undo.delete(token); throw new Error('Время отмены истекло. Перемести карточки через меню.'); }
    const byId = new Map(list().map(issue => [issue.id, issue]));
    const changes = saved.entries.map(entry => {
      const current = check(byId.get(entry.id), entry.version);
      const restored = issueSchema.parse({ ...current, ...entry.previous, version: current.version + 1 });
      policy.validate(restored); return restored;
    });
    db.transaction(() => {
      for (const issue of changes) write.run(JSON.stringify(issue), issue.id);
      policy.reconcile(changes.flatMap(issue => [issue.folderId, byId.get(issue.id)?.folderId]));
    })();
    undo.delete(token); publish(); return { restored: changes.length };
  }
  return { folderRelocate: relocate, folderUndoMove: undoMove };
}
