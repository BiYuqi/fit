import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { formatChatTime, localDateStr, CHAT_TIME_GAP_MS } from '@/lib/format';
import { ChatInput } from '@/components/chat/chat-input';
import { DateSelector } from '@/components/chat/date-selector';
import { MessageItem, ThinkingBubble } from '@/components/chat/message-item';
import { useTheme } from '@/hooks/use-theme';
import { useAuthStore } from '@/stores/auth-store';
import { useChatStore } from '@/stores/chat-store';
import type { ChatMessage } from '@/types/chat';

function TimeLabel({ time }: { time: string }) {
  const theme = useTheme();
  return (
    <View style={styles.timeLabel}>
      <ThemedText style={[styles.timeLabelText, { color: theme.textSecondary }]}>
        {formatChatTime(time)}
      </ThemedText>
    </View>
  );
}

function EmptyState() {
  const theme = useTheme();
  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  return (
    <View style={styles.empty}>
      <ThemedText style={styles.emptyGreeting}>{greeting} 👋</ThemedText>
      <ThemedText style={[styles.emptyHint, { color: theme.textSecondary }]}>
        今天吃了什么？告诉我吧
      </ThemedText>
    </View>
  );
}

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const flatListRef = useRef<FlatList<ChatMessage>>(null);
  // Scroll-intent refs — written by effects, consumed by onContentSizeChange
  // Using refs (not state) avoids stale-closure in the FlatList callback
  const shouldScrollRef    = useRef(true);
  const scrollAnimatedRef  = useRef(false);
  const lastScrolledDateRef = useRef('');
  const prevLenRef          = useRef(0);

  const { token } = useAuthStore();
  const {
    messages,
    selectedDate,
    isSending,
    isLoading,
    chatDates,
    summaryCard,
    resolvedPendings,
    loadForDate,
    loadDates,
    send,
    setDate,
  } = useChatStore();

  const PENDING_KINDS = new Set(['portion_card', 'candidate_card', 'clarify_card']);

  const visibleMessages = useMemo(() => {
    let blocked = false;
    return messages.filter(m => {
      if (m.role === 'user') {
        blocked = false;
        return true;
      }
      if (blocked && PENDING_KINDS.has(m.kind)) return false;
      if (PENDING_KINDS.has(m.kind)) {
        const pid = (m.payload as any)?.pending_id as string | undefined;
        if (!pid || !resolvedPendings[pid]) blocked = true;
      }
      return true;
    });
  }, [messages, resolvedPendings]);

  useEffect(() => {
    if (!token) return;
    // 如果 store 残留的是其他日期的消息，先清掉，避免渲染旧日期内容再闪到新日期
    const s = useChatStore.getState();
    if (s.selectedDate !== localDateStr() && s.messages.length > 0) {
      useChatStore.setState({ messages: [] });
    }
    loadForDate(localDateStr(), token);
    loadDates(token);
  }, [token]);

  // Scroll intent: two paths
  // ─ Date change (incl. initial mount): set flag for onContentSizeChange
  //   AND direct scroll via rAF — whichever fires later wins, both are
  //   safe because the other is a no-op if we're already at the bottom.
  // ─ New message appended: set flag only, onContentSizeChange reliably
  //   fires for content-size changes.

  useEffect(() => {
    if (visibleMessages.length === 0) { prevLenRef.current = 0; return; }
    const dateChanged = lastScrolledDateRef.current !== selectedDate;
    const prevLen = prevLenRef.current;
    prevLenRef.current = visibleMessages.length;
    if (dateChanged) {
      lastScrolledDateRef.current = selectedDate;
      shouldScrollRef.current   = true;
      scrollAnimatedRef.current = false;
      requestAnimationFrame(() => {
        flatListRef.current?.scrollToEnd({ animated: false });
      });
    } else if (visibleMessages.length > prevLen) {
      shouldScrollRef.current   = true;
      scrollAnimatedRef.current = true;
    }
  }, [selectedDate, visibleMessages.length]);

  useEffect(() => {
    if (isSending) {
      shouldScrollRef.current   = true;
      scrollAnimatedRef.current = true;
    }
  }, [isSending]);


  const handleSend = useCallback(
    (text: string) => {
      if (!token) return;
      send(text, token).catch(() => {});
    },
    [token, send],
  );

  const handleSelectDate = useCallback(
    (date: string) => {
      if (!token) return;
      lastScrolledDateRef.current = ''; // force scroll on next message load
      setDate(date, token);
    },
    [token, setDate],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: ChatMessage; index: number }) => {
      const prev = index > 0 ? visibleMessages[index - 1] : null;
      const showTime =
        !prev ||
        new Date(item.created_at).getTime() - new Date(prev.created_at).getTime() > CHAT_TIME_GAP_MS;
      return (
        <>
          {showTime && <TimeLabel time={item.created_at} />}
          <MessageItem message={item} isLast={index === visibleMessages.length - 1} />
        </>
      );
    },
    [visibleMessages],
  );

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);

  // Top padding: status bar + date pill height (≈54px from design)
  const topPad = insets.top + 54;

  return (
    <ThemedView style={[styles.root, { backgroundColor: 'transparent' }]}>
      {/* FlatList stays mounted at all times so flatListRef is never null */}
      <FlatList
        ref={flatListRef}
        data={visibleMessages}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        style={styles.flatList}
        contentContainerStyle={[
          styles.list,
          { paddingTop: topPad },
          visibleMessages.length === 0 && styles.listEmpty,
        ]}
        ListEmptyComponent={
          isLoading ? (
            <View style={styles.loadingCenter}>
              <ActivityIndicator />
            </View>
          ) : (
            <EmptyState />
          )
        }
        ListFooterComponent={isSending ? <ThinkingBubble /> : null}
        initialNumToRender={200}
        maxToRenderPerBatch={200}
        windowSize={99}
        onContentSizeChange={() => {
          if (shouldScrollRef.current) {
            shouldScrollRef.current = false;
            flatListRef.current?.scrollToEnd({ animated: scrollAnimatedRef.current });
          }
        }}
        showsVerticalScrollIndicator={false}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      />

      {/* Floating date pill — centered at top, absolute over messages */}
      <View style={[styles.datePillWrapper, { top: insets.top + 10 }]} pointerEvents="box-none">
        <DateSelector
          selectedDate={selectedDate}
          dates={chatDates}
          onSelect={handleSelectDate}
        />
      </View>

      <ChatInput onSend={handleSend} isSending={isSending} />
      <View style={{ height: insets.bottom }} />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  flatList: {
    flex: 1,
  },
  list: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  listEmpty: {
    flex: 1,
  },
  loadingCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
  },
  datePillWrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 20,
  },
  timeLabel: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  timeLabelText: {
    fontSize: 12,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 32,
  },
  emptyGreeting: {
    fontSize: 22,
    fontWeight: '600',
  },
  emptyHint: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
});
