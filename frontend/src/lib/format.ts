// Local timezone date string — avoids toISOString() UTC offset bug (e.g. CST midnight → still yesterday in UTC)
export function localDateStr(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// WeChat-style chat timestamp
export function formatChatTime(isoStr: string): string {
  const date = new Date(isoStr);
  const now = new Date();

  const pad = (n: number) => n.toString().padStart(2, '0');
  const hhmm = `${date.getHours()}:${pad(date.getMinutes())}`;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - msgDay.getTime()) / 86400000);

  if (diffDays === 0) return hhmm;
  if (diffDays === 1) return `昨天 ${hhmm}`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** Parse "YYYY-MM-DD" → Date at local noon (avoids DST/UTC edge cases) */
function parseDateStr(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

export function formatDateLabel(date: string): string {
  const dateOnly = date.slice(0, 10); // handles both "YYYY-MM-DD" and "YYYY-MM-DDTHH:MM:SS.mmmZ"
  const today = localDateStr();
  if (dateOnly === today) return '今天';

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateOnly === localDateStr(yesterday)) return '昨天';

  const d = parseDateStr(dateOnly);
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  return `${d.getMonth() + 1}月${d.getDate()}日 周${weekdays[d.getDay()]}`;
}

// Show timestamp when gap between messages > 5 minutes
export const CHAT_TIME_GAP_MS = 5 * 60 * 1000;
