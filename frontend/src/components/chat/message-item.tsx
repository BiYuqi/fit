import { useRef, useEffect } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { ThemedText } from '@/components/themed-text';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { FontSize, Glass, Radius, Spacing } from '@/constants/theme';
import { useChatStore } from '@/stores/chat-store';
import { UserBubble } from './user-bubble';
import { RecordCard } from './record-card';
import { PortionCard } from './portion-card';
import { CandidateCard } from './candidate-card';
import { ClarifyCard } from './clarify-card';
import { QueryCard } from './query-card';
import { ExerciseCard } from './exercise-card';
import { DeleteConfirmCard } from './delete-confirm-card';
import type {
  ChatMessage,
  RecordCardPayload,
  PortionCardPayload,
  CandidateCardPayload,
  ClarifyCardPayload,
  ContextCard,
  ExerciseCardPayload,
  DeleteConfirmCardPayload,
} from '@/types/chat';

export function ThinkingBubble() {
  const dots = [useRef(new Animated.Value(0.3)).current, useRef(new Animated.Value(0.3)).current, useRef(new Animated.Value(0.3)).current];
  useEffect(() => {
    const anims = dots.map((dot, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 180),
          Animated.timing(dot, { toValue: 1, duration: 280, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0.3, duration: 280, useNativeDriver: true }),
          Animated.delay(540 - i * 180),
        ])
      )
    );
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, []);

  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const glass = Glass[isDark ? 'dark' : 'light'];
  return (
    <View style={styles.aiWrapper}>
      <View style={[
        styles.aiBubble,
        styles.thinkingBubble,
        {
          backgroundColor: isDark ? 'rgba(44,44,48,0.92)' : '#FFFFFF',
          borderColor: glass.border,
          ...glass.shadow,
        },
      ]}>
        {dots.map((opacity, i) => (
          <Animated.View key={i} style={[styles.thinkingDot, { opacity }]} />
        ))}
      </View>
    </View>
  );
}

function AiTextBubble({ content }: { content?: string | null }) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const glass = Glass[isDark ? 'dark' : 'light'];
  if (!content) return null;
  return (
    <View style={styles.aiWrapper}>
      <View style={[
        styles.aiBubble,
        {
          backgroundColor: isDark ? 'rgba(44,44,48,0.92)' : '#FFFFFF',
          borderColor: glass.border,
          ...glass.shadow,
        },
      ]}>
        <ThemedText style={styles.aiText}>{content}</ThemedText>
      </View>
    </View>
  );
}

export function MessageItem({ message, isLast }: { message: ChatMessage; isLast?: boolean }) {
  const { resolvedPendings } = useChatStore();

  if (message.role === 'user') {
    return <UserBubble content={message.content} />;
  }

  const p = message.payload;

  switch (message.kind) {
    case 'record_card':
      return <RecordCard payload={p as RecordCardPayload} messageId={message.id} />;

    case 'portion_card': {
      const pid = (p as PortionCardPayload)?.pending_id;
      const resolved = !!(pid && resolvedPendings[pid]);
      return <PortionCard payload={p as PortionCardPayload} isResolved={resolved} createdAt={message.created_at} />;
    }

    case 'candidate_card': {
      const pid = (p as CandidateCardPayload)?.pending_id;
      const resolved = !!(pid && resolvedPendings[pid]);
      return <CandidateCard payload={p as CandidateCardPayload} isResolved={resolved} createdAt={message.created_at} />;
    }

    case 'clarify_card':
      return <ClarifyCard payload={p as ClarifyCardPayload} />;

    case 'query_card':
      return p ? (
        <QueryCard content={message.content} payload={p as unknown as ContextCard} />
      ) : (
        <AiTextBubble content={message.content} />
      );

    case 'exercise_card':
      return p ? <ExerciseCard payload={p as unknown as ExerciseCardPayload} messageId={message.id} /> : null;

    case 'delete_confirm_card': {
      const pid = (p as DeleteConfirmCardPayload)?.pending_id;
      const resolved = !!(pid && resolvedPendings[pid]);
      return <DeleteConfirmCard payload={p as DeleteConfirmCardPayload} isResolved={resolved} />;
    }

    case 'text':
    default:
      return <AiTextBubble content={message.content} />;
  }
}

const styles = StyleSheet.create({
  aiWrapper: {
    marginVertical: Spacing.one,
    alignItems: 'flex-start',
  },
  aiBubble: {
    maxWidth: '78%',
    borderRadius: Radius.lg,
    borderBottomLeftRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  aiText: {
    fontSize: FontSize.base,
    lineHeight: 22,
    fontWeight: '400',
  },
  thinkingBubble: {
    paddingHorizontal: Spacing.three,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  thinkingDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#8E8E93',
  },
});
