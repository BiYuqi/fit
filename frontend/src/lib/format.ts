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

// Show timestamp when gap between messages > 5 minutes
export const CHAT_TIME_GAP_MS = 5 * 60 * 1000;
