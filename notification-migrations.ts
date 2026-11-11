export const notificationMigrations = [
    `CREATE TABLE notices (id TEXT PRIMARY KEY, threadId TEXT NOT NULL, title TEXT NOT NULL,
      kind TEXT NOT NULL, detail TEXT NOT NULL, createdAt INTEGER NOT NULL, readAt INTEGER)`,
    `CREATE INDEX notices_thread ON notices(threadId, createdAt)`,
    `CREATE TABLE scans (threadId TEXT PRIMARY KEY, state TEXT NOT NULL)`,
    `CREATE TABLE config (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
    `ALTER TABLE notices ADD COLUMN dismissedAt INTEGER`,
    `CREATE TABLE hidden_legacy (threadId TEXT PRIMARY KEY)`,
    `CREATE TABLE sound_events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, threadId TEXT, at INTEGER NOT NULL, consumedAt INTEGER)`,
    `ALTER TABLE sound_events ADD COLUMN decision TEXT`,
    `CREATE TABLE notification_reads (threadId TEXT PRIMARY KEY, readAt INTEGER NOT NULL)`,
  ];
