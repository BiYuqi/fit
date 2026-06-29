import * as SQLite from 'expo-sqlite';

let _db: SQLite.SQLiteDatabase | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync('fit_cache.db');
  await _db.execAsync(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_date ON chat_messages(date);
  `);
  return _db;
}

export type CachedMessage = {
  id: string;
  date: string;
  role: string;
  content: string;
  payload: string | null;
  created_at: string;
};

export async function getCachedMessages(date: string): Promise<CachedMessage[]> {
  const db = await getDb();
  return db.getAllAsync<CachedMessage>(
    'SELECT * FROM chat_messages WHERE date = ? ORDER BY created_at ASC',
    [date],
  );
}

export async function upsertMessages(
  date: string,
  messages: Array<{
    id: string;
    role: string;
    content: string;
    payload?: unknown;
    created_at: string;
  }>,
): Promise<void> {
  const db = await getDb();
  for (const msg of messages) {
    await db.runAsync(
      'INSERT OR REPLACE INTO chat_messages (id, date, role, content, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        msg.id,
        date,
        msg.role,
        msg.content,
        msg.payload != null ? JSON.stringify(msg.payload) : null,
        msg.created_at,
      ],
    );
  }
}

export async function pruneOldMessages(): Promise<void> {
  const db = await getDb();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  await db.runAsync('DELETE FROM chat_messages WHERE date < ?', [
    cutoff.toISOString().slice(0, 10),
  ]);
}
