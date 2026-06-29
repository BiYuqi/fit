import { useState } from 'react';
import { FlatList, Modal, StyleSheet, TouchableOpacity, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { ThemedText } from '@/components/themed-text';
import { Glass, Radius, Spacing } from '@/constants/theme';
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

  const sorted = [...dates].sort((a, b) => b.localeCompare(a));

  return (
    <>
      <TouchableOpacity
        style={styles.trigger}
        onPress={() => setOpen(true)}
        activeOpacity={0.7}>
        <ThemedText style={styles.triggerText}>{formatDateLabel(selectedDate)}</ThemedText>
        <ThemedText style={[styles.arrow, { color: theme.textSecondary }]}>▼</ThemedText>
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
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: Radius.pill,
  },
  triggerText: {
    fontSize: 15,
    fontWeight: '600',
  },
  arrow: {
    fontSize: 10,
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
