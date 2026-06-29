import { useState } from 'react';
import { FlatList, Modal, StyleSheet, TouchableOpacity, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { SymbolView } from 'expo-symbols';
import { ThemedText } from '@/components/themed-text';
import { Colors, Glass, Radius, Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';

function formatDateLabel(date: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (date === today) return '今天';
  const [year, month, day] = date.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  return `${month}月${day}日 周${weekdays[d.getDay()]}`;
}

type Props = {
  selectedDate: string;
  dates: string[];
  onSelect: (date: string) => void;
};

export function DateSelector({ selectedDate, dates, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const theme = useTheme();
  const glass = Glass[isDark ? 'dark' : 'light'];

  // Always show last 7 days + any dates with existing messages
  const last7: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    last7.push(d.toISOString().slice(0, 10));
  }
  const merged = Array.from(new Set([...last7, ...dates]));
  const sorted = merged.sort((a, b) => b.localeCompare(a));

  return (
    <>
      {/* Date pill: matches design — field bg + calendar icon + text + caret */}
      <TouchableOpacity
        style={[styles.trigger, { backgroundColor: theme.backgroundElement }]}
        onPress={() => setOpen(true)}
        activeOpacity={0.7}>
        <SymbolView name="calendar.badge.clock" size={15} tintColor={theme.textSecondary} />
        <ThemedText style={styles.triggerText}>{formatDateLabel(selectedDate)}</ThemedText>
        <SymbolView name="chevron.down" size={10} tintColor={theme.textSecondary} />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={styles.sheet}>
            <BlurView
              intensity={40}
              tint={isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
              style={[styles.sheetInner, { borderColor: glass.border }]}>
              <ThemedText style={[styles.sheetTitle, { color: theme.textSecondary }]}>
                切换日期
              </ThemedText>
              <FlatList
                data={sorted}
                keyExtractor={d => d}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={[
                      styles.dateRow,
                      item === selectedDate && { backgroundColor: glass.tint + '18' },
                    ]}
                    onPress={() => {
                      onSelect(item);
                      setOpen(false);
                    }}
                    activeOpacity={0.7}>
                    <ThemedText
                      style={[
                        styles.dateLabel,
                        item === selectedDate && { color: glass.tint, fontWeight: '600' },
                      ]}>
                      {formatDateLabel(item)}
                    </ThemedText>
                    {item === selectedDate && (
                      <ThemedText style={[styles.check, { color: glass.tint }]}>✓</ThemedText>
                    )}
                  </TouchableOpacity>
                )}
                style={{ maxHeight: 320 }}
              />
            </BlurView>
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 15,
  },
  triggerText: {
    fontSize: 13,
    fontWeight: '600',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    paddingTop: 100,
    paddingRight: Spacing.three,
  },
  sheet: {
    width: 220,
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  sheetInner: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    paddingVertical: 8,
  },
  sheetTitle: {
    fontSize: 12,
    paddingHorizontal: 16,
    paddingVertical: 6,
    letterSpacing: 0.5,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  dateLabel: {
    fontSize: 15,
  },
  check: {
    fontSize: 14,
    fontWeight: '700',
  },
});
