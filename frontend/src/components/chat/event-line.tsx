import { useState } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { ThemedText } from '@/components/themed-text';
import { useChatStore } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import type { EventCardPayload } from '@/types/chat';

// T49：系统回执降级为居中小字事件行（同时间分隔符量级），不是气泡。
// 只有 delete 事件带 undo（记录已真删，撤销要按快照重建）；modified 事件的撤销走 meal_card 项级按钮。
export function EventLine({ payload, messageId }: { payload: EventCardPayload; messageId: string }) {
  const { undoEvent } = useChatStore();
  const { token } = useAuthStore();
  const [isUndoing, setIsUndoing] = useState(false);

  const canUndo = !!payload.undo && !payload.undone;

  const handleUndo = async () => {
    if (!canUndo || isUndoing || !token) return;
    setIsUndoing(true);
    try {
      await undoEvent(messageId, token);
    } finally {
      setIsUndoing(false);
    }
  };

  return (
    <View style={styles.wrapper}>
      <ThemedText themeColor="textSecondary" style={styles.text} numberOfLines={2}>
        {payload.text}
      </ThemedText>
      {canUndo && (
        <TouchableOpacity onPress={handleUndo} disabled={isUndoing} activeOpacity={0.6}>
          <ThemedText themeColor="textSecondary" style={styles.undoText}>
            {' '}· 撤销
          </ThemedText>
        </TouchableOpacity>
      )}
      {payload.undone && (
        <ThemedText themeColor="textSecondary" style={styles.undoneText}>
          {' '}· 已撤销
        </ThemedText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    marginVertical: 8,
    paddingHorizontal: 24,
  },
  text: {
    fontSize: 12,
    textAlign: 'center',
  },
  undoText: {
    fontSize: 12,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  undoneText: {
    fontSize: 12,
    fontStyle: 'italic',
  },
});
