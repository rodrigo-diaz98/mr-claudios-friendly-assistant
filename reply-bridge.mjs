export const BRIDGE_CONNECTED_MS = 5000;

export function createReplyBridge() {
  const answerBySessionId = new Map();
  const questionsBySessionId = new Map();
  const polledAtBySessionId = new Map();

  return {
    queueAnswer(sessionId, answer) {
      answerBySessionId.set(sessionId, answer);
    },

    isConnected(sessionId, now) {
      return now - (polledAtBySessionId.get(sessionId) ?? -Infinity) <= BRIDGE_CONNECTED_MS;
    },

    takeAnswer(sessionId, now) {
      polledAtBySessionId.set(sessionId, now);
      const answer = answerBySessionId.get(sessionId) ?? null;
      answerBySessionId.delete(sessionId);
      return answer;
    },

    setOpenQuestions(sessionId, questions) {
      if (questions) {
        questionsBySessionId.set(sessionId, questions);
      } else {
        questionsBySessionId.delete(sessionId);
      }
    },

    withBridgeState(sessions, now) {
      return sessions.map((session) => ({
        ...session,
        bridge: {
          isConnected: this.isConnected(session.sessionId, now),
          questions: questionsBySessionId.get(session.sessionId) ?? null,
        },
      }));
    },
  };
}
