import * as SQLite from 'expo-sqlite';
import type { ChatMessage } from '@/types/chat';

let _db: SQLite.SQLiteDatabase | null = null;

type MessageRow = {
  id: string;
  date: string;
  role: string;
  kind: string;
  content: string | null;
  payload: string | null;
  record_id: string | null;
  created_at: string;
};

function parseRow(r: MessageRow): ChatMessage {
  return {
    ...r,
    role: r.role as 'user' | 'assistant',
    kind: (r.kind ?? 'text') as ChatMessage['kind'],
    payload: r.payload ? JSON.parse(r.payload) : null,
  };
}

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync('fit_cache.db');
  await _db.execAsync(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      content TEXT,
      payload TEXT,
      record_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_date ON chat_messages(date);
  `);
  // Migrate existing tables that may be missing newer columns
  try { await _db.execAsync('ALTER TABLE chat_messages ADD COLUMN kind TEXT NOT NULL DEFAULT "text"'); } catch {}
  try { await _db.execAsync('ALTER TABLE chat_messages ADD COLUMN record_id TEXT'); } catch {}
  return _db;
}

export async function getCachedMessages(date: string): Promise<ChatMessage[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<MessageRow>(
    'SELECT * FROM chat_messages WHERE date = ? ORDER BY created_at ASC',
    [date],
  );
  return rows.map(parseRow);
}

export async function upsertMessages(date: string, messages: ChatMessage[]): Promise<void> {
  const db = await getDb();
  for (const msg of messages) {
    await db.runAsync(
      'INSERT OR REPLACE INTO chat_messages (id, date, role, kind, content, payload, record_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        msg.id,
        date,
        msg.role,
        msg.kind ?? 'text',
        msg.content ?? null,
        msg.payload != null ? JSON.stringify(msg.payload) : null,
        msg.record_id ?? null,
        msg.created_at,
      ],
    );
  }
}

export async function pruneOldMessages(): Promise<void> {
  const db = await getDb();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  await db.runAsync('DELETE FROM chat_messages WHERE date < ?', [cutoff.toISOString().slice(0, 10)]);
}

export async function clearCache(): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM chat_messages');
}

export async function getAllMessages(): Promise<ChatMessage[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<MessageRow>(
    'SELECT * FROM chat_messages ORDER BY date ASC, created_at ASC',
  );
  return rows.map(parseRow);
}
