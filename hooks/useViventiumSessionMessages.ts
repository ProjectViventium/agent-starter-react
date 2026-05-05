'use client';

import * as React from 'react';
import type { Participant, RemoteParticipant } from 'livekit-client';
import {
  type ReceivedMessage,
  type UseSessionReturn,
  useAgent,
  useChat,
} from '@livekit/components-react';

type TranscriptionStreamSnapshot = {
  id: string;
  message: string;
  timestamp: number;
  participantIdentity: string;
  attributes?: Record<string, string>;
};

// LiveKit components-core DataTopic.TRANSCRIPTION. The app does not depend on
// components-core directly, so keep this protocol topic local and explicit.
const LIVEKIT_TRANSCRIPTION_TOPIC = 'lk.transcription';

function upsertStreamSnapshot(
  snapshots: TranscriptionStreamSnapshot[],
  nextSnapshot: TranscriptionStreamSnapshot
) {
  const existingIndex = snapshots.findIndex((snapshot) => snapshot.id === nextSnapshot.id);
  if (existingIndex === -1) {
    return [...snapshots, nextSnapshot];
  }

  return snapshots.map((snapshot, index) => (index === existingIndex ? nextSnapshot : snapshot));
}

function resolveParticipant(
  room: UseSessionReturn['room'],
  agentParticipant: RemoteParticipant | null,
  workerParticipant: RemoteParticipant | null,
  participantIdentity: string
): Participant | undefined {
  if (participantIdentity === room.localParticipant.identity) {
    return room.localParticipant;
  }
  if (agentParticipant?.identity === participantIdentity) {
    return agentParticipant;
  }
  if (workerParticipant?.identity === participantIdentity) {
    return workerParticipant;
  }
  return room.remoteParticipants.get(participantIdentity);
}

function transcriptionSnapshotToMessage(
  snapshot: TranscriptionStreamSnapshot,
  room: UseSessionReturn['room'],
  agentParticipant: RemoteParticipant | null,
  workerParticipant: RemoteParticipant | null
): ReceivedMessage {
  const from = resolveParticipant(
    room,
    agentParticipant,
    workerParticipant,
    snapshot.participantIdentity
  );

  return {
    id: snapshot.id,
    timestamp: snapshot.timestamp,
    type: from?.isLocal ? 'userTranscript' : 'agentTranscript',
    from,
    attributes: snapshot.attributes,
    message: snapshot.message,
  };
}

function sortMessagesByFirstSeen(
  messages: ReceivedMessage[],
  firstSeenMsById: React.MutableRefObject<Map<string, number>>
) {
  const now = Date.now();
  for (const message of messages) {
    if (!firstSeenMsById.current.has(message.id)) {
      firstSeenMsById.current.set(message.id, now);
    }
  }
  const activeIds = new Set(messages.map((message) => message.id));
  for (const messageId of firstSeenMsById.current.keys()) {
    if (!activeIds.has(messageId)) {
      firstSeenMsById.current.delete(messageId);
    }
  }

  return [...messages].sort((a, b) => {
    const firstSeenA = firstSeenMsById.current.get(a.id) ?? now;
    const firstSeenB = firstSeenMsById.current.get(b.id) ?? now;
    return firstSeenA - firstSeenB;
  });
}

export function useViventiumSessionMessages(session: UseSessionReturn) {
  const { room } = session;
  const agent = useAgent(session);
  const chatOptions = React.useMemo(() => ({ room }), [room]);
  const chat = useChat(chatOptions);
  const [transcriptionStreams, setTranscriptionStreams] = React.useState<
    TranscriptionStreamSnapshot[]
  >([]);
  const firstSeenMsById = React.useRef(new Map<string, number>());

  React.useEffect(() => {
    let closed = false;
    let registered = false;

    try {
      room.registerTextStreamHandler(LIVEKIT_TRANSCRIPTION_TOPIC, (reader, participantInfo) => {
        void (async () => {
          let message = '';
          try {
            for await (const chunk of reader) {
              if (closed) {
                return;
              }
              message += chunk;
              setTranscriptionStreams((current) =>
                upsertStreamSnapshot(current, {
                  id: reader.info.id,
                  message,
                  timestamp: reader.info.timestamp,
                  participantIdentity: participantInfo.identity,
                  attributes: reader.info.attributes,
                })
              );
            }
          } catch (error) {
            if (!closed) {
              console.warn('Failed to read LiveKit transcription stream', error);
            }
          }
        })();
      });
      registered = true;
    } catch (error) {
      console.warn('Failed to register LiveKit transcription stream handler', error);
    }

    return () => {
      closed = true;
      if (registered) {
        room.unregisterTextStreamHandler(LIVEKIT_TRANSCRIPTION_TOPIC);
      }
      setTranscriptionStreams([]);
    };
  }, [room]);

  const messages = React.useMemo(() => {
    const transcriptMessages = transcriptionStreams.map((snapshot) =>
      transcriptionSnapshotToMessage(
        snapshot,
        room,
        agent.internal.agentParticipant,
        agent.internal.workerParticipant
      )
    );

    return sortMessagesByFirstSeen([...transcriptMessages, ...chat.chatMessages], firstSeenMsById);
  }, [
    agent.internal.agentParticipant,
    agent.internal.workerParticipant,
    chat.chatMessages,
    room,
    transcriptionStreams,
  ]);

  return React.useMemo(
    () => ({
      messages,
      send: chat.send,
      isSending: chat.isSending,
    }),
    [chat.isSending, chat.send, messages]
  );
}
