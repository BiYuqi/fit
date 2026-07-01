import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { GlassCard } from '@/components/glass-card';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import type { ExerciseCardPayload } from '@/types/chat';

const EXERCISE_BADGE = '#5E5CE6';

/** Map exercise type to an emoji via keyword matching. Falls back to 💪. */
function exerciseEmoji(type: string): string {
  const t = type.toLowerCase();
  if (/跑|慢跑|快走|竞走|马拉松/.test(t)) return '🏃';
  if (/骑|单车|自行车|动感单车/.test(t)) return '🚴';
  if (/游泳|蛙泳|自由泳|蝶泳|仰泳/.test(t)) return '🏊';
  if (/力量|举重|哑铃|杠铃|深蹲|硬拉|卧推|器械/.test(t)) return '🏋️';
  if (/瑜伽|拉伸/.test(t)) return '🧘';
  if (/跳绳/.test(t)) return '🏃';
  if (/散步|走路|徒步/.test(t)) return '🚶';
  if (/篮球/.test(t)) return '🏀';
  if (/足球/.test(t)) return '⚽';
  if (/羽毛球/.test(t)) return '🏸';
  if (/乒乓/.test(t)) return '🏓';
  if (/网球/.test(t)) return '🎾';
  if (/舞蹈|跳舞|街舞|爵士/.test(t)) return '💃';
  if (/登山|爬山|攀岩/.test(t)) return '🧗';
  if (/拳击|格斗|搏击/.test(t)) return '🥊';
  if (/滑雪|滑冰/.test(t)) return '⛷️';
  if (/冲浪|划船|皮划艇/.test(t)) return '🚣';
  if (/高强度间歇|hiit|tabata/.test(t)) return '🔥';
  if (/普拉提/.test(t)) return '🧘';
  return '💪';
}

export function ExerciseCard({
  payload,
  messageId,
}: {
  payload: ExerciseCardPayload;
  messageId: string;
}) {
  const colors = useTheme();

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
      <GlassCard padding={10} gap={undoInfo ? 5 : 0} style={[styles.card, isUndone && styles.cardUndone]}>
        {/* Row 1: badge icon + type / duration + calorie number */}
        <View style={styles.row1}>
          <SymbolView
            name="checkmark.circle.fill"
            size={12}
            tintColor={EXERCISE_BADGE}
            style={styles.badgeIcon}
          />
          <ThemedText style={styles.exerciseLine} numberOfLines={1}>
            <ThemedText style={styles.exerciseEmoji}>{exerciseEmoji(payload.type)}</ThemedText>
            {' '}{payload.type}{' '}
            <ThemedText themeColor="textSecondary" style={styles.exerciseMeta}>
              {payload.duration_min}min
            </ThemedText>
          </ThemedText>
          <View style={styles.calBlock}>
            <ThemedText style={styles.calNum}>{payload.calories_burned}</ThemedText>
            <ThemedText themeColor="textSecondary" style={styles.calUnit}>
              kcal
            </ThemedText>
          </View>
        </View>

        {/* Row 2 (only when undo present) */}
        {undoInfo && (
          <View style={styles.undoRow}>
            {isUndone ? (
              <ThemedText themeColor="textSecondary" style={styles.undoneLabel}>
                已撤销
              </ThemedText>
            ) : (
              <TouchableOpacity style={styles.undoBtn} onPress={handleUndo} activeOpacity={0.6}>
                <SymbolView
                  name="arrow.uturn.backward"
                  size={11}
                  tintColor={colors.textSecondary}
                />
                <ThemedText themeColor="textSecondary" style={styles.undoLabel}>
                  撤销
                </ThemedText>
              </TouchableOpacity>
            )}
          </View>
        )}
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
  cardUndone: {
    opacity: 0.55,
  },

  // ── Row 1 ──
  row1: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  badgeIcon: {
    marginTop: 1,
  },
  exerciseLine: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
  },
  exerciseEmoji: {
    fontSize: 15,
  },
  exerciseMeta: {
    fontSize: 13,
  },
  calBlock: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'baseline',
    marginLeft: 4,
  },
  calNum: {
    fontSize: 22,
    fontWeight: '700',
  },
  calUnit: {
    fontSize: 12,
  },

  // ── Undo row ──
  undoRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  undoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  undoLabel: {
    fontSize: 12,
  },
  undoneLabel: {
    fontSize: 12,
    fontStyle: 'italic',
  },
});
