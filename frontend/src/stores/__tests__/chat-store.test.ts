// 上翻分页回归测试：历史断更多日（中间整段没聊）时，翻页必须跨过空档继续往前，
// 而不是撞到一段空日期就认定"没有更多了"（那会把更早的历史永久锁在墙后面）。
import { appToday, addDays } from '@/lib/format';
import type { ChatMessage } from '@/types/chat';

// ─── fake SQLite + fake 服务端 ───────────────────────────────────────────
let mockServer: ChatMessage[] = [];
let mockLocal: ChatMessage[] = [];
let mockRangeCalls: string[] = [];
let mockDatesFail = false;

jest.mock('@/lib/db', () => ({
  getMessagesInRange: async (from: string, to: string) =>
    mockLocal
      .filter(m => m.date >= from && m.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date) || a.created_at.localeCompare(b.created_at)),
  upsertMessages: async (date: string, msgs: ChatMessage[]) => {
    for (const m of msgs) {
      mockLocal = mockLocal.filter(x => x.id !== m.id);
      mockLocal.push({ ...m, date: date.slice(0, 10) });
    }
  },
}));

jest.mock('@/lib/api', () => ({
  apiFetch: async (path: string) => {
    if (path.startsWith('/api/chat/dates')) {
      if (mockDatesFail) throw new Error('offline');
      return { dates: [...new Set(mockServer.map(m => m.date))].sort() };
    }
    if (path.startsWith('/api/chat/messages/range')) {
      const q = new URLSearchParams(path.split('?')[1]);
      const from = q.get('from')!;
      const to = q.get('to')!;
      mockRangeCalls.push(`${from}..${to}`);
      return { messages: mockServer.filter(m => m.date >= from && m.date <= to) };
    }
    throw new Error(`unexpected path: ${path}`);
  },
}));

const TOKEN = 'test-token';
const TODAY = appToday();
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

function msg(date: string, i = 0): ChatMessage {
  return {
    id: `${date}#${i}`,
    date,
    role: 'user',
    kind: 'text',
    content: `${date} 的消息`,
    created_at: `${date}T0${i}:00:00.000Z`,
  };
}

// 每个用例拿一份全新的 store 模块——翻页的并发锁/冷却是模块级状态，跨用例会串
function freshStore(): typeof import('@/stores/chat-store').useChatStore {
  let store: typeof import('@/stores/chat-store').useChatStore | undefined;
  jest.isolateModules(() => {
    store = require('@/stores/chat-store').useChatStore;
  });
  return store!;
}

beforeEach(() => {
  mockServer = [];
  mockLocal = [];
  mockRangeCalls = [];
  mockDatesFail = false;
});

describe('chat-store 上翻分页', () => {
  it('断更多日：跨过空档一路翻到最早的聊天日', async () => {
    // 今天聊过，之前断了 25 天，更早还有连着的两天
    mockServer = [msg(TODAY), msg(addDays(TODAY, -25)), msg(addDays(TODAY, -40)), msg(addDays(TODAY, -41))];
    const store = freshStore();

    await store.getState().loadRecentMessages(TOKEN);
    // 最近 7 天窗口只有今天
    expect(store.getState().messages.map(m => m.date)).toEqual([TODAY]);

    await store.getState().loadMoreMessages(TOKEN);
    expect(store.getState().messages.map(m => m.date)).toEqual([
      addDays(TODAY, -41),
      addDays(TODAY, -40),
      addDays(TODAY, -25),
      TODAY,
    ]);
    // 一次请求就跨过了 25 天空档，没有一周一周空转
    expect(mockRangeCalls).toContain(`${addDays(TODAY, -41)}..${addDays(TODAY, -25)}`);
  });

  it('翻到头只是停下，不是永久熔断：出现更早的记录后仍能继续翻', async () => {
    mockServer = [msg(TODAY), msg(addDays(TODAY, -10))];
    const store = freshStore();

    await store.getState().loadRecentMessages(TOKEN);
    await store.getState().loadMoreMessages(TOKEN);
    expect(store.getState().messages).toHaveLength(2);

    // 到头：再翻不加载任何东西
    await wait(550); // 让翻页冷却过去
    const callsBefore = mockRangeCalls.length;
    await store.getState().loadMoreMessages(TOKEN);
    expect(mockRangeCalls).toHaveLength(callsBefore);
    expect(store.getState().messages).toHaveLength(2);

    // 日期表刷新后发现更早的历史 → 照样翻得动（旧实现这里已被 _noMoreData 锁死）
    mockServer.push(msg(addDays(TODAY, -30)));
    await store.getState().loadDates(TOKEN);
    await wait(550);
    await store.getState().loadMoreMessages(TOKEN);
    expect(store.getState().messages.map(m => m.date)).toEqual([
      addDays(TODAY, -30),
      addDays(TODAY, -10),
      TODAY,
    ]);
  });

  it('最近 7 天一条没有：开屏自动回落到最近有聊天的那几天', async () => {
    mockServer = [msg(addDays(TODAY, -20)), msg(addDays(TODAY, -21))];
    const store = freshStore();

    await store.getState().loadRecentMessages(TOKEN);

    expect(store.getState().messages.map(m => m.date)).toEqual([
      addDays(TODAY, -21),
      addDays(TODAY, -20),
    ]);
    expect(store.getState().isLoading).toBe(false);
  });

  it('日期表拿不到时不误判到头，恢复后能补上', async () => {
    mockServer = [msg(TODAY), msg(addDays(TODAY, -15))];
    const store = freshStore();
    await store.getState().loadRecentMessages(TOKEN);

    mockDatesFail = true;
    await store.getState().loadMoreMessages(TOKEN);
    expect(store.getState().messages).toHaveLength(1); // 没翻，但也没锁死

    mockDatesFail = false;
    await store.getState().loadMoreMessages(TOKEN);
    expect(store.getState().messages.map(m => m.date)).toEqual([addDays(TODAY, -15), TODAY]);
  });
});

describe('chat-store 跳转', () => {
  it('jumpToDate：本地无缓存时回源服务端', async () => {
    const target = addDays(TODAY, -50);
    mockServer = [msg(TODAY), msg(target)];
    const store = freshStore();

    await store.getState().jumpToDate(target, TOKEN);

    expect(store.getState().messages.map(m => m.date)).toEqual([target]);
    expect(store.getState().jumpTarget).toEqual({ type: 'date', date: target });
    expect(store.getState().windowTo).toBe(addDays(target, 1));
  });

  it('jumpToMessage：命中的消息只在服务端时也能定位', async () => {
    const target = addDays(TODAY, -60);
    mockServer = [msg(target, 1), msg(target, 2)];
    // 本地只缓存了这天的一条（半截缓存），命中的是另一条
    mockLocal = [msg(target, 1)];
    const store = freshStore();

    await store.getState().jumpToMessage(`${target}#2`, target, TOKEN);

    expect(store.getState().messages.map(m => m.id)).toContain(`${target}#2`);
    expect(store.getState().jumpTarget).toEqual({ type: 'message', id: `${target}#2` });
  });
});
