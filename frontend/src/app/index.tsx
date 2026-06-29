import { useCallback, useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { ChatInput } from '@/components/chat/chat-input';
import { DateSelector } from '@/components/chat/date-selector';
import { MessageItem, ThinkingBubble } from '@/components/chat/message-item';
import { AvatarGradient, BlurIntensity, BottomTabInset, Glass } from '@/constants/theme';
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

// Header matches ChatMain.dc.html:
// 38px gradient avatar (accent→purple) + sparkle icon · "AI 记录助手" · subtitle · date pill
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
  const isDark = scheme === 'dark';
  const theme = useTheme();
  const glass = Glass[isDark ? 'dark' : 'light'];
  const today = new Date().toISOString().slice(0, 10);
  const isToday = selectedDate === today;

  const subtitle = isToday
    ? caloriesIn > 0 ? `今日已记 ${caloriesIn} kcal · 在线` : '在线'
    : '查看历史记录';

  return (
    <BlurView
      intensity={BlurIntensity.header}
      tint={isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
      style={[styles.header, { borderBottomColor: theme.hairline }]}>
      {/* Gradient avatar circle */}
      <LinearGradient
        colors={AvatarGradient.colors}
        start={AvatarGradient.start}
        end={AvatarGradient.end}
        style={styles.avatar}>
        <SymbolView name="sparkles" size={19} tintColor="#fff" />
      </LinearGradient>

      {/* Title + subtitle */}
      <View style={styles.headerText}>
        <ThemedText style={styles.headerTitle}>AI 记录助手</ThemedText>
        <ThemedText style={[styles.headerSub, { color: theme.textSecondary }]}>
          {subtitle}
        </ThemedText>
      </View>

      {/* Date picker pill */}
      <DateSelector
        selectedDate={selectedDate}
        dates={dates}
        onSelect={onSelectDate}
      />
    </BlurView>
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

  // Scroll to bottom when new messages arrive or thinking bubble appears
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

  useEffect(() => {
    if (isSending) {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 80);
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
      prevCountRef.current = 0;
      setDate(date, token);
    },
    [token, setDate],
  );

  const caloriesIn = summaryCard?.today.in ?? 0;

  const renderItem = useCallback(
    ({ item, index }: { item: ChatMessage; index: number }) => (
      <MessageItem message={item} isLast={index === messages.length - 1} />
    ),
    [messages.length],
  );

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);

  return (
    <ThemedView style={styles.root}>
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
          style={styles.flatList}
          contentContainerStyle={[
            styles.list,
            messages.length === 0 && styles.listEmpty,
          ]}
          ListEmptyComponent={<EmptyState />}
          ListFooterComponent={isSending ? <ThinkingBubble /> : null}
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          contentInset={{ bottom: BottomTabInset }}
          scrollIndicatorInsets={{ bottom: BottomTabInset }}
        />
      )}

      <ChatInput onSend={handleSend} isSending={isSending} />

      {/* Spacer so ChatInput sits above the absolute tab bar */}
      <View style={{ height: BottomTabInset }} />
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
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 6,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 19,
  },
  headerSub: {
    fontSize: 12,
  },
  flatList: {
    flex: 1,
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
