import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  acknowledgeSession,
  applyDesktopMetadata,
  applyHookEvent,
  applyTranscriptTail,
  expireFinishedSessions,
  FINISHED_VISIBLE_MS,
  generalLight,
  mergeSavedSessions,
  sortSessions,
  STATUS,
} from './session-state.mjs';
import {
  entrypointOfEntries,
  hasPendingBackgroundAgents,
  interruptedAtOf,
  lastEntryTimeOf,
  statusFromTranscriptEntries,
  ticketProgressFromEntries,
} from './transcript-scan.mjs';

const SESSION_ID = 'session-a';
const CWD = '/Users/dev/projects/sample-app';

function eventFor(eventName, extraPayload = {}, now = 1000) {
  return { eventName, now, payload: { session_id: SESSION_ID, cwd: CWD, transcript_path: '/tmp/a.jsonl', ...extraPayload } };
}

describe('applyHookEvent', () => {
  it('keeps the entrypoint the transcript gave the session through later hook events', () => {
    const withEntrypoint = applyTranscriptTail(
      applyHookEvent(new Map(), eventFor('SessionStart', {}, 1000)).sessionsById,
      SESSION_ID,
      { lastMessage: '', lastEntryAt: 1000, entrypoint: 'cli' },
    );
    const afterPrompt = applyHookEvent(withEntrypoint, eventFor('UserPromptSubmit', {}, 2000)).sessionsById;
    assert.equal(afterPrompt.get(SESSION_ID).entrypoint, 'cli');
    const withExtraField = new Map([[SESSION_ID, { ...afterPrompt.get(SESSION_ID), pullRequests: [] }]]);
    const afterStop = applyHookEvent(withExtraField, eventFor('Stop', {}, 3000)).sessionsById;
    assert.deepEqual(afterStop.get(SESSION_ID).pullRequests, []);
  });

  it('keeps the current status when the session is compacted or resumed', () => {
    const finished = applyHookEvent(new Map(), eventFor('Stop', {}, 1000)).sessionsById;
    const afterCompact = applyHookEvent(finished, eventFor('SessionStart', { source: 'compact' }, 2000)).sessionsById;
    assert.equal(afterCompact.get(SESSION_ID).status, STATUS.finished);
    assert.equal(afterCompact.get(SESSION_ID).statusChangedAt, 1000);
    const afterResume = applyHookEvent(finished, eventFor('SessionStart', { source: 'resume' }, 2000)).sessionsById;
    assert.equal(afterResume.get(SESSION_ID).status, STATUS.finished);
    assert.equal(afterResume.get(SESSION_ID).statusChangedAt, 1000);
    const afterStartup = applyHookEvent(finished, eventFor('SessionStart', { source: 'startup' }, 2000)).sessionsById;
    assert.equal(afterStartup.get(SESSION_ID).status, STATUS.running);
  });

  it('marks a session finished on Stop, unless its background agents are still working', () => {
    const result = applyHookEvent(new Map(), eventFor('Stop'));
    assert.equal(result.sessionsById.get(SESSION_ID).status, STATUS.finished);
    const withAgents = applyHookEvent(new Map(), eventFor('Stop', { transcript_has_pending_agents: true }));
    assert.equal(withAgents.sessionsById.get(SESSION_ID).status, STATUS.running);
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

  it('marks a session waiting on a permission prompt and keeps the reason until the next prompt', () => {
    const result = applyHookEvent(
      new Map(),
      eventFor('Notification', { notification_type: 'permission_prompt', message: 'Claude needs permission' }),
    );
    assert.equal(result.sessionsById.get(SESSION_ID).status, STATUS.waiting);
    assert.equal(result.sessionsById.get(SESSION_ID).waitingReason, 'Claude needs permission');
    const afterPrompt = applyHookEvent(result.sessionsById, eventFor('UserPromptSubmit', {}, 2000));
    assert.equal(afterPrompt.sessionsById.get(SESSION_ID).waitingReason, '');
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

describe('applyTranscriptTail', () => {
  it('shows the latest transcript text mid-turn, keeping the old text when there is none', () => {
    const afterStop = applyHookEvent(new Map(), eventFor('Stop', { last_assistant_message: 'Old reply.' }, 1000));
    const afterPrompt = applyHookEvent(afterStop.sessionsById, eventFor('UserPromptSubmit', {}, 2000));
    const ticket = { key: 'ABC-123', stage: 'build', stageStartedAt: 2400, designMode: 'superpowers' };
    const midTurn = applyTranscriptTail(afterPrompt.sessionsById, SESSION_ID, { lastMessage: 'Committing PR 1 now.', lastEntryAt: 2500, ticket, entrypoint: 'cli' });
    assert.equal(midTurn.get(SESSION_ID).entrypoint, 'cli');
    assert.equal(midTurn.get(SESSION_ID).lastMessage, 'Committing PR 1 now.');
    assert.equal(midTurn.get(SESSION_ID).status, STATUS.running);
    assert.deepEqual(midTurn.get(SESSION_ID).ticket, ticket);
    const afterNextStop = applyHookEvent(midTurn, eventFor('Stop', {}, 3000)).sessionsById;
    assert.deepEqual(afterNextStop.get(SESSION_ID).ticket, ticket);
    assert.equal(applyTranscriptTail(midTurn, SESSION_ID, { lastMessage: '', lastEntryAt: 2500 }), midTurn);
    assert.equal(applyTranscriptTail(midTurn, 'unknown', { lastMessage: 'Hi.', lastEntryAt: 2500 }), midTurn);
  });

  it('moves a permission prompt back to running once the transcript moves past it, but not a question', () => {
    const permissionEvent = eventFor('Notification', { notification_type: 'permission_prompt', message: 'Claude needs permission' }, 5000);
    const waitingOnPermission = applyHookEvent(new Map(), permissionEvent).sessionsById;
    const beforePrompt = applyTranscriptTail(waitingOnPermission, SESSION_ID, { lastMessage: '', lastEntryAt: 4000 });
    assert.equal(beforePrompt.get(SESSION_ID).status, STATUS.waiting);
    const approved = applyTranscriptTail(waitingOnPermission, SESSION_ID, { lastMessage: '', lastEntryAt: 6000 }).get(SESSION_ID);
    assert.equal(approved.status, STATUS.running);
    assert.equal(approved.waitingReason, '');
    assert.equal(approved.statusChangedAt, 6000);

    const waitingOnQuestion = applyHookEvent(new Map(), eventFor('Stop', { last_assistant_message: 'Ship it?' }, 5000)).sessionsById;
    const afterQuestion = applyTranscriptTail(waitingOnQuestion, SESSION_ID, { lastMessage: 'Ship it?', lastEntryAt: 6000 });
    assert.equal(afterQuestion.get(SESSION_ID).status, STATUS.waiting);
  });

  it('turns a session waiting when its transcript ends with a question box', () => {
    const finished = applyHookEvent(new Map(), eventFor('Stop', {}, 5000)).sessionsById;
    const asking = applyTranscriptTail(finished, SESSION_ID, { lastMessage: 'Done.', lastEntryAt: 6000, asksQuestion: true });
    assert.equal(asking.get(SESSION_ID).status, STATUS.waiting);
    assert.equal(asking.get(SESSION_ID).statusChangedAt, 6000);
    assert.equal(applyTranscriptTail(asking, SESSION_ID, { lastMessage: 'Done.', lastEntryAt: 7000, asksQuestion: true }), asking);
  });

  it('turns a running or permission-waiting session idle when you interrupt it, until your next prompt', () => {
    const running = applyHookEvent(new Map(), eventFor('UserPromptSubmit', {}, 2000)).sessionsById;
    const stopped = applyTranscriptTail(running, SESSION_ID, { lastMessage: '', lastEntryAt: 2500, interruptedAt: 2500 }).get(SESSION_ID);
    assert.equal(stopped.status, STATUS.ended);
    assert.equal(stopped.interrupted, true);
    assert.equal(stopped.statusChangedAt, 2500);

    const permissionEvent = eventFor('Notification', { notification_type: 'permission_prompt', message: 'Claude needs permission' }, 5000);
    const waitingOnPermission = applyHookEvent(new Map(), permissionEvent).sessionsById;
    const stoppedAtPrompt = applyTranscriptTail(waitingOnPermission, SESSION_ID, { lastMessage: '', lastEntryAt: 6000, interruptedAt: 6000 });
    assert.equal(stoppedAtPrompt.get(SESSION_ID).status, STATUS.ended);
    assert.equal(stoppedAtPrompt.get(SESSION_ID).waitingReason, '');

    const resumed = applyHookEvent(new Map([[SESSION_ID, stopped]]), eventFor('UserPromptSubmit', {}, 3000)).sessionsById;
    assert.equal(resumed.get(SESSION_ID).interrupted, undefined);
    const staleInterrupt = applyTranscriptTail(resumed, SESSION_ID, { lastMessage: '', lastEntryAt: 3100, interruptedAt: 2500 });
    assert.equal(staleInterrupt.get(SESSION_ID).status, STATUS.running);
  });
});

describe('mergeSavedSessions', () => {
  it('keeps the saved state unless the transcript has a newer message, and drops sessions no longer scanned', () => {
    const scannedSessions = [
      { sessionId: 'quiet', status: STATUS.ended, lastEntryAt: 1000, ticket: { key: 'ABC-1', stage: 'ship' } },
      { sessionId: 'moved-on', status: STATUS.finished, lastEntryAt: 3000 },
      { sessionId: 'new', status: STATUS.running, lastEntryAt: 3000 },
      { sessionId: 'stuck-running', status: STATUS.finished, lastEntryAt: 1000 },
      { sessionId: 'asking', status: STATUS.waiting, lastEntryAt: 1000 },
    ];
    const savedState = {
      savedAt: 2000,
      sessions: [
        { sessionId: 'quiet', status: STATUS.waiting, waitingReason: 'Claude needs your permission to use Bash' },
        { sessionId: 'moved-on', status: STATUS.waiting },
        { sessionId: 'gone', status: STATUS.waiting },
        { sessionId: 'stuck-running', status: STATUS.running },
        { sessionId: 'asking', status: STATUS.ended },
      ],
    };
    const merged = mergeSavedSessions(scannedSessions, savedState);
    assert.deepEqual(
      merged.map((session) => [session.sessionId, session.status]),
      [
        ['quiet', STATUS.waiting],
        ['moved-on', STATUS.finished],
        ['new', STATUS.running],
        ['stuck-running', STATUS.finished],
        ['asking', STATUS.waiting],
      ],
    );
    assert.equal(merged[0].waitingReason, 'Claude needs your permission to use Bash');
    assert.deepEqual(merged[0].ticket, { key: 'ABC-1', stage: 'ship' });
    assert.equal(mergeSavedSessions(scannedSessions, null), scannedSessions);
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

  it('uses the desktop title, archived flag and pull requests', () => {
    const pullRequests = [{ number: 412, url: 'https://github.com/o/r/pull/412', state: 'OPEN', autoFix: true }];
    const metadata = new Map([['a', { title: 'Real title', isArchived: true, lastFocusedAt: 0, lastTurnEdgeAt: 5, pullRequests }]]);
    const [session] = applyDesktopMetadata([finishedSession], metadata);
    assert.equal(session.name, 'Real title');
    assert.equal(session.isArchived, true);
    assert.deepEqual(session.pullRequests, pullRequests);
    assert.deepEqual(applyDesktopMetadata([finishedSession], new Map())[0].pullRequests, []);

    const sideQuestion = new Map([['a', { title: 'Real title', isArchived: false, isSideQuestion: true, pullRequests: [] }]]);
    assert.deepEqual(applyDesktopMetadata([finishedSession], sideQuestion), []);
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

  it('is ended when you interrupted the last turn, until Claude or you continue', () => {
    const interrupted = [
      { type: 'user', message: { content: 'hi' } },
      { type: 'assistant', message: { stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-11-05T20:00:00.000Z', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
      { type: 'user', message: { content: '<task-notification>\n<task-type>artifact-auto-react</task-type>' } },
      { type: 'assistant', isSidechain: true, message: { stop_reason: 'tool_use' } },
    ];
    assert.equal(interruptedAtOf(interrupted), Date.parse('2026-11-05T20:00:00.000Z'));
    assert.equal(statusFromTranscriptEntries(interrupted, { lastActivityAt: now, now }), STATUS.ended);
    const continued = [...interrupted, { type: 'user', message: { content: 'try again' } }];
    assert.equal(interruptedAtOf(continued), 0);
    assert.equal(statusFromTranscriptEntries(continued, { lastActivityAt: now, now }), STATUS.running);
    const answered = [...interrupted, { type: 'assistant', message: { stop_reason: 'tool_use' } }];
    assert.equal(interruptedAtOf(answered), 0);
  });

  it('is ended when the file has been quiet for a long time', () => {
    const entries = [{ type: 'user', message: { content: 'hi' } }];
    assert.equal(statusFromTranscriptEntries(entries, { lastActivityAt: 0, now }), STATUS.ended);
  });

  it('stays running after the turn ends while background agents have not reported back', () => {
    const launched = [
      { type: 'user', message: { content: 'spin up agents' } },
      { type: 'user', message: { content: [{ type: 'tool_result' }] }, toolUseResult: { status: 'async_launched', agentId: 'agent-1' } },
      { type: 'user', message: { content: [{ type: 'tool_result' }] }, toolUseResult: { status: 'async_launched', agentId: 'agent-2' } },
      { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Agents are running.' }] } },
    ];
    const firstReported = [
      ...launched,
      { type: 'user', message: { content: '<task-notification>\n<task-id>agent-1</task-id>\n<status>completed</status>' } },
      { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'One is back.' }] } },
    ];
    const allReported = [
      ...firstReported,
      {
        type: 'attachment',
        attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>agent-2</task-id>\n<status>completed</status>' },
      },
      { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'All back.' }] } },
    ];
    assert.equal(hasPendingBackgroundAgents(launched), true);
    assert.equal(statusFromTranscriptEntries(launched, { lastActivityAt: now, now }), STATUS.running);
    assert.equal(statusFromTranscriptEntries(firstReported, { lastActivityAt: now, now }), STATUS.running);
    assert.equal(hasPendingBackgroundAgents(allReported), false);
    assert.equal(statusFromTranscriptEntries(allReported, { lastActivityAt: now, now }), STATUS.finished);

    const interimReport = [
      ...allReported,
      { type: 'user', message: { content: [{ type: 'tool_result' }] }, toolUseResult: { status: 'async_launched', agentId: 'agent-3' } },
      {
        type: 'queue-operation',
        content: '<task-notification>\n<task-id>agent-3</task-id>\n<status>completed</status>\n<summary>Agent "Build" is waiting on its own background work</summary>',
      },
    ];
    const finalReport = [
      ...interimReport,
      {
        type: 'queue-operation',
        content: '<task-notification>\n<task-id>agent-3</task-id>\n<status>completed</status>\n<summary>Agent "Build" finished</summary>',
      },
    ];
    assert.equal(hasPendingBackgroundAgents(interimReport), true);
    assert.equal(hasPendingBackgroundAgents(finalReport), false);
  });

  it('takes the entrypoint from the latest entry that names one', () => {
    const movedToDesktop = [
      { type: 'user', entrypoint: 'cli', message: { content: 'hi' } },
      { type: 'assistant', entrypoint: 'claude-desktop', message: { stop_reason: 'end_turn' } },
      { type: 'frame-link' },
    ];
    assert.equal(entrypointOfEntries(movedToDesktop), 'claude-desktop');
    assert.equal(entrypointOfEntries([{ type: 'frame-link' }]), '');
  });

  it('times the last message, ignoring later bookkeeping entries', () => {
    const entries = [
      { type: 'user', timestamp: '2026-11-05T20:00:00.000Z', message: { content: 'hi' } },
      { type: 'assistant', timestamp: '2026-11-05T20:00:05.000Z', message: { stop_reason: 'tool_use' } },
      { type: 'frame-link', timestamp: '2026-11-05T21:00:00.000Z' },
    ];
    assert.equal(lastEntryTimeOf(entries), Date.parse('2026-11-05T20:00:05.000Z'));
    assert.equal(lastEntryTimeOf([]), 0);
  });
});

describe('ticketProgressFromEntries', () => {
  const at = (minute) => `2026-11-05T10:${String(minute).padStart(2, '0')}:00.000Z`;
  const command = (minute, name, args = '') => ({
    type: 'user',
    timestamp: at(minute),
    gitBranch: 'claude/search-feature-1a2b3c',
    message: { content: `<command-name>/${name}</command-name>\n<command-args>${args}</command-args>` },
  });
  const toolUse = (minute, name, input = {}, gitBranch = 'dev/abc-123-search') => ({
    type: 'assistant',
    timestamp: at(minute),
    gitBranch,
    message: { content: [{ type: 'tool_use', name, input }] },
  });
  const skill = (minute, name) => toolUse(minute, 'Skill', { skill: name });

  it('walks a superpowers run through every stage, ignoring design docs written before the build', () => {
    const entries = [
      command(0, 'zero-to-shipped', 'add search to the list page'),
      skill(1, 'initialize-worktree'),
      skill(5, 'superpowers:brainstorming'),
      toolUse(20, 'Write', { file_path: 'docs/design.md' }),
      skill(40, 'superpowers:writing-plans'),
      skill(50, 'superpowers:subagent-driven-development'),
    ];
    const building = ticketProgressFromEntries(entries, null);
    assert.equal(building.key, 'ABC-123');
    assert.equal(building.stage, 'build');
    assert.equal(building.stageStartedAt, Date.parse(at(50)));

    const autoFixEvent = { type: 'user', timestamp: at(59), message: { content: '<ci-monitor-event>"Auto-fix pull requests" is watching PR #412' } };
    assert.equal(ticketProgressFromEntries([skill(51, 'some-other-skill')], building).stage, 'build');
    const reviewing = ticketProgressFromEntries([command(52, 'simplify')], building);
    assert.equal(reviewing.stage, 'review');
    const shipping = ticketProgressFromEntries([skill(55, 'open-nice-pr')], reviewing);
    assert.equal(shipping.stage, 'ship');
    const inFeedback = ticketProgressFromEntries([autoFixEvent], shipping);
    assert.equal(inFeedback.stage, 'feedback');
    assert.equal(inFeedback.stageStartedAt, Date.parse(at(59)));
    assert.equal(ticketProgressFromEntries([skill(52, 'code-review')], inFeedback).stage, 'feedback');

    const quotedCommand = { type: 'user', timestamp: at(0), message: { content: 'Commands look like <command-name>/zero-to-shipped</command-name>.' } };
    assert.equal(ticketProgressFromEntries([quotedCommand, skill(50, 'ship-it')], null), null);
  });

  it('starts the build at the first edit after plan approval, or right away for a direct edit', () => {
    const planned = ticketProgressFromEntries(
      [
        command(0, 'zero-to-shipped', 'XYZ-7'),
        toolUse(2, 'EnterPlanMode', {}, 'claude/quiet-river-0f9e8d'),
        toolUse(5, 'Write', { file_path: 'plan.html' }, 'claude/quiet-river-0f9e8d'),
        toolUse(9, 'ExitPlanMode', {}, 'claude/quiet-river-0f9e8d'),
        toolUse(12, 'Edit', { file_path: 'src/app.ts' }, 'claude/quiet-river-0f9e8d'),
      ],
      null,
    );
    assert.equal(planned.key, 'XYZ-7');
    assert.equal(planned.stage, 'build');
    assert.equal(planned.stageStartedAt, Date.parse(at(12)));

    const direct = ticketProgressFromEntries([command(0, 'zero-to-shipped'), toolUse(3, 'Edit', { file_path: 'a.ts' })], null);
    assert.equal(direct.stageStartedAt, Date.parse(at(3)));
    assert.equal(ticketProgressFromEntries([skill(1, 'ship-it')], null), null);
  });
});
