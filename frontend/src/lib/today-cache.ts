import { getCached, setCached } from '@/lib/db';
import { appToday } from '@/lib/format';
import type { ContextCard } from '@/types/chat';
import type { TodayResponse } from '@/types/daily';

/** Today 页缓存键。日期入键：跨天自动隔离，昨晚的缓存不会被今天误读。 */
export function todayCacheKey(): string {
  return `today|${appToday()}`;
}

/**
 * 聊天操作（记录/确认/撤销）成功后，用响应携带的 summary_card 写穿 Today 缓存——
 * 切到 Today 页立即渲染新数字。不删键：删键会让下一次进入 Today 缓存 miss 而全屏转圈，
 * 恰好打在「记完餐看一眼今天」这条最高频路径上。
 *
 * ContextCard 不含 tdee / exercise_out / exercises，保留缓存原值（tdee 只随档案变；
 * 运动明细由 Today 激活后的后台刷新触达真值）。缓存不存在或当天还没有 summary 时跳过
 * 合成（缺字段），交给 Today 首次加载走网络。
 */
export async function patchTodayCache(card: ContextCard | undefined): Promise<void> {
  if (!card) return;
  const key = todayCacheKey();
  const cached = await getCached<TodayResponse>(key);
  if (!cached?.summary) return;
  await setCached(key, {
    ...cached,
    summary: {
      ...cached.summary,
      calories_in: card.today.in,
      total_out: card.today.out,
      deficit: card.today.deficit,
      protein: card.today.p,
      fat: card.today.f,
      carbs: card.today.c,
      target_calories: card.targets.calories,
      target_protein: card.targets.protein,
    },
  });
}
