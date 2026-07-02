import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { SymbolView } from 'expo-symbols';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { formatChatTime, formatDateLabel, localDateStr, dateOnly, CHAT_TIME_GAP_MS } from '@/lib/format';
import { ChatInput } from '@/components/chat/chat-input';
import { MessageItem, ThinkingBubble } from '@/components/chat/message-item';
import { SearchModal } from '@/components/chat/search-modal';
import { Glass } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';
import { useAuthStore } from '@/stores/auth-store';
import { useChatStore } from '@/stores/chat-store';
import type { ChatMessage } from '@/types/chat';

// Glass button tokens (matching app-tabs.tsx back button)
const GLASS = {
  light: {
    gradColors: ['rgba(255,255,255,0.82)', 'rgba(255,255,255,0.65)', 'rgba(255,255,255,0.75)'] as const,
    gradLocs: [0, 0.55, 1] as const,
    stroke: 'rgba(255,255,255,0.80)',
    topHighlight: 'rgba(255,255,255,0.95)',
    shadowColor: 'rgba(31,33,46,1)',
    shadowOpacity: 0.20,
    shadowOffset: { width: 0, height: 14 } as { width: number; height: number },
    shadowRadius: 36,
    elevation: 14,
  },
  dark: {
    gradColors: ['rgba(94,94,102,0.42)', 'rgba(38,38,44,0.22)', 'rgba(58,58,66,0.34)'] as const,
    gradLocs: [0, 0.55, 1] as const,
    stroke: 'rgba(255,255,255,0.22)',
    topHighlight: 'rgba(255,255,255,0.35)',
    shadowColor: 'rgba(0,0,0,1)',
    shadowOpacity: 0.50,
    shadowOffset: { width: 0, height: 16 } as { width: number; height: number },
    shadowRadius: 44,
    elevation: 20,
  },
};

const SEARCH_BTN = 38;

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

function DateSeparatorView({ date }: { date: string }) {
  const theme = useTheme();
  return (
    <View style={styles.dateSeparator}>
      <ThemedText style={[styles.dateSeparatorText, { color: theme.textSecondary }]}>
        {formatDateLabel(date)}
      </ThemedText>
    </View>
  );
}

function EmptyState() {
  const theme = useTheme();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  return (
    <View style={[styles.empty, invertedFix]}>
      <ThemedText style={styles.emptyGreeting}>{greeting} 👋</ThemedText>
      <ThemedText style={[styles.emptyHint, { color: theme.textSecondary }]}>
        今天吃了什么？告诉我吧
      </ThemedText>
    </View>
  );
}

// In inverted FlatList, the container is scaleY(-1); each cell un-flips itself.
// The empty component sits outside the cell wrapper, so it needs manual un-flip.
const invertedFix = { transform: [{ scaleY: -1 }] } as const;

export default function ChatScreen({ isActive = true }: { isActive?: boolean }) {
  const insets = useSafeAreaInsets();
  const flatListRef = useRef<FlatList<ChatMessage>>(null);

  // Each time the tab activates, bump the FlatList key to force a clean mount.
  // A freshly mounted inverted FlatList naturally renders at the bottom —
  // no scrollToIndex needed, no flash of old scroll position.
  const prevActiveRef = useRef(isActive);
  const listKeyRef = useRef(0);
  if (isActive && !prevActiveRef.current) {
    listKeyRef.current += 1;
  }
  prevActiveRef.current = isActive;

  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const theme = useTheme();
  const glass = Glass[isDark ? 'dark' : 'light'];
  const g = GLASS[isDark ? 'dark' : 'light'];
  const blurTint = isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight';

  const { token } = useAuthStore();
  const {
    messages,
    isSending,
    isLoading,
    chatDates,
    resolvedPendings,
    jumpTarget,
    loadRecentMessages,
    loadMoreMessages,
    jumpToMessage,
    jumpToDate,
    clearJumpTarget,
    loadDates,
    send,
  } = useChatStore();

  const [searchOpen, setSearchOpen] = useState(false);

  const PENDING_KINDS = new Set(['portion_card', 'candidate_card', 'clarify_card']);

  // Reverse chronological (newest first) for inverted FlatList.
  // Index 0 = newest message → rendered at visual bottom.
  const visibleMessages = useMemo(() => {
    let blocked = false;
    let lastDate = '';
    const filtered = messages.filter(m => {
      if (m.date !== lastDate) {
        blocked = false;
        lastDate = m.date;
      }
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
    filtered.reverse();
    return filtered;
  }, [messages, resolvedPendings]);

  // Initial load
  useEffect(() => {
    if (!token) return;
    loadRecentMessages(token);
    loadDates(token);
  }, [token, loadRecentMessages, loadDates]);

  // When tab activates: if the current window is a historical one (from
  // search jump), reload today's window.  Scroll-to-bottom is handled by
  // the FlatList key bump above — a fresh inverted FlatList starts at bottom.
  useEffect(() => {
    if (!isActive || !token) return;
    const msgs = useChatStore.getState().messages;
    if (msgs.length === 0) return;
    if (!msgs.some(m => dateOnly(m.date) === localDateStr())) {
      loadRecentMessages(token);
    }
  }, [isActive, token, loadRecentMessages]);

  const handleSend = useCallback(
    (text: string) => {
      if (!token) return;
      send(text, token).catch(() => {});
    },
    [token, send],
  );

  // ── Search result handlers ──
  const handleSearchResult = useCallback((messageId: string) => {
    setSearchOpen(false);
    jumpToMessage(messageId);
  }, [jumpToMessage]);

  const handleDateSelect = useCallback((date: string) => {
    setSearchOpen(false);
    jumpToDate(date);
  }, [jumpToDate]);

  // ── Respond to jumpTarget after messages window loads ──
  useEffect(() => {
    if (!jumpTarget) return;
    let idx = -1;
    if (jumpTarget.type === 'message') {
      idx = visibleMessages.findIndex(m => m.id === jumpTarget.id);
    } else {
      // visibleMessages is reverse (new→old), first chronological of date = last in array
      for (let i = visibleMessages.length - 1; i >= 0; i--) {
        if (visibleMessages[i].date === jumpTarget.date) { idx = i; break; }
      }
    }
    clearJumpTarget();
    if (idx >= 0) {
      // Phase 1: instant rough jump — forces FlatList to render target area
      flatListRef.current?.scrollToIndex({ index: idx, animated: false, viewPosition: 0 });
      // Phase 2: delayed precise scroll — FlatList has now measured real item heights
      const id = setTimeout(() => {
        flatListRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0 });
      }, 400);
      // Safety: cancel if component unmounts or new jump arrives
      return () => clearTimeout(id);
    }
  }, [jumpTarget, visibleMessages, clearJumpTarget]);

  const renderItem = useCallback(
    ({ item, index }: { item: ChatMessage; index: number }) => {
      // Reversed data: index+1 is OLDER, index-1 is NEWER.
      const next = index + 1 < visibleMessages.length ? visibleMessages[index + 1] : null;
      // Date separator at the oldest message of each day, but never on the
      // very newest message (index 0) — it would flicker when sending a new
      // message temporarily becomes the date boundary, then loses it after
      // the AI response adds more messages of the same date.
      const showDate = index > 0 && (!next || next.date !== item.date);
      // Time label when gap to OLDER message > 5 min — matches old behavior
      // (old code compared to prev in chronological order = older message).
      // Using "next" (older) means sending a new message doesn't erase
      // the time label on the previously-newest message.
      const showTime =
        !next ||
        new Date(item.created_at).getTime() - new Date(next.created_at).getTime() > CHAT_TIME_GAP_MS;

      const parts: React.ReactNode[] = [];
      parts.push(<MessageItem key={`msg-${item.id}`} message={item} isLast={index === 0} />);
      if (showTime) parts.push(<TimeLabel key={`t-${item.id}`} time={item.created_at} />);
      if (showDate) parts.push(<DateSeparatorView key={`d-${item.id}`} date={item.date} />);
      return <>{parts}</>;
    },
    [visibleMessages],
  );

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);

  // In inverted FlatList, paddingBottom on contentContainer = visual top.
  const topPad = insets.top + 16;

  return (
    <KeyboardAvoidingView
      style={styles.kav}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={-insets.bottom}
    >
    <ThemedView style={[styles.root, { backgroundColor: 'transparent' }]}>
      <FlatList
        key={listKeyRef.current}
        ref={flatListRef}
        inverted
        data={visibleMessages}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        onEndReached={() => { if (token) loadMoreMessages(token); }}
        onEndReachedThreshold={0.3}
        style={styles.flatList}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: topPad },
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
        ListHeaderComponent={isSending ? <ThinkingBubble /> : null}
        initialNumToRender={20}
        maxToRenderPerBatch={15}
        windowSize={21}
        removeClippedSubviews={false}
        scrollEventThrottle={16}
        onScrollToIndexFailed={(info) => {
          const estimatedOffset = info.index * 80;
          flatListRef.current?.scrollToOffset({ offset: estimatedOffset, animated: true });
        }}
        showsVerticalScrollIndicator={false}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      />

      {/* Search button — top-right, glass styling matching back button */}
      <View
        style={[
          styles.searchBtnWrapper,
          {
            top: insets.top + 10,
            shadowColor: g.shadowColor,
            shadowOpacity: g.shadowOpacity,
            shadowOffset: g.shadowOffset,
            shadowRadius: g.shadowRadius,
            elevation: g.elevation,
          },
        ]}
      >
        <TouchableOpacity
          style={styles.searchBtn}
          onPress={() => setSearchOpen(true)}
          activeOpacity={0.8}
        >
          <BlurView intensity={40} tint={blurTint} style={StyleSheet.absoluteFill} />
          <LinearGradient
            colors={g.gradColors}
            locations={g.gradLocs}
            start={{ x: 0.85, y: 0 }}
            end={{ x: 0.15, y: 1 }}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          <View
            style={[styles.searchBtnTopHL, { backgroundColor: g.topHighlight }]}
            pointerEvents="none"
          />
          <View
            style={[styles.searchBtnBorder, { borderColor: g.stroke }]}
            pointerEvents="none"
          />
          {Platform.OS === 'ios' ? (
            <SymbolView
              name="magnifyingglass"
              size={17}
              tintColor={glass.tabInactive}
              weight="semibold"
            />
          ) : (
            <ThemedText style={[styles.searchBtnEmoji, { color: glass.tabInactive }]}>
              🔍
            </ThemedText>
          )}
        </TouchableOpacity>
      </View>

      <SearchModal
        visible={searchOpen}
        onClose={() => setSearchOpen(false)}
        chatDates={chatDates}
        onSearchResult={handleSearchResult}
        onDateSelect={handleDateSelect}
      />

      <ChatInput onSend={handleSend} isSending={isSending} />
      <View style={{ height: insets.bottom }} />
    </ThemedView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  kav:  { flex: 1 },
  flatList: { flex: 1 },
  list: {
    paddingHorizontal: 16,
    // paddingBottom for visual TOP in inverted FlatList
    paddingTop: 16,
    flexGrow: 1,
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

  // Search button
  searchBtnWrapper: {
    position: 'absolute',
    right: 14,
    zIndex: 30,
    width: SEARCH_BTN,
    height: SEARCH_BTN,
    borderRadius: SEARCH_BTN / 2,
  },
  searchBtn: {
    width: SEARCH_BTN,
    height: SEARCH_BTN,
    borderRadius: SEARCH_BTN / 2,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBtnTopHL: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: 1.2,
    borderTopLeftRadius: SEARCH_BTN / 2,
    borderTopRightRadius: SEARCH_BTN / 2,
  },
  searchBtnBorder: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: SEARCH_BTN / 2,
    borderWidth: 0.5,
  },
  searchBtnEmoji: { fontSize: 17 },

  // Date separator
  dateSeparator: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  dateSeparatorText: {
    fontSize: 12,
    fontWeight: '500',
  },

  // Time label
  timeLabel: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  timeLabelText: { fontSize: 12 },

  // Empty state
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 32,
  },
  emptyGreeting: { fontSize: 22, fontWeight: '600' },
  emptyHint: { fontSize: 15, textAlign: 'center', lineHeight: 22 },
});
