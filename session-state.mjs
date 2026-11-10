import { basename } from 'node:path';

export const STATUS = Object.freeze({
  running: 'running',
  finished: 'finished',
  waiting: 'waiting',
  ended: 'ended',
});

const STATUS_SORT_ORDER = Object.freeze({
  waiting: 0,
  finished: 1,
  running: 2,
  ended: 3,
});

const LIGHT_BY_STATUS = Object.freeze({
  waiting: 'orange',
  finished: 'yellow',
  running: 'green',
  ended: 'grey',
});

export const FINISHED_VISIBLE_MS = 5 * 60 * 1000;

const PERMISSION_NOTIFICATION_TYPES = new Set(['permission_prompt', 'elicitation_dialog']);

export function endsWithQuestion(text) {
  return typeof text === 'string' && text.trimEnd().endsWith('?');
}

export function statusFromHookEvent(eventName, payload) {
  if (eventName === 'UserPromptSubmit') {
    return STATUS.running;
  }
  if (eventName === 'Stop') {
    if (payload.transcript_has_pending_agents) {
      return STATUS.running;
    }
    return payload.transcript_asks_question || endsWithQuestion(payload.last_assistant_message)
      ? STATUS.waiting
      : STATUS.finished;
  }
  if (eventName === 'SessionEnd') {
    return STATUS.ended;
  }
  if (eventName === 'Notification' && PERMISSION_NOTIFICATION_TYPES.has(payload.notification_type)) {
    return STATUS.waiting;
  }
  return null;
}

export function previewText(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 140);
}

export function promptPreview(prompt) {
  return previewText(`You: ${prompt}`);
}

function lastMessageFromHookEvent(eventName, payload, previousSession) {
  if (eventName === 'UserPromptSubmit' && payload.prompt) {
    return promptPreview(payload.prompt);
  }
  if (payload.last_assistant_message) {
    return previewText(payload.last_assistant_message);
  }
  return previousSession?.lastMessage ?? '';
}

export function applyHookEvent(sessionsById, { eventName, payload, now }) {
  const sessionId = payload.session_id;
  const nextStatus = statusFromHookEvent(eventName, payload);
  const previousSession = sessionsById.get(sessionId);
  if (!sessionId || !nextStatus || (!previousSession && eventName === 'SessionEnd')) {
    return { sessionsById };
  }

  const statusChanged = previousSession?.status !== nextStatus;
  const updatedSession = {
    ticket: null,
    entrypoint: '',
    ...previousSession,
    sessionId,
    status: nextStatus,
    statusChangedAt: statusChanged ? now : previousSession.statusChangedAt,
    cwd: payload.cwd ?? previousSession?.cwd ?? '',
    transcriptPath: payload.transcript_path ?? previousSession?.transcriptPath ?? '',
    name: previousSession?.name ?? nameFromCwd(payload.cwd),
    lastMessage: lastMessageFromHookEvent(eventName, payload, previousSession),
    waitingReason: eventName === 'Notification' ? payload.message ?? '' : '',
    interrupted: undefined,
  };

  const nextSessionsById = new Map(sessionsById);
  nextSessionsById.set(sessionId, updatedSession);

  return { sessionsById: nextSessionsById };
}

function statusChangeFromTail(session, { lastEntryAt, interruptedAt, asksQuestion }) {
  const isActive = session.status === STATUS.running || session.status === STATUS.waiting;
  if (isActive && interruptedAt > session.statusChangedAt) {
    return { status: STATUS.ended, statusChangedAt: interruptedAt, waitingReason: '', interrupted: true };
  }
  if (asksQuestion && session.status !== STATUS.waiting) {
    return { status: STATUS.waiting, statusChangedAt: lastEntryAt, waitingReason: '' };
  }
  if (session.status === STATUS.waiting && Boolean(session.waitingReason) && lastEntryAt > session.statusChangedAt) {
    return { status: STATUS.running, statusChangedAt: lastEntryAt, waitingReason: '' };
  }
  return null;
}

export function applyTranscriptTail(
  sessionsById,
  sessionId,
  { lastMessage, lastEntryAt, ticket, entrypoint = '', interruptedAt = 0, asksQuestion = false },
) {
  const session = sessionsById.get(sessionId);
  if (!session) {
    return sessionsById;
  }
  const updatedFields = {
    lastMessage: lastMessage || session.lastMessage,
    ticket: ticket ?? session.ticket ?? null,
    entrypoint: entrypoint || session.entrypoint || '',
    ...statusChangeFromTail(session, { lastEntryAt, interruptedAt, asksQuestion }),
  };
  const hasChanges = Object.entries(updatedFields).some(
    ([field, value]) => JSON.stringify(value) !== JSON.stringify(session[field]),
  );
  if (!hasChanges) {
    return sessionsById;
  }
  const nextSessionsById = new Map(sessionsById);
  nextSessionsById.set(sessionId, { ...session, ...updatedFields });
  return nextSessionsById;
}

export function mergeSavedSessions(scannedSessions, savedState) {
  if (!savedState) {
    return scannedSessions;
  }
  const savedSessionsById = new Map(savedState.sessions.map((session) => [session.sessionId, session]));
  return scannedSessions.map((scannedSession) => {
    const savedSession = savedSessionsById.get(scannedSession.sessionId);
    const savedStateIsCurrent = savedSession && savedState.savedAt >= scannedSession.lastEntryAt;
    const savedRunningWasSuperseded =
      savedSession?.status === STATUS.running && scannedSession.status !== STATUS.running;
    const scanFoundPendingQuestion = scannedSession.status === STATUS.waiting && savedSession?.status !== STATUS.waiting;
    return savedStateIsCurrent && !savedRunningWasSuperseded && !scanFoundPendingQuestion
      ? { ...savedSession, ticket: scannedSession.ticket, entrypoint: scannedSession.entrypoint }
      : scannedSession;
  });
}

export function applyDesktopMetadata(sessions, metadataByTranscriptId) {
  const ownSessions = sessions.filter((session) => !metadataByTranscriptId.get(session.sessionId)?.isSideQuestion);
  return ownSessions.map((session) => {
    const metadata = metadataByTranscriptId.get(session.sessionId);
    if (!metadata) {
      return { ...session, isArchived: false, pullRequests: [] };
    }
    const finishedAndAlreadySeen =
      session.status === STATUS.finished && metadata.lastFocusedAt >= metadata.lastTurnEdgeAt;
    return {
      ...session,
      name: metadata.title || session.name,
      isArchived: metadata.isArchived,
      pullRequests: metadata.pullRequests,
      status: finishedAndAlreadySeen ? STATUS.ended : session.status,
    };
  });
}

export function sortSessions(sessions) {
  return [...sessions].sort((first, second) => {
    const rankDifference = STATUS_SORT_ORDER[first.status] - STATUS_SORT_ORDER[second.status];
    if (rankDifference !== 0) {
      return rankDifference;
    }
    return second.statusChangedAt - first.statusChangedAt;
  });
}

export function generalLight(sessions) {
  if (sessions.some((session) => session.status === STATUS.waiting)) {
    return 'orange';
  }
  if (sessions.some((session) => session.status === STATUS.finished)) {
    return 'yellow';
  }
  if (sessions.some((session) => session.status === STATUS.running)) {
    return 'green';
  }
  return 'grey';
}

export function expireFinishedSessions(sessions, now) {
  return sessions.map((session) =>
    session.status === STATUS.finished && now - session.statusChangedAt > FINISHED_VISIBLE_MS
      ? { ...session, status: STATUS.ended }
      : session,
  );
}

export function acknowledgeSession(sessionsById, sessionId, now) {
  const session = sessionsById.get(sessionId);
  if (!session || session.status !== STATUS.finished) {
    return sessionsById;
  }
  const nextSessionsById = new Map(sessionsById);
  nextSessionsById.set(sessionId, { ...session, status: STATUS.ended, statusChangedAt: now });
  return nextSessionsById;
}

export function lightForStatus(status) {
  return LIGHT_BY_STATUS[status];
}

export function nameFromCwd(cwd) {
  return cwd ? basename(cwd) : 'unknown session';
}
