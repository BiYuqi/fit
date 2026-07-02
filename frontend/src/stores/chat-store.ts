import { create } from 'zustand';
import { apiFetch } from '@/lib/api';
import { getAllMessages, upsertMessages } from '@/lib/db';
import { localDateStr } from '@/lib/format';
import type { ChatMessage, ContextCard, SendMessageResponse, ResolveResponse, UndoPrevState } from '@/types/chat';

function todayStr() {
  return localDateStr();
}

type ChatStore = {
  messages: ChatMessage[];
  isSending: boolean;
  isLoading: boolean;
  chatDates: string[];
  summaryCard: ContextCard | null;
  resolvedPendings: Record<string, true>;
  undoneCards: Record<string, true>;

  loadAllMessages: (token: string) => Promise<void>;
  loadDates: (token: string) => Promise<void>;
  send: (text: string, token: string) => Promise<void>;
  resolve: (pendingId: string, choice: string | { grams: number }, token: string) => Promise<void>;
  undo: (messageId: string, recordId: string, prevState: UndoPrevState | undefined, token: string) => Promise<void>;
};

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
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

  loadAllMessages: async (token: string) => {
    set({ isLoading: true });
    // 1. Show cached immediately
    try {
      const cached = await getAllMessages();
      if (cached.length > 0) {
        set({ messages: cached });
      }
    } catch {
      // ignore
    }
    // 2. Sync from server (90-day range)
    try {
      const to = todayStr();
      const from = new Date();
      from.setDate(from.getDate() - 89);
      const fromStr = localDateStr(from);
      const data = await apiFetch<{ messages: ChatMessage[]; resolved_pending_ids?: string[] }>(
        `/api/chat/messages/range?from=${fromStr}&to=${to}`,
        { token },
      );
      // Group by date and upsert into SQLite
      const byDate = new Map<string, ChatMessage[]>();
      for (const m of data.messages) {
        const list = byDate.get(m.date);
        if (list) list.push(m);
        else byDate.set(m.date, [m]);
      }
      for (const [date, msgs] of byDate) {
        await upsertMessages(date, msgs);
      }
      const resolvedFromServer: Record<string, true> = {};
      for (const id of data.resolved_pending_ids ?? []) {
        resolvedFromServer[id] = true;
      }
      set(s => ({
        messages: data.messages,
        resolvedPendings: { ...s.resolvedPendings, ...resolvedFromServer },
      }));
    } catch {
      // keep cache on error
    }
    set({ isLoading: false });
  },

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
      set(s => ({
        resolvedPendings: { ...s.resolvedPendings, [pendingId]: true },
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
}));
