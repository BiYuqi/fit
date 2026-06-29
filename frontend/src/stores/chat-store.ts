import { create } from 'zustand';
import { apiFetch } from '@/lib/api';
import { getCachedMessages, upsertMessages } from '@/lib/db';
import type { ChatMessage, ContextCard, SendMessageResponse, ResolveResponse } from '@/types/chat';

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

  loadForDate: (date: string, token: string) => Promise<void>;
  loadDates: (token: string) => Promise<void>;
  send: (text: string, token: string) => Promise<void>;
  resolve: (pendingId: string, choice: string | { grams: number }, token: string) => Promise<void>;
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
      const data = await apiFetch<{ date: string; messages: ChatMessage[] }>(
        `/api/chat/messages?date=${date}`,
        { token },
      );
      await upsertMessages(date, data.messages);
      set({ messages: data.messages });
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
        return {
          messages: [...s.messages, ...toAdd],
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

  setDate: (date: string, token: string) => {
    get().loadForDate(date, token);
  },
}));
