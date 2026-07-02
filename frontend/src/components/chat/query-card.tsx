import { StyleSheet, View } from 'react-native';
import { GlassCard } from '@/components/glass-card';
import { ThemedText } from '@/components/themed-text';
import { Colors, FontSize, Glass } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import type { ContextCard } from '@/types/chat';

function MiniProgress({ ratio, tint }: { ratio: number; tint: string }) {
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <View style={styles.track}>
      <View
        style={[
          styles.trackFill,
          { width: `${clamped * 100}%` as any, backgroundColor: tint },
        ]}
      />
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
  const remaining = Math.max(0, today.remaining);
  const ratio = targets.calories > 0 ? today.in / targets.calories : 0;
  const pct = Math.round(ratio * 100);

  return (
    <View style={styles.wrapper}>
      <GlassCard padding={10} gap={4} style={styles.card}>
        {/* Row 1: label + kcal + pct */}
        <View style={styles.row}>
          <ThemedText style={[styles.label, { color: colors.textSecondary }]}>
            今天还可以吃
          </ThemedText>
          <ThemedText style={[styles.kcal, { color: tint }]}>
            {remaining.toLocaleString()}
          </ThemedText>
          <ThemedText style={[styles.unit, { color: tint }]}>kcal</ThemedText>
          <ThemedText style={[styles.pct, { color: colors.textSecondary }]}>
            {pct}%
          </ThemedText>
        </View>

        {/* Row 2: progress bar */}
        <MiniProgress ratio={ratio} tint={tint} />

        {/* Row 3: AI advice */}
        {content ? (
          <ThemedText
            style={[styles.advice, { color: colors.textSecondary }]}
            numberOfLines={2}
          >
            {content}
          </ThemedText>
        ) : null}
      </GlassCard>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    marginVertical: 6,
    alignItems: 'flex-start',
  },
  card: {
    width: '90%' as any,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
  },
  label: {
    fontSize: FontSize.xs,
    fontWeight: '500',
  },
  kcal: {
    fontSize: FontSize.base,
    fontWeight: '700',
  },
  unit: {
    fontSize: FontSize.xs,
    fontWeight: '500',
  },
  pct: {
    fontSize: FontSize.xs,
    fontWeight: '500',
    marginLeft: 'auto',
  },
  track: {
    height: 3,
    backgroundColor: 'rgba(128,128,128,0.18)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  trackFill: {
    height: '100%',
    borderRadius: 2,
  },
  advice: {
    fontSize: FontSize.xs,
    lineHeight: 16,
  },
});
