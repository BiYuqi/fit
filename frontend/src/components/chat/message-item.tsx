import { useRef, useEffect, memo } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { MarkdownText } from './markdown-text';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { FontSize, Glass, Radius, Spacing } from '@/constants/theme';
import { UserBubble } from './user-bubble';
import { RecordCard } from './record-card';
import { MealCard } from './meal-card';
import { PortionCard } from './portion-card';
import { CandidateCard } from './candidate-card';
import { ClarifyCard } from './clarify-card';
import { ExerciseCard } from './exercise-card';
import { DeleteConfirmCard } from './delete-confirm-card';
import { EventLine } from './event-line';
import type {
  ChatMessage,
  RecordCardPayload,
  MealCardPayload,
  PortionCardPayload,
  CandidateCardPayload,
  ClarifyCardPayload,
  ExerciseCardPayload,
  DeleteConfirmCardPayload,
  EventCardPayload,
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
        <MarkdownText content={content} baseStyle={styles.aiText} />
      </View>
    </View>
  );
}

export const MessageItem = memo(function MessageItem({ message, isLast }: { message: ChatMessage; isLast?: boolean }) {

  if (message.role === 'user') {
    return <UserBubble content={message.content} />;
  }

  const p = message.payload;

  switch (message.kind) {
    case 'record_card':
      return <RecordCard payload={p as RecordCardPayload} mealType={(p as RecordCardPayload)?.meal_type} messageId={message.id} recordId={message.record_id} />;

    case 'meal_card':
      return p ? <MealCard payload={p as unknown as MealCardPayload} messageId={message.id} /> : null;

    case 'portion_card': {
      const resolved = !!(p as PortionCardPayload)?.resolved;
      return <PortionCard payload={p as PortionCardPayload} isResolved={resolved} createdAt={message.created_at} />;
    }

    case 'candidate_card': {
      const resolved = !!(p as CandidateCardPayload)?.resolved;
      return <CandidateCard payload={p as CandidateCardPayload} isResolved={resolved} createdAt={message.created_at} />;
    }

    case 'clarify_card':
      return <ClarifyCard payload={p as ClarifyCardPayload} />;

    // 进度卡已下线：query 回复一律纯文本气泡。历史里旧的 query_card 消息也降级为文本
    // （content 自包含数字，直接显示即可），不再渲染进度卡。
    case 'query_card':
      return <AiTextBubble content={message.content} />;

    case 'exercise_card':
      return p ? <ExerciseCard payload={p as unknown as ExerciseCardPayload} messageId={message.id} /> : null;

    case 'delete_confirm_card': {
      const resolved = !!(p as DeleteConfirmCardPayload)?.resolved;
      return <DeleteConfirmCard payload={p as DeleteConfirmCardPayload} isResolved={resolved} />;
    }

    case 'event':
      return p ? <EventLine payload={p as unknown as EventCardPayload} messageId={message.id} /> : null;

    case 'text':
    default:
      return <AiTextBubble content={message.content} />;
  }
});

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
