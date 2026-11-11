import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { kanbanDatabase } from './database';

type SoundSettings = { soundEnabled: boolean; soundPreferSystem: boolean };
const imported = 'legacyStatusBarImported';

/** One-way import from BB-managed storage. The source remains intact for rollback. */
export async function migrateStatusBar(bb: BbPluginApi, saveSettings: (values: SoundSettings) => Promise<unknown>) {
  const db = kanbanDatabase(bb);
  if (db.prepare('SELECT 1 FROM config WHERE key = ?').get(imported)) return;
  const source = join(bb.server.experimental_dataDir, 'plugins', 'status-bar', 'data.db');
  if (existsSync(source)) {
    const inventory = await bb.sdk.plugins.list();
    const legacy = inventory.plugins.find(plugin => plugin.id === 'status-bar');
    const settings = legacy ? (await bb.sdk.plugins.getSettings({ pluginId: legacy.id })).values : {};
    // Stop the old producer before taking its final snapshot: one owner and no concurrent deliveries.
    if (legacy?.enabled) await bb.sdk.plugins.disable({ pluginId: legacy.id });
    // The host's SQLite may not support URI mode=ro (notably on Windows).
    // Read the stopped producer's files into our own snapshot; never attach or write its original.
    const directory = join(bb.server.experimental_dataDir, 'plugins', bb.pluginId);
    mkdirSync(directory, { recursive: true });
    const temporary = mkdtempSync(join(directory, '.status-bar-import-'));
    const snapshot = join(temporary, 'data.db');
    let attached = false;
    try {
      copyFileSync(source, snapshot);
      if (existsSync(source + '-wal')) copyFileSync(source + '-wal', snapshot + '-wal');
      db.prepare('ATTACH DATABASE ? AS legacy_status_bar').run(snapshot);
      attached = true;
      const tables = new Set((db.prepare("SELECT name FROM legacy_status_bar.sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
      if (!tables.has('notices') || !tables.has('config')) throw new Error('Не удалось распознать базу прежнего плагина status-bar.');
      db.transaction(() => {
        const columns = {
          notices: ['id','threadId','title','kind','detail','createdAt','readAt','dismissedAt'],
          scans: ['threadId','state'], hidden_legacy: ['threadId'],
          sound_events: ['id','kind','threadId','at','consumedAt','decision'],
          notification_reads: ['threadId','readAt'],
        };
        for (const [table, expected] of Object.entries(columns)) {
          if (!tables.has(table)) continue;
          const available = new Set((db.prepare(`PRAGMA legacy_status_bar.table_info(${table})`).all() as { name: string }[]).map(row => row.name));
          const names = expected.filter(name => available.has(name)).join(',');
          db.exec(`INSERT OR IGNORE INTO ${table} (${names}) SELECT ${names} FROM legacy_status_bar.${table}`);
        }
        db.exec(`INSERT INTO config (key,value) SELECT key,value FROM legacy_status_bar.config WHERE true
          ON CONFLICT(key) DO UPDATE SET value = CASE WHEN config.key = 'since'
            THEN MIN(config.value,excluded.value) ELSE MAX(config.value,excluded.value) END`);
      })();
      await saveSettings({ soundEnabled: settings.soundEnabled === true, soundPreferSystem: settings.soundPreferSystem === true });
    } finally {
      if (attached) db.exec('DETACH DATABASE legacy_status_bar');
      for (const name of readdirSync(temporary)) unlinkSync(join(temporary, name));
      rmdirSync(temporary);
    }
  }
  db.prepare('INSERT OR REPLACE INTO config VALUES (?,?)').run(imported, Date.now());
}
