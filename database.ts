import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { derivationMigration } from './derive-server';
import { mergeMigration } from './merge-resolution';
import { archiveMigration } from './chat-archive-server';
import { notificationMigrations } from './notification-migrations';

export function kanbanDatabase(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS kanban_issues (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
    derivationMigration,
    mergeMigration,
    archiveMigration,
    "CREATE TABLE IF NOT EXISTS kanban_review_workers (issue_id TEXT PRIMARY KEY, worker_id TEXT UNIQUE NOT NULL, request TEXT NOT NULL, revision TEXT NOT NULL)",
    ...notificationMigrations,
  ]);
  return db;
}
