import * as SQLite from 'expo-sqlite';
import type { ChatMessage } from '@/types/chat';
import { dateOnly } from '@/lib/format';

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
    date: dateOnly(r.date), // normalize at read boundary
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
  // Normalize existing date values from full ISO → "YYYY-MM-DD"
  try { await _db.execAsync("UPDATE chat_messages SET date = substr(date, 1, 10) WHERE length(date) > 10"); } catch {}
  // T57: API response cache for Today / History / Settings / Profile
  await _db.execAsync(`
    CREATE TABLE IF NOT EXISTS api_cache (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
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
  const d = dateOnly(date); // normalize at write boundary
  for (const msg of messages) {
    await db.runAsync(
      'INSERT OR REPLACE INTO chat_messages (id, date, role, kind, content, payload, record_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        msg.id,
        d,
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

/** 精确日期范围查询。from/to 均包含，接受 "YYYY-MM-DD" 和完整 ISO 两种格式。 */
export async function getMessagesInRange(
  from: string,
  to: string,
): Promise<ChatMessage[]> {
  const db = await getDb();
  // date() handles both "YYYY-MM-DD" and full ISO stored before migration
  const rows = await db.getAllAsync<MessageRow>(
    'SELECT * FROM chat_messages WHERE date(date) >= date(?) AND date(date) <= date(?) ORDER BY date ASC, created_at ASC',
    [from, to],
  );
  return rows.map(parseRow);
}

/** 居中窗口查询——加载目标日期前后各 windowDays 天的消息。 */
export async function getMessagesAround(
  date: string,
  windowDays = 3,
): Promise<ChatMessage[]> {
  const d = new Date(dateOnly(date) + 'T12:00:00');
  if (isNaN(d.getTime())) return [];
  const from = new Date(d);
  from.setDate(from.getDate() - windowDays);
  const to = new Date(d);
  to.setDate(to.getDate() + windowDays);
  return getMessagesInRange(
    from.toISOString().slice(0, 10),
    to.toISOString().slice(0, 10),
  );
}

/** 搜索消息 — SQLite LIKE，按日期倒序。 */
export async function searchMessages(
  query: string,
  limit = 50,
): Promise<ChatMessage[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<MessageRow>(
    'SELECT * FROM chat_messages WHERE kind = ? AND content LIKE ? ORDER BY date DESC, created_at DESC LIMIT ?',
    ['text', `%${query}%`, limit],
  );
  return rows.map(parseRow);
}

/** 根据 id 查消息日期。不存在返回 null。返回 "YYYY-MM-DD"。 */
export async function getMessageDateById(id: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ date: string }>(
    'SELECT date FROM chat_messages WHERE id = ?',
    [id],
  );
  return row?.date ?? null;
}

// ── T57: API response cache ────────────────────────────────────────────────

/** Read a cached API response. Returns null on miss / parse error. */
export async function getCached<T = unknown>(key: string): Promise<T | null> {
  try {
    const db = await getDb();
    const row = await db.getFirstAsync<{ data: string }>(
      'SELECT data FROM api_cache WHERE key = ?',
      [key],
    );
    if (!row) return null;
    return JSON.parse(row.data) as T;
  } catch {
    return null;
  }
}

/** Write an API response to cache. */
export async function setCached(key: string, data: unknown): Promise<void> {
  try {
    const db = await getDb();
    await db.runAsync(
      'INSERT OR REPLACE INTO api_cache (key, data, updated_at) VALUES (?, ?, ?)',
      [key, JSON.stringify(data), new Date().toISOString()],
    );
  } catch { /* cache write is best-effort */ }
}

/** Delete a single cache key. */
export async function delCached(key: string): Promise<void> {
  try {
    const db = await getDb();
    await db.runAsync('DELETE FROM api_cache WHERE key = ?', [key]);
  } catch { /* best-effort */ }
}

/** Clear all cached API responses (called on logout). */
export async function clearApiCache(): Promise<void> {
  try {
    const db = await getDb();
    await db.runAsync('DELETE FROM api_cache');
  } catch { /* best-effort */ }
}
