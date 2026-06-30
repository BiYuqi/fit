import { useState } from 'react';
import { Modal, Platform, StyleSheet, TouchableOpacity, View } from 'react-native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { SymbolView } from 'expo-symbols';
import { ThemedText } from '@/components/themed-text';
import { Glass, Radius } from '@/constants/theme';
import { localDateStr } from '@/lib/format';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';

// Parse "YYYY-MM-DD" to a Date at local noon (avoids DST/UTC edge cases)
function parseDateStr(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

function formatDateLabel(date: string): string {
  const today = localDateStr();
  if (date === today) return '今天';
  const [, month, day] = date.split('-').map(Number);
  const d = parseDateStr(date);
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  return `${month}月${day}日 周${weekdays[d.getDay()]}`;
}

const TODAY = new Date();
const MIN_DATE = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() - 89);

type Props = {
  selectedDate: string;
  dates: string[];
  onSelect: (date: string) => void;
};

export function DateSelector({ selectedDate, onSelect }: Props) {
  const [open, setOpen] = useState(false);
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

  const selectedDateObj = parseDateStr(selectedDate);

  const handleChange = (_event: DateTimePickerEvent, date?: Date) => {
    if (date) {
      onSelect(localDateStr(date));
    }
    // On iOS inline, keep open until user taps backdrop
    if (Platform.OS !== 'ios') setOpen(false);
  };

  return (
    <>
      {/* Trigger pill */}
      <View style={[styles.triggerShadow, glass.shadow]}>
        <TouchableOpacity style={styles.triggerClip} onPress={() => setOpen(true)} activeOpacity={0.8}>
          <BlurView intensity={40} tint={blurTint} style={StyleSheet.absoluteFill} />
          <LinearGradient
            colors={glassGrad}
            locations={[0, 0.55, 1]}
            start={{ x: 0.85, y: 0 }}
            end={{ x: 0.15, y: 1 }}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          <View style={[styles.triggerTopHL, { backgroundColor: topHighlight }]} pointerEvents="none" />
          <View style={[StyleSheet.absoluteFill, styles.triggerBorder, { borderColor: glassStroke }]} pointerEvents="none" />
          <SymbolView name="calendar" size={14} tintColor={theme.textSecondary} />
          <ThemedText style={styles.triggerText}>{formatDateLabel(selectedDate)}</ThemedText>
          <SymbolView name="chevron.down" size={10} tintColor={theme.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Calendar modal */}
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setOpen(false)}>
          {/* Stop tap propagation so calendar taps don't close modal */}
          <View style={styles.card} onStartShouldSetResponder={() => true}>
            <BlurView
              intensity={52}
              tint={blurTint}
              style={styles.cardInner}
            >
              <LinearGradient
                colors={glassGrad}
                locations={[0, 0.55, 1]}
                start={{ x: 0.85, y: 0 }}
                end={{ x: 0.15, y: 1 }}
                style={StyleSheet.absoluteFill}
                pointerEvents="none"
              />
              <DateTimePicker
                value={selectedDateObj}
                mode="date"
                display="inline"
                maximumDate={TODAY}
                minimumDate={MIN_DATE}
                onChange={handleChange}
                themeVariant={isDark ? 'dark' : 'light'}
                accentColor={glass.tint}
                style={styles.picker}
              />
              <View style={[styles.cardBorder, { borderColor: glassStroke }]} pointerEvents="none" />
            </BlurView>
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  // ── Trigger pill ──
  triggerShadow: {
    borderRadius: 17,
  },
  triggerClip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 17,
    overflow: 'hidden',
  },
  triggerTopHL: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: 1.2,
    borderTopLeftRadius: 17,
    borderTopRightRadius: 17,
  },
  triggerBorder: {
    borderRadius: 17,
    borderWidth: 0.5,
  },
  triggerText: {
    fontSize: 13,
    fontWeight: '600',
  },

  // ── Calendar modal ──
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.25)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  cardInner: {
    borderRadius: Radius.lg,
    overflow: 'hidden',
    paddingBottom: 8,
  },
  picker: {
    // backgroundColor must be transparent for glass effect to show through
    backgroundColor: 'transparent',
  },
  cardBorder: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: Radius.lg,
    borderWidth: 0.5,
  },
});
