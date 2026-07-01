import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { ThemedText } from '@/components/themed-text';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors, Glass, Radius } from '@/constants/theme';
import { useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import type { ExerciseCardPayload } from '@/types/chat';

export function ExerciseCard({
  payload,
  messageId,
}: {
  payload: ExerciseCardPayload;
  messageId: string;
}) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const colors = Colors[isDark ? 'dark' : 'light'];
  const glass = Glass[isDark ? 'dark' : 'light'];

  const { undo, undoneCards } = useChatStore();
  const { token } = useAuthStore();
  const undoInfo = payload.undo;
  const isUndone = !!(undoInfo && undoneCards[messageId]);

  const handleUndo = () => {
    if (!undoInfo || isUndone || !token) return;
    undo(messageId, undoInfo.record_id, undoInfo.prev_state, token);
  };

  return (
    <View style={styles.wrapper}>
      <View style={[
        styles.card,
        isUndone && styles.cardUndone,
        {
          backgroundColor: isDark ? 'rgba(44,44,48,0.92)' : '#FFFFFF',
          borderColor: glass.border,
          ...glass.shadow,
        },
      ]}>
        {/* badge */}
        <View style={styles.badgeRow}>
          <SymbolView name="checkmark.circle.fill" size={13} tintColor="#5E5CE6" />
          <ThemedText style={[styles.badgeText, { color: '#5E5CE6' }]}>已录入</ThemedText>
        </View>

        {/* Exercise info row */}
        <View style={styles.mainRow}>
          <View style={styles.infoBlock}>
            <ThemedText style={[styles.type, { color: colors.text }]}>
              {payload.type}
            </ThemedText>
            <ThemedText style={[styles.meta, { color: colors.textSecondary }]}>
              {payload.duration_min}min
            </ThemedText>
          </View>
          <View style={styles.calorieBlock}>
            <ThemedText style={[styles.calorieNum, { color: colors.text }]}>
              {payload.calories_burned}
            </ThemedText>
            <ThemedText style={[styles.calorieUnit, { color: colors.textSecondary }]}>kcal</ThemedText>
          </View>
        </View>

        {/* Undo */}
        {undoInfo && (
          <>
            <View style={[styles.divider, { backgroundColor: colors.hairline }]} />
            {isUndone ? (
              <ThemedText style={[styles.undoneText, { color: colors.textSecondary }]}>已撤销</ThemedText>
            ) : (
              <TouchableOpacity style={styles.undoRow} onPress={handleUndo} activeOpacity={0.6}>
                <SymbolView name="arrow.uturn.backward" size={12} tintColor={colors.textSecondary} />
                <ThemedText style={[styles.undoText, { color: colors.textSecondary }]}>撤销</ThemedText>
              </TouchableOpacity>
            )}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
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
  cardUndone: {
    opacity: 0.55,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  infoBlock: {
    flex: 1,
    gap: 2,
  },
  type: {
    fontSize: 17,
    fontWeight: '700',
    lineHeight: 21,
  },
  meta: {
    fontSize: 13,
  },
  calorieBlock: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 2,
  },
  calorieNum: {
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 32,
  },
  calorieUnit: {
    fontSize: 13,
    fontWeight: '500',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  undoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    paddingVertical: 2,
  },
  undoText: {
    fontSize: 13,
    fontWeight: '500',
  },
  undoneText: {
    fontSize: 12,
    fontStyle: 'italic',
  },
});
