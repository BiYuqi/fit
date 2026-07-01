import { useState } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { ThemedText } from '@/components/themed-text';
import { Colors, Glass, Radius } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import type { DeleteConfirmCardPayload } from '@/types/chat';

const DESTRUCTIVE = '#FF453A'; // iOS systemRed

export function DeleteConfirmCard({
  payload,
  isResolved,
}: {
  payload: DeleteConfirmCardPayload;
  isResolved: boolean;
}) {
  const [cancelled, setCancelled] = useState(false);
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const colors = Colors[isDark ? 'dark' : 'light'];
  const glass = Glass[isDark ? 'dark' : 'light'];
  const { resolve } = useChatStore();
  const { token } = useAuthStore();

  const confirm = () => {
    if (isResolved || cancelled || !token) return;
    resolve(payload.pending_id, 'confirm', token);
  };

  const done = isResolved || cancelled;

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
        <View style={styles.titleRow}>
          <SymbolView name="trash" size={14} tintColor={done ? colors.textSecondary : DESTRUCTIVE} />
          <ThemedText style={[styles.title, { color: colors.text }]} numberOfLines={2}>
            {isResolved
              ? `已删除「${payload.name}」`
              : cancelled
                ? `已取消删除「${payload.name}」`
                : `确认删除「${payload.name}」？`}
          </ThemedText>
        </View>

        {!done && payload.calories != null && (
          <ThemedText style={[styles.sub, { color: colors.textSecondary }]}>
            约 {payload.calories} kcal，删除后从今日统计中扣除。
          </ThemedText>
        )}

        {!done && (
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.btn, styles.cancelBtn, { borderColor: glass.border }]}
              onPress={() => setCancelled(true)}
              activeOpacity={0.7}>
              <ThemedText style={[styles.cancelText, { color: colors.text }]}>取消</ThemedText>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, styles.deleteBtn, { backgroundColor: DESTRUCTIVE }]}
              onPress={confirm}
              activeOpacity={0.85}>
              <ThemedText style={styles.deleteText}>确认删除</ThemedText>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    marginVertical: 6,
  },
  card: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 8,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  title: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
  },
  sub: {
    fontSize: 12,
    lineHeight: 16,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 2,
  },
  btn: {
    borderRadius: Radius.sm,
    paddingHorizontal: 16,
    paddingVertical: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtn: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
  },
  cancelText: {
    fontSize: 14,
    fontWeight: '600',
  },
  deleteBtn: {
    flex: 1,
  },
  deleteText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
