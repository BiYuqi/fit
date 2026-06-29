import { useCallback, useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { ChatInput } from '@/components/chat/chat-input';
import { DateSelector } from '@/components/chat/date-selector';
import { MessageItem } from '@/components/chat/message-item';
import { BottomTabInset, Glass } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';
import { useAuthStore } from '@/stores/auth-store';
import { useChatStore } from '@/stores/chat-store';
import type { ChatMessage } from '@/types/chat';

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

function ChatHeader({
  caloriesIn,
  selectedDate,
  dates,
  onSelectDate,
}: {
  caloriesIn: number;
  selectedDate: string;
  dates: string[];
  onSelectDate: (date: string) => void;
}) {
  const scheme = useColorScheme();
  const theme = useTheme();
  const glass = Glass[scheme === 'dark' ? 'dark' : 'light'];
  const today = new Date().toISOString().slice(0, 10);
  const isToday = selectedDate === today;

  return (
    <View style={styles.header}>
      <View style={styles.headerLeft}>
        <ThemedText style={styles.headerTitle}>聊天</ThemedText>
        {isToday && caloriesIn > 0 && (
          <ThemedText style={[styles.headerSub, { color: theme.textSecondary }]}>
            今日已记 {caloriesIn} kcal
          </ThemedText>
        )}
      </View>
      <DateSelector
        selectedDate={selectedDate}
        dates={dates}
        onSelect={onSelectDate}
      />
    </View>
  );
}

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const flatListRef = useRef<FlatList<ChatMessage>>(null);
  const prevCountRef = useRef(0);

  const { token } = useAuthStore();
  const {
    messages,
    selectedDate,
    isSending,
    isLoading,
    chatDates,
    summaryCard,
    loadForDate,
    loadDates,
    send,
    setDate,
  } = useChatStore();

  // Initial load
  useEffect(() => {
    if (!token) return;
    const today = new Date().toISOString().slice(0, 10);
    loadForDate(today, token);
    loadDates(token);
  }, [token]);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    if (messages.length > prevCountRef.current) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({
          animated: prevCountRef.current > 0,
        });
      }, 80);
      prevCountRef.current = messages.length;
    }
  }, [messages.length]);

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
      prevCountRef.current = 0;
      setDate(date, token);
    },
    [token, setDate],
  );

  const caloriesIn = summaryCard?.today.in ?? 0;

  const renderItem = useCallback(
    ({ item }: { item: ChatMessage }) => <MessageItem message={item} />,
    [],
  );

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);

  return (
    <ThemedView style={styles.root}>
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}>
        {/* Safe area top */}
        <View style={{ paddingTop: insets.top }} />

        <ChatHeader
          caloriesIn={caloriesIn}
          selectedDate={selectedDate}
          dates={chatDates}
          onSelectDate={handleSelectDate}
        />

        {isLoading && messages.length === 0 ? (
          <View style={styles.loadingCenter}>
            <ActivityIndicator />
          </View>
        ) : (
          <FlatList
            ref={flatListRef}
            data={messages}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            contentContainerStyle={[
              styles.list,
              messages.length === 0 && styles.listEmpty,
            ]}
            ListEmptyComponent={<EmptyState />}
            showsVerticalScrollIndicator={false}
          />
        )}

        <ChatInput onSend={handleSend} isSending={isSending} />

        {/* Safe area bottom (behind tab bar) */}
        <View style={{ paddingBottom: BottomTabInset }} />
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  headerLeft: {
    gap: 2,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
  },
  headerSub: {
    fontSize: 12,
  },
  list: {
    paddingVertical: 8,
    paddingBottom: 16,
  },
  listEmpty: {
    flex: 1,
  },
  loadingCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
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
