import { create } from 'zustand';
import { apiFetch } from '@/lib/api';
import { getCachedMessages, upsertMessages } from '@/lib/db';
import type { ChatMessage, ContextCard, SendMessageResponse, ResolveResponse, UndoPrevState } from '@/types/chat';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

type ChatStore = {
  messages: ChatMessage[];
  selectedDate: string;
  isSending: boolean;
  isLoading: boolean;
  chatDates: string[];
  summaryCard: ContextCard | null;
  resolvedPendings: Record<string, true>;
  undoneCards: Record<string, true>; // 按"卡片(消息 id)"标记已撤销，非 record_id（同一记录可有多张卡）

  loadForDate: (date: string, token: string) => Promise<void>;
  loadDates: (token: string) => Promise<void>;
  send: (text: string, token: string) => Promise<void>;
  resolve: (pendingId: string, choice: string | { grams: number }, token: string) => Promise<void>;
  undo: (messageId: string, recordId: string, prevState: UndoPrevState | undefined, token: string) => Promise<void>;
  setDate: (date: string, token: string) => void;
};

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  selectedDate: todayStr(),
  isSending: false,
  isLoading: false,
  chatDates: [],
  summaryCard: null,
  resolvedPendings: {},
  undoneCards: {},

  loadDates: async (token: string) => {
    try {
      const to = todayStr();
      const from = new Date();
      from.setDate(from.getDate() - 89);
      const fromStr = from.toISOString().slice(0, 10);
      const data = await apiFetch<{ dates: string[] }>(
        `/api/chat/dates?from=${fromStr}&to=${to}`,
        { token },
      );
      // Ensure today is always in the list
      const dates = data.dates.includes(to) ? data.dates : [...data.dates, to];
      set({ chatDates: dates });
    } catch {
      set({ chatDates: [todayStr()] });
    }
  },

  loadForDate: async (date: string, token: string) => {
    set({ isLoading: true, selectedDate: date });
    // 1. Show cached immediately
    try {
      const cached = await getCachedMessages(date);
      set({ messages: cached });
    } catch {
      // ignore
    }
    // 2. Sync from server
    try {
      const data = await apiFetch<{ date: string; messages: ChatMessage[]; resolved_pending_ids?: string[] }>(
        `/api/chat/messages?date=${date}`,
        { token },
      );
      await upsertMessages(date, data.messages);
      const resolvedFromServer: Record<string, true> = {};
      for (const id of data.resolved_pending_ids ?? []) {
        resolvedFromServer[id] = true;
      }
      set(s => ({ messages: data.messages, resolvedPendings: { ...s.resolvedPendings, ...resolvedFromServer } }));
    } catch {
      // keep cache on error
    }
    set({ isLoading: false });
  },

  send: async (text: string, token: string) => {
    const date = get().selectedDate;
    const tempId = `temp-${Date.now()}`;
    const optimistic: ChatMessage = {
      id: tempId,
      date,
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
      // Refresh date list (today now has messages)
      get().loadDates(token);
    } catch (e) {
      set(s => ({ messages: s.messages.filter(m => m.id !== tempId) }));
      throw e;
    } finally {
      set({ isSending: false });
    }
  },

  resolve: async (pendingId: string, choice: string | { grams: number }, token: string) => {
    const date = get().selectedDate;
    try {
      const res = await apiFetch<ResolveResponse>(`/api/pending/${pendingId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ choice }),
        token,
      });
      const newMsgs = res.messages as ChatMessage[];
      await upsertMessages(date, newMsgs);
      set(s => {
        const existingIds = new Set(s.messages.map(m => m.id));
        const toAdd = newMsgs.filter(m => !existingIds.has(m.id));
        // 将 record_card 插到被解决的 pending 卡正后方，而不是追加到末尾
        const resolvedIdx = s.messages.findIndex(
          m => (m.payload as any)?.pending_id === pendingId,
        );
        let nextMessages: ChatMessage[];
        if (resolvedIdx >= 0 && toAdd.length > 0) {
          nextMessages = [...s.messages];
          nextMessages.splice(resolvedIdx + 1, 0, ...toAdd);
        } else {
          nextMessages = [...s.messages, ...toAdd];
        }
        return {
          messages: nextMessages,
          summaryCard: res.summary_card ?? s.summaryCard,
          resolvedPendings: { ...s.resolvedPendings, [pendingId]: true },
        };
      });
    } catch {
      // Already resolved or other error — mark resolved so buttons go away
      set(s => ({
        resolvedPendings: { ...s.resolvedPendings, [pendingId]: true },
      }));
    }
  },

  undo: async (messageId: string, recordId: string, prevState: UndoPrevState | undefined, token: string) => {
    // 乐观置灰这张卡（按消息 id，不影响同一记录的其它卡），避免重复点击
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
      // 撤销失败 → 回滚置灰，让用户可重试
      set(s => {
        const next = { ...s.undoneCards };
        delete next[messageId];
        return { undoneCards: next };
      });
    }
  },

  setDate: (date: string, token: string) => {
    get().loadForDate(date, token);
  },
}));
