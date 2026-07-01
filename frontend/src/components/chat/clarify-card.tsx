import { StyleSheet, View } from 'react-native';
import { GlassCard } from '@/components/glass-card';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import type { ClarifyCardPayload } from '@/types/chat';

export function ClarifyCard({ payload }: { payload: ClarifyCardPayload }) {
  const theme = useTheme();
  return (
    <View style={styles.wrapper}>
      <GlassCard style={[styles.card, { padding: 12 }]}>
        <ThemedText style={styles.icon}>🤔</ThemedText>
        <ThemedText style={styles.title}>
          我不太确定「{payload.query}」是什么食物
        </ThemedText>
        <ThemedText style={[styles.hint, { color: theme.textSecondary }]}>
          请在下方输入框描述更多细节，例如食物名称或品牌
        </ThemedText>
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
    maxWidth: '84%',
    gap: 8,
  },
  icon: {
    fontSize: 22,
  },
  title: {
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 20,
  },
  hint: {
    fontSize: 12,
    lineHeight: 18,
  },
});
