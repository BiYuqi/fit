import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { GlassCard } from '@/components/glass-card';
import { ThemedText } from '@/components/themed-text';
import { Glass, Radius } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';
import { useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import type { CandidateCardPayload } from '@/types/chat';

export function CandidateCard({
  payload,
  isResolved,
}: {
  payload: CandidateCardPayload;
  isResolved: boolean;
}) {
  const scheme = useColorScheme();
  const theme = useTheme();
  const tint = Glass[scheme === 'dark' ? 'dark' : 'light'].tint;
  const { resolve } = useChatStore();
  const { token } = useAuthStore();

  const handleChoice = (foodId: string) => {
    if (isResolved || !token) return;
    resolve(payload.pending_id, foodId, token);
  };

  return (
    <View style={styles.wrapper}>
      <GlassCard style={styles.card}>
        <ThemedText style={styles.title}>
          「{payload.query}」是哪个？
        </ThemedText>
        {isResolved ? (
          <ThemedText style={[styles.resolved, { color: theme.textSecondary }]}>已选择</ThemedText>
        ) : (
          <View style={styles.options}>
            {payload.foods.slice(0, 5).map(food => (
              <TouchableOpacity
                key={food.id}
                style={[styles.chip, { borderColor: tint + '60' }]}
                onPress={() => handleChoice(food.id)}
                activeOpacity={0.7}>
                <ThemedText style={[styles.chipText, { color: tint }]}>{food.name}</ThemedText>
                {food.category ? (
                  <ThemedText style={[styles.chipSub, { color: theme.textSecondary }]}>
                    {food.category}
                  </ThemedText>
                ) : null}
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={[styles.chip, { borderColor: theme.textSecondary + '40' }]}
              onPress={() => {}}
              activeOpacity={0.7}>
              <ThemedText style={[styles.chipText, { color: theme.textSecondary }]}>其他</ThemedText>
              <ThemedText style={[styles.chipSub, { color: theme.textSecondary }]}>
                请输入描述
              </ThemedText>
            </TouchableOpacity>
          </View>
        )}
      </GlassCard>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    paddingHorizontal: 16,
    marginVertical: 4,
    alignItems: 'flex-start',
  },
  card: {
    maxWidth: '90%',
    gap: 10,
  },
  title: {
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 20,
  },
  resolved: {
    fontSize: 13,
    fontStyle: 'italic',
  },
  options: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
    alignItems: 'center',
  },
  chipText: {
    fontSize: 14,
    fontWeight: '500',
  },
  chipSub: {
    fontSize: 11,
    marginTop: 1,
  },
});
