import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  acknowledgeSession,
  applyDesktopMetadata,
  applyHookEvent,
  expireFinishedSessions,
  FINISHED_VISIBLE_MS,
  generalLight,
  sortSessions,
  STATUS,
} from './session-state.mjs';
import { statusFromTranscriptEntries } from './transcript-scan.mjs';

const SESSION_ID = 'session-a';
const CWD = '/Users/dev/projects/sample-app';

function eventFor(eventName, extraPayload = {}, now = 1000) {
  return { eventName, now, payload: { session_id: SESSION_ID, cwd: CWD, transcript_path: '/tmp/a.jsonl', ...extraPayload } };
}

describe('applyHookEvent', () => {
  it('marks a session finished on Stop', () => {
    const result = applyHookEvent(new Map(), eventFor('Stop'));
    assert.equal(result.sessionsById.get(SESSION_ID).status, STATUS.finished);
  });

  it('keeps the original status time when the status did not change', () => {
    const afterFirstStop = applyHookEvent(new Map(), eventFor('Stop', {}, 1000));
    const afterSecondStop = applyHookEvent(afterFirstStop.sessionsById, eventFor('Stop', {}, 2000));
    assert.equal(afterSecondStop.sessionsById.get(SESSION_ID).statusChangedAt, 1000);
  });

  it('marks a session waiting when the reply ends with a question', () => {
    const result = applyHookEvent(
      new Map(),
      eventFor('Stop', { last_assistant_message: 'Should I build it?' }),
    );
    assert.equal(result.sessionsById.get(SESSION_ID).status, STATUS.waiting);
  });

  it('marks a session waiting when the transcript shows a question box', () => {
    const result = applyHookEvent(
      new Map(),
      eventFor('Stop', { last_assistant_message: 'Done.', transcript_asks_question: true }),
    );
    assert.equal(result.sessionsById.get(SESSION_ID).status, STATUS.waiting);
  });

  it('marks a session waiting on a permission prompt', () => {
    const result = applyHookEvent(
      new Map(),
      eventFor('Notification', { notification_type: 'permission_prompt', message: 'Claude needs permission' }),
    );
    assert.equal(result.sessionsById.get(SESSION_ID).status, STATUS.waiting);
  });

  it('ignores idle notifications because a finished session is already yellow', () => {
    const afterStop = applyHookEvent(new Map(), eventFor('Stop', {}, 1000));
    const afterIdle = applyHookEvent(
      afterStop.sessionsById,
      eventFor('Notification', { notification_type: 'idle_prompt' }, 2000),
    );
    assert.equal(afterIdle.sessionsById.get(SESSION_ID).status, STATUS.finished);
  });

  it('moves a finished session back to running when the user submits a prompt', () => {
    const afterStop = applyHookEvent(new Map(), eventFor('Stop', {}, 1000));
    const afterPrompt = applyHookEvent(afterStop.sessionsById, eventFor('UserPromptSubmit', {}, 2000));
    assert.equal(afterPrompt.sessionsById.get(SESSION_ID).status, STATUS.running);
    assert.equal(afterPrompt.sessionsById.get(SESSION_ID).statusChangedAt, 2000);
  });

  it('ignores events without a session id', () => {
    const sessionsById = new Map();
    const result = applyHookEvent(sessionsById, { eventName: 'Stop', now: 1000, payload: {} });
    assert.equal(result.sessionsById, sessionsById);
  });
});

describe('generalLight', () => {
  const sessionWithStatus = (status) => ({ sessionId: status, status, statusChangedAt: 0 });

  it('is green when nothing is blocked or finished', () => {
    assert.equal(generalLight([sessionWithStatus(STATUS.running), sessionWithStatus(STATUS.ended)]), 'green');
  });

  it('is grey when no session is running', () => {
    assert.equal(generalLight([sessionWithStatus(STATUS.ended)]), 'grey');
    assert.equal(generalLight([]), 'grey');
  });

  it('is yellow when at least one session finished', () => {
    assert.equal(generalLight([sessionWithStatus(STATUS.running), sessionWithStatus(STATUS.finished)]), 'yellow');
  });

  it('is orange when at least one session waits for you, even with finished ones', () => {
    assert.equal(generalLight([sessionWithStatus(STATUS.finished), sessionWithStatus(STATUS.waiting)]), 'orange');
  });
});

describe('applyDesktopMetadata', () => {
  const finishedSession = { sessionId: 'a', status: STATUS.finished, statusChangedAt: 0, name: 'first prompt text' };

  it('uses the desktop title and archived flag', () => {
    const metadata = new Map([['a', { title: 'Real title', isArchived: true, lastFocusedAt: 0, lastTurnEdgeAt: 5 }]]);
    const [session] = applyDesktopMetadata([finishedSession], metadata);
    assert.equal(session.name, 'Real title');
    assert.equal(session.isArchived, true);
  });

  it('keeps finished yellow only when the turn ended after you last looked', () => {
    const unseen = new Map([['a', { title: '', isArchived: false, lastFocusedAt: 1, lastTurnEdgeAt: 5 }]]);
    const seen = new Map([['a', { title: '', isArchived: false, lastFocusedAt: 5, lastTurnEdgeAt: 5 }]]);
    assert.equal(applyDesktopMetadata([finishedSession], unseen)[0].status, STATUS.finished);
    assert.equal(applyDesktopMetadata([finishedSession], seen)[0].status, STATUS.ended);
  });

  it('keeps the original name and status for sessions without desktop metadata', () => {
    const [session] = applyDesktopMetadata([finishedSession], new Map());
    assert.equal(session.name, 'first prompt text');
    assert.equal(session.status, STATUS.finished);
    assert.equal(session.isArchived, false);
  });
});

describe('finished sessions clearing', () => {
  const finishedSession = { sessionId: 'a', status: STATUS.finished, statusChangedAt: 1000 };

  it('turns idle after the visible time passes', () => {
    const [stillVisible] = expireFinishedSessions([finishedSession], 1000 + FINISHED_VISIBLE_MS);
    const [expired] = expireFinishedSessions([finishedSession], 1000 + FINISHED_VISIBLE_MS + 1);
    assert.equal(stillVisible.status, STATUS.finished);
    assert.equal(expired.status, STATUS.ended);
  });

  it('turns idle when acknowledged, and ignores sessions that are not finished', () => {
    const sessionsById = new Map([
      ['a', finishedSession],
      ['b', { sessionId: 'b', status: STATUS.waiting, statusChangedAt: 1000 }],
    ]);
    const afterAcknowledge = acknowledgeSession(sessionsById, 'a', 2000);
    assert.equal(afterAcknowledge.get('a').status, STATUS.ended);
    assert.equal(acknowledgeSession(sessionsById, 'b', 2000), sessionsById);
  });
});

describe('sortSessions', () => {
  it('orders by status group, then newest status change first', () => {
    const sessions = [
      { sessionId: 'running-old', status: STATUS.running, statusChangedAt: 100 },
      { sessionId: 'finished-old', status: STATUS.finished, statusChangedAt: 100 },
      { sessionId: 'waiting', status: STATUS.waiting, statusChangedAt: 50 },
      { sessionId: 'finished-new', status: STATUS.finished, statusChangedAt: 300 },
      { sessionId: 'running-new', status: STATUS.running, statusChangedAt: 400 },
    ];
    assert.deepEqual(
      sortSessions(sessions).map((session) => session.sessionId),
      ['waiting', 'finished-new', 'finished-old', 'running-new', 'running-old'],
    );
  });
});

describe('statusFromTranscriptEntries', () => {
  const now = 10_000_000;

  it('is finished when the last assistant message ended its turn', () => {
    const entries = [
      { type: 'user', message: { content: 'hi' } },
      { type: 'assistant', message: { stop_reason: 'end_turn' } },
    ];
    assert.equal(statusFromTranscriptEntries(entries, { lastActivityAt: now, now }), STATUS.finished);
  });

  it('is running when a tool call is pending and the file is recent', () => {
    const entries = [
      { type: 'user', message: { content: 'hi' } },
      { type: 'assistant', message: { stop_reason: 'tool_use' } },
    ];
    assert.equal(statusFromTranscriptEntries(entries, { lastActivityAt: now, now }), STATUS.running);
  });

  it('is waiting when the last assistant text ends with a question', () => {
    const entries = [
      { type: 'user', message: { content: 'hi' } },
      { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Build it?' }] } },
    ];
    assert.equal(statusFromTranscriptEntries(entries, { lastActivityAt: now, now }), STATUS.waiting);
  });

  it('is waiting when the last assistant turn shows a question box', () => {
    const entries = [
      { type: 'user', message: { content: 'hi' } },
      {
        type: 'assistant',
        message: {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', name: 'mcp__ccd_turn__wrap_up', input: { recap: 'Done.', ask: 'Tighten the filter?' } }],
        },
      },
      { type: 'user', message: { content: [{ type: 'tool_result' }] } },
      { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done, the numbers are rough.' }] } },
    ];
    assert.equal(statusFromTranscriptEntries(entries, { lastActivityAt: now, now }), STATUS.waiting);
  });

  it('is ended when the file has been quiet for a long time', () => {
    const entries = [{ type: 'user', message: { content: 'hi' } }];
    assert.equal(statusFromTranscriptEntries(entries, { lastActivityAt: 0, now }), STATUS.ended);
  });
});
