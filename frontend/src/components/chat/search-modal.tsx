import { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  Modal,
  Platform,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Glass, Radius } from '@/constants/theme';
import { formatChatTime, formatDateLabel, localDateStr } from '@/lib/format';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';
import type { ChatMessage } from '@/types/chat';

type Props = {
  visible: boolean;
  onClose: () => void;
  onClosed: () => void;
  allMessages: ChatMessage[];
  chatDates: string[];
  onJumpToMessage: (messageId: string) => void;
  onJumpToDate: (date: string) => void;
};

const TODAY = new Date();
const MIN_DATE = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() - 89);

export function SearchModal({
  visible,
  onClose,
  onClosed,
  allMessages,
  chatDates,
  onJumpToMessage,
  onJumpToDate,
}: Props) {
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const theme = useTheme();
  const glass = Glass[isDark ? 'dark' : 'light'];

  const blurTint = isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight';
  const glassGrad = isDark
    ? (['rgba(94,94,102,0.42)', 'rgba(38,38,44,0.22)', 'rgba(58,58,66,0.34)'] as const)
    : (['rgba(255,255,255,0.82)', 'rgba(255,255,255,0.65)', 'rgba(255,255,255,0.75)'] as const);
  const glassStroke = isDark ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.80)';
  const topHighlight = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.95)';

  const [searchQuery, setSearchQuery] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(false);

  const results = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return allMessages
      .filter(m => m.content?.toLowerCase().includes(q))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 50);
  }, [searchQuery, allMessages]);

  const handleSelectDate = useCallback(
    (_event: DateTimePickerEvent, date?: Date) => {
      setShowDatePicker(false);
      if (date) {
        const dateStr = localDateStr(date);
        onJumpToDate(dateStr);
        onClose();
      }
    },
    [onJumpToDate, onClose],
  );

  const handleResultPress = useCallback(
    (messageId: string) => {
      onJumpToMessage(messageId);
      onClose();
    },
    [onJumpToMessage, onClose],
  );

  const chatDatesSet = useMemo(() => new Set(chatDates), [chatDates]);

  const renderResult = useCallback(
    ({ item, index }: { item: ChatMessage; index: number }) => {
      const prevResult = index > 0 ? results[index - 1] : null;
      const showDate = !prevResult || prevResult.date !== item.date;

      return (
        <>
          {showDate && (
            <ThemedText style={[styles.resultDateHeader, { color: theme.textSecondary }]}>
              {formatDateLabel(item.date)}
            </ThemedText>
          )}
          <TouchableOpacity
            style={styles.resultItem}
            onPress={() => handleResultPress(item.id)}
            activeOpacity={0.6}
          >
            <ThemedText style={styles.resultContent} numberOfLines={1}>
              {item.content || '(非文本消息)'}
            </ThemedText>
            <ThemedText style={[styles.resultTime, { color: theme.textTertiary }]}>
              {formatChatTime(item.created_at)}
            </ThemedText>
          </TouchableOpacity>
        </>
      );
    },
    [results, handleResultPress, theme],
  );

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onDismiss={onClosed}
      onRequestClose={onClose}
    >
      <TouchableOpacity
        style={styles.backdrop}
        activeOpacity={1}
        onPress={onClose}
      >
        <View
          style={[styles.card, { paddingTop: insets.top + 12 }]}
          onStartShouldSetResponder={() => true}
        >
          <BlurView intensity={52} tint={blurTint} style={styles.cardInner}>
            <LinearGradient
              colors={glassGrad}
              locations={[0, 0.55, 1]}
              start={{ x: 0.85, y: 0 }}
              end={{ x: 0.15, y: 1 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />

            {/* Top bar */}
            <View style={styles.topBar}>
              <TouchableOpacity onPress={onClose} hitSlop={8}>
                <ThemedText style={[styles.cancelBtn, { color: glass.tint }]}>
                  取消
                </ThemedText>
              </TouchableOpacity>
              <ThemedText style={styles.title}>搜索聊天记录</ThemedText>
              <View style={styles.cancelBtn} />
            </View>

            {/* Search input */}
            <View style={[styles.searchBox, { backgroundColor: theme.backgroundElement }]}>
              <SymbolView
                name="magnifyingglass"
                size={16}
                tintColor={theme.textSecondary}
                style={styles.searchIcon}
              />
              <TextInput
                style={[styles.searchInput, { color: theme.text }]}
                placeholder="搜索聊天记录"
                placeholderTextColor={theme.textTertiary}
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoFocus
                returnKeyType="search"
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={8}>
                  <SymbolView
                    name="xmark.circle.fill"
                    size={16}
                    tintColor={theme.textTertiary}
                  />
                </TouchableOpacity>
              )}
            </View>

            {/* Content area */}
            {searchQuery.trim() === '' ? (
              !showDatePicker ? (
                <TouchableOpacity
                  style={[styles.dateEntry, { borderColor: theme.hairline }]}
                  onPress={() => setShowDatePicker(true)}
                  activeOpacity={0.6}
                >
                  <SymbolView name="calendar" size={20} tintColor={glass.tint} />
                  <ThemedText style={[styles.dateEntryText, { color: glass.tint }]}>
                    按日期查找
                  </ThemedText>
                </TouchableOpacity>
              ) : (
                <View style={styles.datePickerWrap}>
                  <DateTimePicker
                    value={TODAY}
                    mode="date"
                    display="inline"
                    maximumDate={TODAY}
                    minimumDate={MIN_DATE}
                    onChange={handleSelectDate}
                    themeVariant={isDark ? 'dark' : 'light'}
                    accentColor={glass.tint}
                    style={styles.datePicker}
                  />
                  <TouchableOpacity
                    style={styles.datePickerBack}
                    onPress={() => setShowDatePicker(false)}
                    activeOpacity={0.6}
                  >
                    <ThemedText style={[styles.datePickerBackText, { color: theme.textSecondary }]}>
                      返回
                    </ThemedText>
                  </TouchableOpacity>
                </View>
              )
            ) : results.length > 0 ? (
              <FlatList
                data={results}
                renderItem={renderResult}
                keyExtractor={keyExtractor}
                style={styles.resultsList}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              />
            ) : (
              <View style={styles.noResults}>
                <ThemedText style={[styles.noResultsText, { color: theme.textSecondary }]}>
                  未找到包含"{searchQuery}"的聊天记录
                </ThemedText>
              </View>
            )}

            <View style={[styles.cardBorder, { borderColor: glassStroke }]} pointerEvents="none" />
          </BlurView>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
  },
  card: {
    flex: 1,
  },
  cardInner: {
    flex: 1,
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    overflow: 'hidden',
  },
  cardBorder: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 0.5,
  },

  // Top bar
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  cancelBtn: {
    fontSize: 16,
    width: 48,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
  },

  // Search input
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 36,
  },
  searchIcon: {
    marginRight: 6,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
  },

  // Date entry
  dateEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: 16,
    paddingVertical: 14,
    borderRadius: Radius.md,
    borderWidth: 0.5,
  },
  dateEntryText: {
    fontSize: 15,
    fontWeight: '500',
  },

  // Date picker
  datePickerWrap: {
    marginHorizontal: 16,
  },
  datePicker: {
    backgroundColor: 'transparent',
  },
  datePickerBack: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  datePickerBackText: {
    fontSize: 14,
  },

  // Results list
  resultsList: {
    flex: 1,
    paddingHorizontal: 16,
  },
  resultDateHeader: {
    fontSize: 13,
    fontWeight: '600',
    paddingTop: 12,
    paddingBottom: 4,
  },
  resultItem: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128,128,128,0.15)',
  },
  resultContent: {
    fontSize: 15,
    marginBottom: 2,
  },
  resultTime: {
    fontSize: 12,
  },

  // No results
  noResults: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  noResultsText: {
    fontSize: 14,
    textAlign: 'center',
  },
});
