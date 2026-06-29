import { StyleSheet, View } from 'react-native';
import { ThemedText } from '@/components/themed-text';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Glass, Radius } from '@/constants/theme';
import { useChatStore } from '@/stores/chat-store';
import { UserBubble } from './user-bubble';
import { RecordCard } from './record-card';
import { PortionCard } from './portion-card';
import { CandidateCard } from './candidate-card';
import { ClarifyCard } from './clarify-card';
import { QueryCard } from './query-card';
import { ExerciseCard } from './exercise-card';
import type {
  ChatMessage,
  RecordCardPayload,
  PortionCardPayload,
  CandidateCardPayload,
  ClarifyCardPayload,
  ContextCard,
  ExerciseCardPayload,
} from '@/types/chat';

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
      return <RecordCard payload={p as RecordCardPayload} />;

    case 'portion_card': {
      const pid = (p as PortionCardPayload)?.pending_id;
      const resolved = !isLast || !!(pid && resolvedPendings[pid]);
      return <PortionCard payload={p as PortionCardPayload} isResolved={resolved} />;
    }

    case 'candidate_card': {
      const pid = (p as CandidateCardPayload)?.pending_id;
      const resolved = !isLast || !!(pid && resolvedPendings[pid]);
      return <CandidateCard payload={p as CandidateCardPayload} isResolved={resolved} />;
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
      return p ? <ExerciseCard payload={p as unknown as ExerciseCardPayload} /> : null;

    case 'text':
    default:
      return <AiTextBubble content={message.content} />;
  }
}

const styles = StyleSheet.create({
  aiWrapper: {
    paddingHorizontal: 16,
    marginVertical: 4,
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
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '400',
  },
});
