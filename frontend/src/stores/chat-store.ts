import { create } from 'zustand';
import { apiFetch } from '@/lib/api';
import { getMessagesInRange, upsertMessages } from '@/lib/db';
import { appToday, addDays, dateOnly } from '@/lib/format';
import { mergeMessages } from '@/lib/messages';
import { patchTodayCache } from '@/lib/today-cache';
import type { ChatMessage, ContextCard, SendMessageResponse, ResolveResponse, UndoPrevState } from '@/types/chat';

function todayStr() {
  return appToday();
}

// 写入 SQLite 时按每条消息自身的 date 分组——响应里可能混着不同归属日的消息
// （T47 跨天修改时被刷新的 meal_card 属于昨天的线程），不能统一盖成首条的日期。
async function persistMessages(msgs: ChatMessage[]): Promise<void> {
  const byDate = new Map<string, ChatMessage[]>();
  for (const m of msgs) {
    const d = dateOnly(m.date);
    const list = byDate.get(d);
    if (list) list.push(m);
    else byDate.set(d, [m]);
  }
  for (const [date, list] of byDate) {
    await upsertMessages(date, list);
  }
}

/** 聊天历史可回溯的天数，与服务端 chat_message 保留期一致（见 ARCHITECTURE §6） */
export const CHAT_HISTORY_DAYS = 365;

// 一次上翻加载几个「有聊天的日期」——按自然日翻页会撞进空档（断更十几天很正常），
// 这里翻的是 chatDates 里真正有消息的日子。
const PAGE_CHAT_DAYS = 3;
// 跳转窗口取目标日期前后各几天
const JUMP_WINDOW_DAYS = 1;

// 取一段日期范围的消息：本地 SQLite 优先，本地空则回源服务端并写入缓存。
async function fetchRange(from: string, to: string, token: string): Promise<ChatMessage[]> {
  const local = await getMessagesInRange(from, to);
  if (local.length > 0) return local;
  return fetchRangeFromServer(from, to, token);
}

// 强制回源——本地可能只缓存了这一天的部分消息（如搜索命中的是服务端才有的那条）
async function fetchRangeFromServer(from: string, to: string, token: string): Promise<ChatMessage[]> {
  try {
    const data = await apiFetch<{ messages: ChatMessage[] }>(
      `/api/chat/messages/range?from=${from}&to=${to}`,
      { token },
    );
    if (data.messages.length === 0) return [];
    await persistMessages(data.messages);
    return getMessagesInRange(from, to);
  } catch {
    return [];
  }
}

// Prevent concurrent loadMoreMessages calls + cooldown after each load
let _loadingMore = false;
let _loadMoreCooldown: ReturnType<typeof setTimeout> | null = null;

// Same guards for the newer direction (after a search jump)
let _loadingNewer = false;
let _loadNewerCooldown: ReturnType<typeof setTimeout> | null = null;

// Generation counter: bumped by jumpToMessage/jumpToDate so any in-flight
// loadRecentMessages aborts instead of overwriting the jump window.
let _syncGeneration = 0;

type JumpTarget =
  | { type: 'message'; id: string }
  | { type: 'date'; date: string };

// 跳转窗口的结束日期（含当天）。窗口已覆盖今天时返回 null（= 实时模式，无需向新方向加载）。
function windowToFor(targetDate: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return null;
  const to = addDays(targetDate, 1); // 与 getMessagesAround(date, 1) 的窗口右边界一致
  return to >= todayStr() ? null : to;
}

type ChatStore = {
  messages: ChatMessage[];
  isSending: boolean;
  isLoading: boolean;
  chatDates: string[];
  /** chatDates 是否已成功从服务端拿到——没拿到时不能判定「没有更早的了」 */
  datesLoaded: boolean;
  summaryCard: ContextCard | null;
  // T53：撤销乐观态按 record_id 记（一张餐卡可同时有多条被批量改的记录各自撤销），不再按 messageId
  undoneRecords: Record<string, true>;
  jumpTarget: JumpTarget | null;
  /** 当前窗口结束日期；null = 窗口已含今天（实时模式） */
  windowTo: string | null;

  loadRecentMessages: (token: string) => Promise<void>;
  loadDates: (token: string) => Promise<void>;
  loadMoreMessages: (token: string) => Promise<void>;
  loadNewerMessages: (token: string) => Promise<void>;
  jumpToMessage: (messageId: string, date: string, token: string) => Promise<void>;
  jumpToDate: (date: string, token: string) => Promise<void>;
  clearJumpTarget: () => void;
  send: (text: string, token: string) => Promise<void>;
  resolve: (pendingId: string, choice: string | { grams: number }, token: string) => Promise<void>;
  undo: (recordId: string, prevState: UndoPrevState | undefined, token: string) => Promise<void>;
  undoEvent: (messageId: string, token: string) => Promise<void>;
  reset: () => void;
};

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  isSending: false,
  isLoading: false,
  chatDates: [],
  datesLoaded: false,
  summaryCard: null,
  undoneRecords: {},
  jumpTarget: null,
  windowTo: null,

  loadDates: async (token: string) => {
    try {
      const to = todayStr();
      // 窗口对齐服务端保留期（365 天）——这份日期表同时是上翻分页的路标，
      // 截短了就等于把更早的历史锁在墙后面。
      const fromStr = addDays(to, -(CHAT_HISTORY_DAYS - 1));
      const data = await apiFetch<{ dates: string[] }>(
        `/api/chat/dates?from=${fromStr}&to=${to}`,
        { token },
      );
      const dates = data.dates.includes(to) ? data.dates : [...data.dates, to];
      set({ chatDates: dates, datesLoaded: true });
    } catch {
      // 拿不到就保持原样并维持 datesLoaded=false：分页据此重试，不会误判到头
      set(s => ({ chatDates: s.chatDates.length > 0 ? s.chatDates : [todayStr()] }));
    }
  },

  loadRecentMessages: async (token: string) => {
    const gen = ++_syncGeneration;
    set({ isLoading: true, windowTo: null }); // 最近窗口总是含今天

    const to = todayStr();
    const from = addDays(to, -6); // 7-day display window

    // 1. Read display window from SQLite (instant — data already cached by T26)
    try {
      const cached = await getMessagesInRange(from, to);
      if (_syncGeneration !== gen) return; // cancelled by jump
      if (cached.length > 0) set({ messages: cached });
    } catch { /* ignore */ }

    // 2. Sync from server (catches new messages since last sync)
    //    Card messages now carry `payload.resolved` from the backend — no separate
    //    resolved_pending_ids array needed.
    try {
      const data = await apiFetch<{ messages: ChatMessage[] }>(
        `/api/chat/messages/range?from=${from}&to=${to}`,
        { token },
      );
      if (_syncGeneration !== gen) return; // cancelled by jump
      await persistMessages(data.messages);
      if (_syncGeneration !== gen) return; // cancelled by jump
      // 3. Re-read window (includes server's new messages, each card carrying its own resolved status)
      const window = await getMessagesInRange(from, to);
      if (_syncGeneration !== gen) return; // cancelled by jump
      set({ messages: window });
    } catch { /* keep cache on error */ }

    if (_syncGeneration !== gen) return; // cancelled by jump
    // 最近 7 天一条没有（断更多日）→ 直接翻到最近有聊天的那几天。
    // 否则开屏就是空问候语，而空列表连 onEndReached 都不一定触发，用户无路可走。
    if (get().messages.length === 0) await get().loadMoreMessages(token);

    if (_syncGeneration !== gen) return; // cancelled by jump
    set({ isLoading: false });
  },

  // 上翻加载：以 chatDates（有消息的日期）为路标，一次翻 PAGE_CHAT_DAYS 个有聊天的日子。
  // 不按自然周往前退——中间的空档会被整段跳过，不再被误判成「没有更多了」。
  loadMoreMessages: async (token: string) => {
    if (_loadingMore || _loadMoreCooldown) return;
    _loadingMore = true;

    try {
      if (!get().datesLoaded) await get().loadDates(token);
      const { messages, chatDates, datesLoaded } = get();
      if (!datesLoaded) return; // 日期表没拿到，这次不翻；下次触底重试

      const gen = _syncGeneration; // 跳转会换掉整个窗口，中途返回的旧数据必须丢弃
      // 列表为空时以「今天之后」为锚，让今天也进入候选
      const anchor = messages.length > 0 ? dateOnly(messages[0].date) : addDays(todayStr(), 1);
      const older = chatDates.filter(d => d < anchor);
      if (older.length === 0) return; // 到头了

      const batch = older.slice(-PAGE_CHAT_DAYS);
      const rows = await fetchRange(batch[0], batch[batch.length - 1], token);
      if (_syncGeneration !== gen) return; // cancelled by jump

      if (rows.length > 0) set(s => ({ messages: [...rows, ...s.messages] }));
      // Cooldown before next load — prevents onEndReached loop
      _loadMoreCooldown = setTimeout(() => { _loadMoreCooldown = null; }, 500);
    } finally {
      _loadingMore = false;
    }
  },

  // 搜索跳转后窗口停在历史日期，inverted 列表往下滚（视觉底部 = onStartReached）时
  // 向"更新"方向补载，直到窗口重新覆盖今天。
  loadNewerMessages: async (token: string) => {
    const { windowTo } = get();
    if (!windowTo || _loadingNewer || _loadNewerCooldown) return;

    const gen = _syncGeneration;
    _loadingNewer = true;

    try {
      const fromDate = new Date(windowTo + 'T12:00:00');
      if (isNaN(fromDate.getTime())) return;
      fromDate.setDate(fromDate.getDate() + 1);
      const toDate = new Date(fromDate);
      toDate.setDate(toDate.getDate() + 6);

      const today = todayStr();
      const fromStr = fromDate.toISOString().slice(0, 10);
      let toStr = toDate.toISOString().slice(0, 10);
      if (toStr > today) toStr = today;
      if (fromStr > today) {
        set({ windowTo: null });
        return;
      }

      const newer = await fetchRange(fromStr, toStr, token);

      if (_syncGeneration !== gen) return; // cancelled by jump

      // 空档日（这几天没聊过）也要推进窗口，否则会卡在原地反复查同一段
      const nextWindowTo = toStr >= today ? null : toStr;
      if (newer.length > 0) {
        set(s => ({ messages: [...s.messages, ...newer], windowTo: nextWindowTo }));
      } else {
        set({ windowTo: nextWindowTo });
      }
      _loadNewerCooldown = setTimeout(() => { _loadNewerCooldown = null; }, 500);
    } finally {
      _loadingNewer = false;
    }
  },

  // date 由调用方带上（搜索结果自带）：命中的那条可能只在服务端有，本地查不出日期。
  jumpToMessage: async (messageId: string, date: string, token: string) => {
    _syncGeneration++; // cancel any in-flight loadRecentMessages
    try {
      const targetDate = dateOnly(date);
      const from = addDays(targetDate, -JUMP_WINDOW_DAYS);
      const to = addDays(targetDate, JUMP_WINDOW_DAYS);
      let window = await fetchRange(from, to, token);
      // 本地缓存了这几天的一部分但没有目标那条 → 强制回源补全，否则跳过去定位不到
      if (!window.some(m => m.id === messageId)) {
        window = await fetchRangeFromServer(from, to, token);
      }
      if (window.length === 0) {
        console.warn('[jumpToMessage] empty window for date:', targetDate);
        set({ isLoading: false });
        return;
      }
      set({
        messages: window,
        jumpTarget: { type: 'message', id: messageId },
        isLoading: false,
        windowTo: windowToFor(targetDate),
      });
    } catch (e) {
      console.error('[jumpToMessage] error:', e);
      set({ isLoading: false });
    }
  },

  jumpToDate: async (date: string, token: string) => {
    _syncGeneration++; // cancel any in-flight loadRecentMessages
    try {
      const targetDate = dateOnly(date);
      const window = await fetchRange(
        addDays(targetDate, -JUMP_WINDOW_DAYS),
        addDays(targetDate, JUMP_WINDOW_DAYS),
        token,
      );
      if (window.length === 0) {
        console.warn('[jumpToDate] empty window for date:', targetDate);
        set({ isLoading: false });
        return;
      }
      set({
        messages: window,
        jumpTarget: { type: 'date', date: targetDate },
        isLoading: false,
        windowTo: windowToFor(targetDate),
      });
    } catch (e) {
      console.error('[jumpToDate] error:', e);
      set({ isLoading: false });
    }
  },

  clearJumpTarget: () => set({ jumpTarget: null }),

  send: async (text: string, token: string) => {
    const tempId = `temp-${Date.now()}`;
    const optimistic: ChatMessage = {
      id: tempId,
      date: todayStr(),
      role: 'user',
      kind: 'text',
      content: text,
      created_at: new Date().toISOString(),
    };
    set(s => ({ messages: [...s.messages, optimistic], isSending: true }));

    try {
      const res = await apiFetch<SendMessageResponse>('/api/chat/message', {
        method: 'POST',
        body: JSON.stringify({ text, source: 'text' }),
        token,
      });
      const newMsgs = res.messages as ChatMessage[];
      await persistMessages(newMsgs);
      set(s => {
        const without = s.messages.filter(m => m.id !== tempId);
        // T38：本轮打字回答了某张待确认卡片——把聊天流里那张旧卡就地标记已确认，
        // 防止用户在同一屏幕上还能再点一次（resolve 接口本身有 status=pending 防线兜底，这里是体验层同步）
        const resolvedId = res.resolved_pending_id;
        const withResolved = resolvedId
          ? without.map(m =>
              (m.payload as any)?.pending_id === resolvedId
                ? { ...m, payload: { ...(m.payload as any), resolved: true } }
                : m,
            )
          : without;
        // T47：按 id upsert + created_at 重排——meal_card 原地更新后浮到聊天流末尾（卡片跟随）
        return {
          messages: mergeMessages(withResolved, newMsgs),
          summaryCard: res.summary_card ?? s.summaryCard,
        };
      });
      get().loadDates(token);
      void patchTodayCache(res.summary_card); // T57: 写穿 Today 缓存，切页秒出新数字
    } catch (e) {
      set(s => ({ messages: s.messages.filter(m => m.id !== tempId) }));
      throw e;
    } finally {
      set({ isSending: false });
    }
  },

  resolve: async (pendingId: string, choice: string | { grams: number }, token: string) => {
    try {
      const res = await apiFetch<ResolveResponse>(`/api/pending/${pendingId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ choice }),
        token,
      });
      const newMsgs = res.messages as ChatMessage[];
      await persistMessages(newMsgs);
      set(s => {
        // Look up the card's portions for unit info
        const card = s.messages.find(m => (m.payload as any)?.pending_id === pendingId);
        const portions = ((card?.payload as any)?.portions ?? []) as Array<{ label: string; grams: number; unit?: string }>;
        // Enrich the card's payload with resolution details so it renders correctly
        let resolution: Record<string, unknown> = { resolved: true };
        if (typeof choice === 'object' && 'grams' in choice) {
          resolution.resolved_grams = choice.grams;
          resolution.resolved_unit = portions.find(p => p.label === 'custom')?.unit ?? 'g';
        } else {
          const chosen = portions.find(p => p.label === choice);
          resolution.resolved_portion = choice as string;
          resolution.resolved_grams = chosen?.grams;
          resolution.resolved_unit = chosen?.unit ?? 'g';
        }
        const nextMessages = s.messages.map(m =>
          (m.payload as any)?.pending_id === pendingId
            ? { ...m, payload: { ...(m.payload as any), ...resolution } }
            : m,
        );
        // T47：新消息（文本确认 + 被 bump 的 meal_card）统一按 id upsert + created_at 重排
        return {
          messages: mergeMessages(nextMessages, newMsgs),
          summaryCard: res.summary_card ?? s.summaryCard,
        };
      });
      void patchTodayCache(res.summary_card); // T57: 写穿 Today 缓存
    } catch {
      // On failure, still mark as resolved so the card doesn't look stuck
      set(s => ({
        messages: s.messages.map(m =>
          (m.payload as any)?.pending_id === pendingId
            ? { ...m, payload: { ...(m.payload as any), resolved: true } }
            : m,
        ),
      }));
    }
  },

  undo: async (recordId: string, prevState: UndoPrevState | undefined, token: string) => {
    // 乐观态按 record_id：批量改的多条各自撤销，互不影响
    set(s => ({ undoneRecords: { ...s.undoneRecords, [recordId]: true } }));
    try {
      const res = await apiFetch<{ ok: boolean; summary_card: ContextCard; messages?: ChatMessage[] }>(
        `/api/records/${recordId}/undo`,
        {
          method: 'POST',
          body: JSON.stringify(prevState ? { prev_state: prevState } : {}),
          token,
        },
      );
      // T47/T53：撤销后后端返回刷新过的 meal_card（仅该条撤销态被清除）——原地更新并浮到末尾
      const newMsgs = (res.messages ?? []) as ChatMessage[];
      if (newMsgs.length > 0) await persistMessages(newMsgs);
      set(s => ({
        messages: newMsgs.length > 0 ? mergeMessages(s.messages, newMsgs) : s.messages,
        summaryCard: res.summary_card ?? s.summaryCard,
      }));
      void patchTodayCache(res.summary_card); // T57: 写穿 Today 缓存
    } catch {
      set(s => {
        const next = { ...s.undoneRecords };
        delete next[recordId];
        return { undoneRecords: next };
      });
    }
  },

  // T49：删除事件行「撤销」——记录已被真删除，后端按事件消息自带的快照重建（新 id）。
  // 幂等：接口内部按 payload.undone 短路，这里不需要额外的本地乐观态防重复点击（disabled 靠组件自己的 loading）。
  undoEvent: async (messageId: string, token: string) => {
    const res = await apiFetch<{ ok: boolean; summary_card: ContextCard; messages: ChatMessage[] }>(
      `/api/chat/events/${messageId}/undo`,
      { method: 'POST', body: '{}', token },
    );
    const newMsgs = res.messages ?? [];
    if (newMsgs.length > 0) await persistMessages(newMsgs);
    set(s => ({
      messages: newMsgs.length > 0 ? mergeMessages(s.messages, newMsgs) : s.messages,
      summaryCard: res.summary_card ?? s.summaryCard,
    }));
    void patchTodayCache(res.summary_card); // T57: 写穿 Today 缓存
  },

  // 登出时重置内存态：zustand store 跨组件卸载存活，换号不清会把上个账号的
  // 聊天流/上下文卡直接渲染给新账号（SQLite 侧由 auth-store 清表）
  reset: () => set({
    messages: [],
    isSending: false,
    isLoading: false,
    chatDates: [],
    datesLoaded: false,
    summaryCard: null,
    undoneRecords: {},
    jumpTarget: null,
    windowTo: null,
  }),
}));
