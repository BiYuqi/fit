import { mergeMessages } from '../messages';
import type { ChatMessage } from '@/types/chat';

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 'm1',
  date: '2026-07-04',
  role: 'assistant',
  kind: 'text',
  content: null,
  payload: null,
  created_at: '2026-07-04T04:00:00.000Z',
  ...over,
});

describe('mergeMessages（T47：按 id upsert + created_at 重排）', () => {
  it('新消息追加到末尾（时间最新）', () => {
    const cur = [msg({ id: 'a', created_at: '2026-07-04T04:00:00.000Z' })];
    const inc = [msg({ id: 'b', created_at: '2026-07-04T05:00:00.000Z' })];
    expect(mergeMessages(cur, inc).map(m => m.id)).toEqual(['a', 'b']);
  });

  it('已存在 id 整条替换，不产生重复（meal_card 原地更新语义）', () => {
    const cur = [
      msg({ id: 'card', kind: 'meal_card', created_at: '2026-07-04T04:00:00.000Z', payload: { item_count: 3 } }),
      msg({ id: 'a', created_at: '2026-07-04T04:30:00.000Z' }),
    ];
    // 后端 bump：同 id、created_at 更新、payload 变化
    const inc = [msg({ id: 'card', kind: 'meal_card', created_at: '2026-07-04T05:00:00.000Z', payload: { item_count: 4 } })];
    const out = mergeMessages(cur, inc);
    expect(out.map(m => m.id)).toEqual(['a', 'card']); // 卡片浮到末尾（卡片跟随）
    expect(out.filter(m => m.id === 'card')).toHaveLength(1);
    expect((out[1].payload as any).item_count).toBe(4); // 整条替换为最新组装态
  });

  it('date 混用 YYYY-MM-DD 与完整 ISO 时归一比较，先按 date 再按 created_at', () => {
    const cur = [
      msg({ id: 'today', date: '2026-07-04T00:00:00.000Z', created_at: '2026-07-04T01:00:00.000Z' }),
    ];
    // 跨天修改：昨天的 meal_card 被 bump（date 归属昨天，created_at 是现在）
    const inc = [
      msg({ id: 'y-card', kind: 'meal_card', date: '2026-07-03', created_at: '2026-07-04T05:00:00.000Z' }),
    ];
    // 归属日在前的排前面，即便它的 created_at 更新
    expect(mergeMessages(cur, inc).map(m => m.id)).toEqual(['y-card', 'today']);
  });

  it('server 传的完整 ISO date 在入口归一成 YYYY-MM-DD（避免分隔线误判跨天）', () => {
    const cur = [msg({ id: 'am', date: '2026-07-04', created_at: '2026-07-04T01:00:00.000Z' })];
    // 刚从后端回来的今天消息，date 是完整 ISO
    const inc = [msg({ id: 'pm', date: '2026-07-04T00:00:00.000Z', created_at: '2026-07-04T05:00:00.000Z' })];
    const out = mergeMessages(cur, inc);
    expect(out.map(m => m.date)).toEqual(['2026-07-04', '2026-07-04']); // 两条同一天，原始字符串也一致
  });

  it('created_at 相同保持稳定顺序（先到先排）', () => {
    const t = '2026-07-04T04:00:00.000Z';
    const cur = [msg({ id: 'a', created_at: t }), msg({ id: 'b', created_at: t })];
    const inc = [msg({ id: 'c', created_at: t })];
    expect(mergeMessages(cur, inc).map(m => m.id)).toEqual(['a', 'b', 'c']);
  });
});
