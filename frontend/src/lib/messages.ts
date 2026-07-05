import { dateOnly } from '@/lib/format';
import type { ChatMessage } from '@/types/chat';

// T47：消息合并统一口径——按 id upsert（已存在则整条替换：meal_card 原地更新语义），
// 再按 (date, created_at) 稳定重排序，与 SQLite 读取口径（ORDER BY date, created_at）一致。
// meal_card 内容变更时后端刷新同一条消息的 created_at，重排序后卡片"浮"到聊天流末尾（卡片跟随）。
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>(current.map(m => [m.id, m]));
  // date 在入口归一成 "YYYY-MM-DD"（server 传完整 ISO，SQLite 已归一）——让内存口径
  // 与 SQLite parseRow 一致，否则日期分隔线/跳转按原始字符串比较会误判跨天。
  for (const m of incoming) {
    byId.set(m.id, m.date.length > 10 ? { ...m, date: dateOnly(m.date) } : m);
  }
  // 归一后字典序即时间序；created_at 是 ISO 字符串，字典序即时间序。
  // sort 稳定，同刻消息保持原相对顺序。
  return [...byId.values()].sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    if (d !== 0) return d;
    return a.created_at.localeCompare(b.created_at);
  });
}
