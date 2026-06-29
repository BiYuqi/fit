import { StyleSheet, View } from 'react-native';
import { ThemedText } from '@/components/themed-text';
import { Colors, Glass, Radius } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import type { ContextCard } from '@/types/chat';

function ProgressBar({ ratio, tint }: { ratio: number; tint: string }) {
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <View style={styles.trackOuter}>
      <View style={[styles.trackFill, { width: `${clamped * 100}%` as any, backgroundColor: tint }]} />
    </View>
  );
}

export function QueryCard({
  content,
  payload,
}: {
  content?: string | null;
  payload: ContextCard;
}) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const colors = Colors[isDark ? 'dark' : 'light'];
  const glass = Glass[isDark ? 'dark' : 'light'];
  const tint = glass.tint;
  const { today, targets } = payload;
  const ratio = targets.calories > 0 ? today.in / targets.calories : 0;
  const remaining = Math.max(0, today.remaining);

  return (
    <View style={styles.wrapper}>
      <View style={[
        styles.card,
        {
          backgroundColor: isDark ? 'rgba(44,44,48,0.92)' : '#FFFFFF',
          borderColor: glass.border,
          ...glass.shadow,
        },
      ]}>
        {/* Title */}
        <ThemedText style={[styles.title, { color: colors.textSecondary }]}>今天还可以吃</ThemedText>

        {/* Big remaining number */}
        <View style={styles.bigRow}>
          <ThemedText style={[styles.bigNum, { color: tint }]}>{remaining}</ThemedText>
          <ThemedText style={[styles.bigUnit, { color: tint }]}> kcal</ThemedText>
        </View>

        {/* Progress bar */}
        <ProgressBar ratio={ratio} tint={tint} />

        {/* Stats row */}
        <View style={styles.statsRow}>
          <ThemedText style={[styles.statText, { color: colors.textSecondary }]}>
            已摄入 {today.in.toLocaleString()}
          </ThemedText>
          <ThemedText style={[styles.statText, { color: colors.textSecondary }]}>
            目标 {targets.calories.toLocaleString()} kcal
          </ThemedText>
        </View>

        {/* AI content / advice */}
        {content ? (
          <ThemedText style={[styles.advice, { color: colors.textSecondary }]}>{content}</ThemedText>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    paddingHorizontal: 16,
    marginVertical: 6,
    alignItems: 'flex-start',
  },
  card: {
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 8,
    width: '90%' as any,
  },
  title: {
    fontSize: 13,
    fontWeight: '500',
  },
  bigRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  bigNum: {
    fontSize: 44,
    fontWeight: '700',
    lineHeight: 48,
  },
  bigUnit: {
    fontSize: 18,
    fontWeight: '600',
  },
  trackOuter: {
    height: 6,
    backgroundColor: 'rgba(128,128,128,0.18)',
    borderRadius: 3,
    overflow: 'hidden',
  },
  trackFill: {
    height: '100%',
    borderRadius: 3,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  statText: {
    fontSize: 12,
  },
  advice: {
    fontSize: 13,
    lineHeight: 19,
    marginTop: 2,
  },
});
