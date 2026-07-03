import { create } from 'zustand';
import { apiFetch } from '@/lib/api';
import { getMessagesInRange, getMessagesAround, getMessageDateById, upsertMessages } from '@/lib/db';
import { localDateStr, dateOnly } from '@/lib/format';
import type { ChatMessage, ContextCard, SendMessageResponse, ResolveResponse, UndoPrevState, FoodAliasEscape } from '@/types/chat';

function todayStr() {
  return localDateStr();
}

// Prevent concurrent loadMoreMessages calls + cooldown after each load
let _loadingMore = false;
let _loadMoreCooldown: ReturnType<typeof setTimeout> | null = null;
let _noMoreData = false;

// Generation counter: bumped by jumpToMessage/jumpToDate so any in-flight
// loadRecentMessages aborts instead of overwriting the jump window.
let _syncGeneration = 0;

type JumpTarget =
  | { type: 'message'; id: string }
  | { type: 'date'; date: string };

type ChatStore = {
  messages: ChatMessage[];
  isSending: boolean;
  isLoading: boolean;
  chatDates: string[];
  summaryCard: ContextCard | null;
  undoneCards: Record<string, true>;
  jumpTarget: JumpTarget | null;

  loadRecentMessages: (token: string) => Promise<void>;
  loadDates: (token: string) => Promise<void>;
  loadMoreMessages: (token: string) => Promise<void>;
  jumpToMessage: (messageId: string) => Promise<void>;
  jumpToDate: (date: string) => Promise<void>;
  clearJumpTarget: () => void;
  send: (text: string, token: string) => Promise<void>;
  resolve: (pendingId: string, choice: string | { grams: number }, token: string) => Promise<void>;
  undo: (messageId: string, recordId: string, prevState: UndoPrevState | undefined, token: string) => Promise<void>;
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
    set({ isLoading: true });

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

      if (older.length === 0) {
        _noMoreData = true; // prevent further loads
      } else {
        set({ messages: [...older, ...messages] });
        // Cooldown before next load — prevents onEndReached loop
        _loadMoreCooldown = setTimeout(() => { _loadMoreCooldown = null; }, 500);
      }
    } finally {
      _loadingMore = false;
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
      const date = newMsgs[0]?.date ?? todayStr();
      await upsertMessages(date, newMsgs);
      set(s => {
        const without = s.messages.filter(m => m.id !== tempId);
        const existingIds = new Set(without.map(m => m.id));
        const toAdd = newMsgs.filter(m => !existingIds.has(m.id));
        return {
          messages: [...without, ...toAdd],
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
      const date = newMsgs[0]?.date ?? todayStr();
      await upsertMessages(date, newMsgs);
      set(s => {
        const existingIds = new Set(s.messages.map(m => m.id));
        const toAdd = newMsgs.filter(m => !existingIds.has(m.id));
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
        const resolvedIdx = nextMessages.findIndex(
          m => (m.payload as any)?.pending_id === pendingId,
        );
        if (resolvedIdx >= 0 && toAdd.length > 0) {
          nextMessages.splice(resolvedIdx + 1, 0, ...toAdd);
        } else {
          nextMessages.push(...toAdd);
        }
        return {
          messages: nextMessages,
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
      const res = await apiFetch<{ ok: boolean; summary_card: ContextCard }>(
        `/api/records/${recordId}/undo`,
        {
          method: 'POST',
          body: JSON.stringify(prevState ? { prev_state: prevState } : {}),
          token,
        },
      );
      set(s => ({ summaryCard: res.summary_card ?? s.summaryCard }));
    } catch {
      set(s => {
        const next = { ...s.undoneCards };
        delete next[messageId];
        return { undoneCards: next };
      });
    }
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
      const date = newMsgs[0]?.date ?? todayStr();
      await upsertMessages(date, newMsgs);
      set(s => {
        const existingIds = new Set(s.messages.map(m => m.id));
        const toAdd = newMsgs.filter(m => !existingIds.has(m.id));
        const idx = s.messages.findIndex(m => m.id === messageId);
        const nextMessages = [...s.messages];
        if (idx >= 0 && toAdd.length > 0) {
          nextMessages.splice(idx + 1, 0, ...toAdd);
        } else {
          nextMessages.push(...toAdd);
        }
        return {
          messages: nextMessages,
          summaryCard: res.summary_card ?? s.summaryCard,
        };
      });
    } catch {
      set(s => {
        const next = { ...s.undoneCards };
        delete next[messageId];
        return { undoneCards: next };
      });
    }
  },
}));
