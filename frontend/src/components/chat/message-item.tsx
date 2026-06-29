import { StyleSheet, View } from 'react-native';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
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
  const theme = useTheme();
  if (!content) return null;
  return (
    <View style={styles.aiWrapper}>
      <View style={[styles.aiBubble, { backgroundColor: theme.backgroundElement }]}>
        <ThemedText style={styles.aiText}>{content}</ThemedText>
      </View>
    </View>
  );
}

export function MessageItem({ message }: { message: ChatMessage }) {
  const { resolvedPendings } = useChatStore();

  if (message.role === 'user') {
    return <UserBubble content={message.content} />;
  }

  const p = message.payload;

  switch (message.kind) {
    case 'record_card':
      return <RecordCard payload={p as RecordCardPayload} />;

    case 'portion_card':
      return (
        <PortionCard
          payload={p as PortionCardPayload}
          isResolved={!!(p as PortionCardPayload)?.pending_id && resolvedPendings[(p as PortionCardPayload).pending_id]}
        />
      );

    case 'candidate_card':
      return (
        <CandidateCard
          payload={p as CandidateCardPayload}
          isResolved={!!(p as CandidateCardPayload)?.pending_id && resolvedPendings[(p as CandidateCardPayload).pending_id]}
        />
      );

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
    borderRadius: 20,
    borderBottomLeftRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  aiText: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '400',
  },
});
