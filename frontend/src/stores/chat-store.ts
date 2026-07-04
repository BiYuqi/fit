import { create } from 'zustand';
import { apiFetch } from '@/lib/api';
import { getMessagesInRange, getMessagesAround, getMessageDateById, upsertMessages } from '@/lib/db';
import { localDateStr, dateOnly } from '@/lib/format';
import { mergeMessages } from '@/lib/messages';
import type { ChatMessage, ContextCard, SendMessageResponse, ResolveResponse, UndoPrevState, FoodAliasEscape } from '@/types/chat';

function todayStr() {
  return localDateStr();
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

// Prevent concurrent loadMoreMessages calls + cooldown after each load
let _loadingMore = false;
let _loadMoreCooldown: ReturnType<typeof setTimeout> | null = null;
let _noMoreData = false;

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
  const d = new Date(targetDate + 'T12:00:00');
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + 1); // 与 getMessagesAround(date, 1) 的窗口右边界一致
  const to = d.toISOString().slice(0, 10);
  return to >= todayStr() ? null : to;
}

type ChatStore = {
  messages: ChatMessage[];
  isSending: boolean;
  isLoading: boolean;
  chatDates: string[];
  summaryCard: ContextCard | null;
  undoneCards: Record<string, true>;
  jumpTarget: JumpTarget | null;
  /** 当前窗口结束日期；null = 窗口已含今天（实时模式） */
  windowTo: string | null;

  loadRecentMessages: (token: string) => Promise<void>;
  loadDates: (token: string) => Promise<void>;
  loadMoreMessages: (token: string) => Promise<void>;
  loadNewerMessages: (token: string) => Promise<void>;
  jumpToMessage: (messageId: string) => Promise<void>;
  jumpToDate: (date: string) => Promise<void>;
  clearJumpTarget: () => void;
  send: (text: string, token: string) => Promise<void>;
  resolve: (pendingId: string, choice: string | { grams: number }, token: string) => Promise<void>;
  undo: (messageId: string, recordId: string, prevState: UndoPrevState | undefined, token: string) => Promise<void>;
  undoEvent: (messageId: string, token: string) => Promise<void>;
  resetAlias: (messageId: string, recordId: string, escape: FoodAliasEscape, token: string) => Promise<void>;
};

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  isSending: false,
  isLoading: false,
  chatDates: [],
  summaryCard: null,
  undoneCards: {},
  jumpTarget: null,
  windowTo: null,

  loadDates: async (token: string) => {
    try {
      const to = todayStr();
      const from = new Date();
      from.setDate(from.getDate() - 89);
      const fromStr = localDateStr(from);
      const data = await apiFetch<{ dates: string[] }>(
        `/api/chat/dates?from=${fromStr}&to=${to}`,
        { token },
      );
      const dates = data.dates.includes(to) ? data.dates : [...data.dates, to];
      set({ chatDates: dates });
    } catch {
      set({ chatDates: [todayStr()] });
    }
  },

  loadRecentMessages: async (token: string) => {
    const gen = ++_syncGeneration;
    set({ isLoading: true, windowTo: null }); // 最近窗口总是含今天

    const to = todayStr();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 6); // 7-day display window
    const from = localDateStr(fromDate);

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
      const byDate = new Map<string, ChatMessage[]>();
      for (const m of data.messages) {
        const list = byDate.get(m.date);
        if (list) list.push(m);
        else byDate.set(m.date, [m]);
      }
      for (const [date, msgs] of byDate) {
        await upsertMessages(date, msgs);
      }
      if (_syncGeneration !== gen) return; // cancelled by jump
      // 3. Re-read window (includes server's new messages, each card carrying its own resolved status)
      const window = await getMessagesInRange(from, to);
      if (_syncGeneration !== gen) return; // cancelled by jump
      set({ messages: window });
    } catch { /* keep cache on error */ }

    if (_syncGeneration !== gen) return; // cancelled by jump
    set({ isLoading: false });
  },

  loadMoreMessages: async (token: string) => {
    if (_loadingMore || _loadMoreCooldown || _noMoreData) return;
    const { messages } = get();
    if (messages.length === 0) return;

    const gen = _syncGeneration; // 跳转会换掉整个窗口，中途返回的旧数据必须丢弃
    _loadingMore = true;

    try {
      const earliestDate = dateOnly(messages[0].date);
      const toDate = new Date(earliestDate + 'T12:00:00');
      if (isNaN(toDate.getTime())) return; // invalid date guard
      toDate.setDate(toDate.getDate() - 1);
      const fromDate = new Date(toDate);
      fromDate.setDate(fromDate.getDate() - 6);

      const fromStr = fromDate.toISOString().slice(0, 10);
      const toStr = toDate.toISOString().slice(0, 10);

      let older = await getMessagesInRange(fromStr, toStr);

      // SQLite empty (fresh install) → fallback to server
      if (older.length === 0) {
        try {
          const data = await apiFetch<{ messages: ChatMessage[] }>(
            `/api/chat/messages/range?from=${fromStr}&to=${toStr}`,
            { token },
          );
          if (data.messages.length > 0) {
            const byDate = new Map<string, ChatMessage[]>();
            for (const m of data.messages) {
              const list = byDate.get(m.date);
              if (list) list.push(m);
              else byDate.set(m.date, [m]);
            }
            for (const [date, msgs] of byDate) {
              await upsertMessages(date, msgs);
            }
            older = await getMessagesInRange(fromStr, toStr);
          }
        } catch { /* stay empty */ }
      }

      if (_syncGeneration !== gen) return; // cancelled by jump

      if (older.length === 0) {
        _noMoreData = true; // prevent further loads
      } else {
        set(s => ({ messages: [...older, ...s.messages] }));
        // Cooldown before next load — prevents onEndReached loop
        _loadMoreCooldown = setTimeout(() => { _loadMoreCooldown = null; }, 500);
      }
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

      let newer = await getMessagesInRange(fromStr, toStr);

      // SQLite empty (fresh install) → fallback to server
      if (newer.length === 0) {
        try {
          const data = await apiFetch<{ messages: ChatMessage[] }>(
            `/api/chat/messages/range?from=${fromStr}&to=${toStr}`,
            { token },
          );
          if (data.messages.length > 0) {
            await persistMessages(data.messages);
            newer = await getMessagesInRange(fromStr, toStr);
          }
        } catch { /* stay empty */ }
      }

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

  jumpToMessage: async (messageId: string) => {
    _syncGeneration++; // cancel any in-flight loadRecentMessages
    try {
      const targetDateFull = await getMessageDateById(messageId);
      if (!targetDateFull) {
        console.warn('[jumpToMessage] message not found in SQLite:', messageId);
        set({ isLoading: false });
        return;
      }
      const targetDate = dateOnly(targetDateFull);
      const window = await getMessagesAround(targetDate, 1);
      if (window.length === 0) {
        console.warn('[jumpToMessage] empty window for date:', targetDate);
        set({ isLoading: false });
        return;
      }
      _noMoreData = false;
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

  jumpToDate: async (date: string) => {
    _syncGeneration++; // cancel any in-flight loadRecentMessages
    try {
      const targetDate = dateOnly(date);
      const window = await getMessagesAround(targetDate, 1);
      if (window.length === 0) {
        console.warn('[jumpToDate] empty window for date:', targetDate);
        set({ isLoading: false });
        return;
      }
      _noMoreData = false;
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

  undo: async (messageId: string, recordId: string, prevState: UndoPrevState | undefined, token: string) => {
    set(s => ({ undoneCards: { ...s.undoneCards, [messageId]: true } }));
    try {
      const res = await apiFetch<{ ok: boolean; summary_card: ContextCard; messages?: ChatMessage[] }>(
        `/api/records/${recordId}/undo`,
        {
          method: 'POST',
          body: JSON.stringify(prevState ? { prev_state: prevState } : {}),
          token,
        },
      );
      // T47：撤销后后端返回刷新过的 meal_card（last_change 已清除）——原地更新并浮到末尾
      const newMsgs = (res.messages ?? []) as ChatMessage[];
      if (newMsgs.length > 0) await persistMessages(newMsgs);
      set(s => ({
        messages: newMsgs.length > 0 ? mergeMessages(s.messages, newMsgs) : s.messages,
        summaryCard: res.summary_card ?? s.summaryCard,
      }));
    } catch {
      set(s => {
        const next = { ...s.undoneCards };
        delete next[messageId];
        return { undoneCards: next };
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
  },

  // 「不是它？」逃生口：用户食物直连自动匹配错了，撤销该记录 + 清零 streak + 重发候选卡
  resetAlias: async (messageId: string, recordId: string, escape: FoodAliasEscape, token: string) => {
    set(s => ({ undoneCards: { ...s.undoneCards, [messageId]: true } }));
    try {
      const res = await apiFetch<ResolveResponse>('/api/learning/alias/reset', {
        method: 'POST',
        body: JSON.stringify({
          canonical: escape.canonical,
          record_id: recordId,
          portions: escape.portions,
          chosen_label: escape.chosen_label,
          ai_candidates: escape.ai_candidates,
        }),
        token,
      });
      const newMsgs = res.messages as ChatMessage[];
      await persistMessages(newMsgs);
      // T47：统一按 id upsert + created_at 重排（新候选卡时间最新，自然落在流末尾）
      set(s => ({
        messages: mergeMessages(s.messages, newMsgs),
        summaryCard: res.summary_card ?? s.summaryCard,
      }));
    } catch {
      set(s => {
        const next = { ...s.undoneCards };
        delete next[messageId];
        return { undoneCards: next };
      });
    }
  },
}));
