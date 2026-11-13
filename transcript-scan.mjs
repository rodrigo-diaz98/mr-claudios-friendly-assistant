import { open, readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { endsWithQuestion, STATUS, nameFromCwd, promptPreview } from './session-state.mjs';
import { stageOfSkill, TICKET_ENTRY_SKILL, TICKET_STAGES } from './stage-skills.mjs';

const SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;
const QUIET_AFTER_MS = 10 * 60 * 1000;
const BACKGROUND_TASK_LIMIT_MS = 60 * 60 * 1000;
const WRAP_UP_TOOL_NAME = 'mcp__ccd_turn__wrap_up';
const NAME_MAX_LENGTH = 80;
const LAST_MESSAGE_MAX_LENGTH = 140;
const TAIL_BYTES = 512 * 1024;
const TASK_NOTIFICATION_ID_PATTERN = /<task-notification>[\s\S]*?<task-id>([^<]+)<\/task-id>/;
const INTERIM_REPORT_PATTERN = /<summary>[^<]*waiting on its own background work<\/summary>/;
const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const STOP_TOOL_NAMES = new Set(['TaskStop', 'KillShell']);
const INTERRUPT_MARKER = '[Request interrupted by user';
const COMMAND_NAME_PATTERN = /^(?:<command-message>[^<]*<\/command-message>\s*)?<command-name>\/?([^<]+)<\/command-name>/;
const TICKET_KEY_IN_BRANCH_PATTERN = /(?:^|\/)([a-z]{2,10}-\d+)(?=-|$)/i;
const TICKET_KEY_IN_TEXT_PATTERN = /\b([A-Z]{2,10}-\d+)\b/;
const APP_ACTION_LABELS = {
  commit: 'Commit',
  create_pr: 'Create PR',
  merge: 'Merge',
  fix_ci: 'Fix CI',
  resolve_conflicts: 'Resolve conflicts',
  address_comments: 'Address comments',
  verify: 'Verify',
};

export function parseTranscriptLines(rawText) {
  const entries = [];
  for (const line of rawText.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  return entries;
}

function lastMessageEntryOf(entries) {
  return entries.findLast((entry) => entry.type === 'user' || entry.type === 'assistant');
}

function notificationTextOf(entry) {
  if (entry.type === 'queue-operation') {
    return entry.content;
  }
  if (entry.type === 'attachment') {
    return entry.attachment?.prompt;
  }
  return entry.type === 'user' ? entry.message?.content : null;
}

function stoppedTaskIdsOf(entry) {
  const contentParts = entry.type === 'assistant' && Array.isArray(entry.message?.content) ? entry.message.content : [];
  return contentParts
    .filter((part) => part.type === 'tool_use' && STOP_TOOL_NAMES.has(part.name))
    .map((part) => part.input?.task_id ?? part.input?.shell_id)
    .filter(Boolean);
}

export function hasPendingBackgroundAgents(entries, now) {
  const startedAtByTaskId = new Map();
  for (const entry of entries) {
    const startedAt = Date.parse(entry.timestamp ?? '');
    if (entry.toolUseResult?.status === 'async_launched' && entry.toolUseResult.agentId) {
      startedAtByTaskId.set(entry.toolUseResult.agentId, startedAt);
    }
    if (entry.toolUseResult?.backgroundTaskId) {
      startedAtByTaskId.set(entry.toolUseResult.backgroundTaskId, startedAt);
    }
    for (const stoppedTaskId of stoppedTaskIdsOf(entry)) {
      startedAtByTaskId.delete(stoppedTaskId);
    }
    const notificationText = notificationTextOf(entry);
    const notifiedAgentId = typeof notificationText === 'string' ? notificationText.match(TASK_NOTIFICATION_ID_PATTERN)?.[1] : null;
    if (notifiedAgentId && INTERIM_REPORT_PATTERN.test(notificationText)) {
      startedAtByTaskId.set(notifiedAgentId, startedAt);
    } else if (notifiedAgentId) {
      startedAtByTaskId.delete(notifiedAgentId);
    }
  }
  return [...startedAtByTaskId.values()].some((startedAt) => now - startedAt <= BACKGROUND_TASK_LIMIT_MS);
}

function commandNameOf(entry) {
  const content = entry.type === 'user' ? entry.message?.content : null;
  return typeof content === 'string' ? content.match(COMMAND_NAME_PATTERN)?.[1] ?? null : null;
}

function toolUsesOf(entry) {
  const content = entry.type === 'assistant' ? entry.message?.content : null;
  return Array.isArray(content) ? content.filter((part) => part.type === 'tool_use') : [];
}

function isAutoFixEvent(entry) {
  const text = notificationTextOf(entry);
  return typeof text === 'string' && text.trimStart().startsWith('<ci-monitor-event');
}

function ticketKeyIn(text) {
  return typeof text === 'string' ? text.match(TICKET_KEY_IN_TEXT_PATTERN)?.[1] ?? null : null;
}

function advanceStage(progress, stage, at) {
  return TICKET_STAGES.indexOf(stage) > TICKET_STAGES.indexOf(progress.stage)
    ? { ...progress, stage, stageStartedAt: at }
    : progress;
}

export function ticketProgressFromEntries(entries, previousProgress) {
  let progress = previousProgress;
  for (const entry of entries) {
    const at = entry.timestamp ? Date.parse(entry.timestamp) : 0;
    const toolUses = toolUsesOf(entry);
    const skillNames = [commandNameOf(entry), ...toolUses.filter((toolUse) => toolUse.name === 'Skill').map((toolUse) => toolUse.input?.skill)];
    if (!progress) {
      if (skillNames.includes(TICKET_ENTRY_SKILL)) {
        const args = typeof entry.message?.content === 'string' ? entry.message.content : toolUses.map((toolUse) => toolUse.input?.args).join(' ');
        progress = { key: ticketKeyIn(args), stage: 'design', stageStartedAt: at, designMode: 'direct' };
      }
      continue;
    }

    const branchKey = entry.gitBranch?.match(TICKET_KEY_IN_BRANCH_PATTERN)?.[1]?.toUpperCase();
    if (branchKey && branchKey !== progress.key) {
      progress = { ...progress, key: branchKey };
    }
    for (const skillName of skillNames) {
      const stage = stageOfSkill(skillName);
      if (stage === 'design') {
        if (skillName !== TICKET_ENTRY_SKILL) {
          progress = { ...progress, designMode: 'superpowers' };
        }
      } else if (stage) {
        progress = advanceStage(progress, stage, at);
      }
    }
    for (const toolUse of toolUses) {
      if (toolUse.name === 'EnterPlanMode') {
        progress = { ...progress, designMode: 'plan' };
      } else if (toolUse.name === 'ExitPlanMode') {
        progress = { ...progress, designMode: 'direct' };
      } else if (EDIT_TOOL_NAMES.has(toolUse.name) && progress.designMode === 'direct') {
        progress = advanceStage(progress, 'build', at);
      } else if (!progress.key && toolUse.name.endsWith('getJiraIssue')) {
        progress = { ...progress, key: ticketKeyIn(toolUse.input?.issueIdOrKey) };
      } else if (!progress.key && toolUse.name === 'Skill' && toolUse.input?.skill === 'initialize-worktree') {
        progress = { ...progress, key: ticketKeyIn(toolUse.input?.args) };
      }
    }
    if (isAutoFixEvent(entry)) {
      progress = advanceStage(progress, 'feedback', at);
    }
  }
  return progress;
}

export function entrypointOfEntries(entries) {
  return entries.findLast((entry) => entry.entrypoint)?.entrypoint ?? '';
}

export function lastEntryTimeOf(entries) {
  const timestamp = lastMessageEntryOf(entries)?.timestamp;
  return timestamp ? Date.parse(timestamp) : 0;
}

function entriesSincePrompt(entries) {
  const lastPromptIndex = entries.findLastIndex(
    (entry) => (entry.type === 'user' && typeof entry.message?.content === 'string') || isTypedPrompt(entry),
  );
  return entries.slice(lastPromptIndex + 1);
}

export function lastPromptAtOf(entries) {
  return Date.parse(entries.findLast(isTypedPrompt)?.timestamp ?? '') || 0;
}

function hasQuestionBox(entry) {
  const contentParts = Array.isArray(entry.message?.content) ? entry.message.content : [];
  return contentParts.some(
    (part) =>
      part.type === 'tool_use' &&
      part.name === WRAP_UP_TOOL_NAME &&
      typeof part.input?.ask === 'string' &&
      part.input.ask.trim().length > 0,
  );
}

export function transcriptAsksQuestion(entries) {
  const lastMessageEntry = lastMessageEntryOf(entries);
  if (lastMessageEntry?.type !== 'assistant' || lastMessageEntry.message?.stop_reason !== 'end_turn') {
    return false;
  }
  return (
    endsWithQuestion(textFromAssistantEntry(lastMessageEntry)) ||
    entriesSincePrompt(entries).some((entry) => entry.type === 'assistant' && hasQuestionBox(entry))
  );
}

function userTextOf(entry) {
  const content = entry.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  return Array.isArray(content) ? content.filter((part) => part.type === 'text').map((part) => part.text).join(' ') : '';
}

function isInterruptMarker(entry) {
  return entry.type === 'user' && userTextOf(entry).trimStart().startsWith(INTERRUPT_MARKER);
}

function continuesAfterInterrupt(entry) {
  if (entry.type === 'assistant') {
    return true;
  }
  return entry.type === 'user' && typeof entry.message?.content === 'string' && !entry.message.content.startsWith('<task-notification>');
}

export function interruptedAtOf(entries) {
  const mainEntries = entries.filter((entry) => !entry.isSidechain);
  const interruptIndex = mainEntries.findLastIndex(isInterruptMarker);
  if (interruptIndex === -1 || mainEntries.slice(interruptIndex + 1).some(continuesAfterInterrupt)) {
    return 0;
  }
  return Date.parse(mainEntries[interruptIndex].timestamp) || 0;
}

export function statusFromTranscriptEntries(entries, { lastActivityAt, now }) {
  const lastMessageEntry = lastMessageEntryOf(entries);
  if (!lastMessageEntry || interruptedAtOf(entries) > 0) {
    return STATUS.ended;
  }
  if (hasPendingBackgroundAgents(entries, now) && now - lastActivityAt <= QUIET_AFTER_MS) {
    return STATUS.running;
  }
  if (lastMessageEntry.type === 'assistant' && lastMessageEntry.message?.stop_reason === 'end_turn') {
    return transcriptAsksQuestion(entries) ? STATUS.waiting : STATUS.finished;
  }
  if (now - lastActivityAt > QUIET_AFTER_MS) {
    return STATUS.ended;
  }
  return STATUS.running;
}

function textFromAssistantEntry(entry) {
  const contentParts = Array.isArray(entry.message?.content) ? entry.message.content : [];
  return contentParts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ');
}

function lastAssistantEntryWithText(entries) {
  return entries.findLast(
    (entry) => entry.type === 'assistant' && textFromAssistantEntry(entry).length > 0,
  );
}

function isTypedPrompt(entry) {
  if (entry.type !== 'user' || entry.isSidechain || entry.isMeta || isInterruptMarker(entry)) {
    return false;
  }
  const content = entry.message?.content;
  if (typeof content === 'string') {
    return !content.startsWith('<');
  }
  return (
    Array.isArray(content) &&
    content.some((part) => part.type === 'text') &&
    !content.some((part) => part.type === 'tool_result')
  );
}

function questionBoxOf(entries) {
  const entry = entries.findLast((candidate) => candidate.type === 'assistant' && hasQuestionBox(candidate));
  if (!entry) {
    return null;
  }
  const { input } = entry.message.content.find((part) => part.type === 'tool_use' && part.name === WRAP_UP_TOOL_NAME);
  const choices = (input.actions ?? [])
    .map(({ action, label, message }) =>
      action ? { label: APP_ACTION_LABELS[action], message: APP_ACTION_LABELS[action] } : { label, message: message ?? label },
    )
    .filter((choice) => choice.label);
  return { question: input.ask.trim(), choices };
}

export function latestExchangeFromTranscriptEntries(entries) {
  const promptIndex = entries.findLastIndex(isTypedPrompt);
  const sincePrompt = entries.slice(promptIndex + 1);
  const lastAssistantEntry = lastAssistantEntryWithText(sincePrompt);
  if (lastAssistantEntry) {
    return { from: 'claude', text: textFromAssistantEntry(lastAssistantEntry).trim(), ask: questionBoxOf(sincePrompt) };
  }
  return promptIndex === -1 ? null : { from: 'you', text: userTextOf(entries[promptIndex]).trim(), ask: null };
}

export function lastMessageFromTranscriptEntries(entries) {
  const latest = latestExchangeFromTranscriptEntries(entries);
  if (!latest) {
    return '';
  }
  return latest.from === 'you' ? promptPreview(latest.text) : singleLine(latest.text);
}

export function singleLine(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, LAST_MESSAGE_MAX_LENGTH);
}

export function nameFromTranscriptEntries(entries, cwd) {
  const firstTypedPrompt = entries.find(
    (entry) =>
      entry.type === 'user' &&
      typeof entry.message?.content === 'string' &&
      !entry.message.content.startsWith('<'),
  );
  if (!firstTypedPrompt) {
    return nameFromCwd(cwd);
  }
  return firstTypedPrompt.message.content.trim().slice(0, NAME_MAX_LENGTH);
}

export async function readTranscriptTail(transcriptPath, fileSize) {
  const length = Math.min(fileSize, TAIL_BYTES);
  const fileHandle = await open(transcriptPath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await fileHandle.read(buffer, 0, length, fileSize - length);
    return buffer.toString('utf8');
  } finally {
    await fileHandle.close();
  }
}

async function listTranscriptFiles(projectsDir) {
  const projectNames = await readdir(projectsDir).catch(() => []);
  const transcriptPaths = [];
  for (const projectName of projectNames) {
    const projectPath = join(projectsDir, projectName);
    const fileNames = await readdir(projectPath).catch(() => []);
    for (const fileName of fileNames) {
      if (fileName.endsWith('.jsonl')) {
        transcriptPaths.push(join(projectPath, fileName));
      }
    }
  }
  return transcriptPaths;
}

export async function scanTranscripts({ projectsDir, now, openSessionIds }) {
  const transcriptPaths = await listTranscriptFiles(projectsDir);
  const sessions = [];
  for (const transcriptPath of transcriptPaths) {
    const sessionId = basename(transcriptPath, '.jsonl');
    const fileStats = await stat(transcriptPath);
    if (now - fileStats.mtimeMs > SCAN_WINDOW_MS && !openSessionIds.has(sessionId)) {
      continue;
    }
    const entries = parseTranscriptLines(await readFile(transcriptPath, 'utf8'));
    const cwd = entries.find((entry) => entry.cwd)?.cwd ?? '';
    sessions.push({
      sessionId,
      status: statusFromTranscriptEntries(entries, { lastActivityAt: fileStats.mtimeMs, now }),
      statusChangedAt: fileStats.mtimeMs,
      lastEntryAt: lastEntryTimeOf(entries),
      interrupted: interruptedAtOf(entries) > 0,
      entrypoint: entrypointOfEntries(entries),
      cwd,
      transcriptPath,
      name: nameFromTranscriptEntries(entries, cwd),
      lastMessage: lastMessageFromTranscriptEntries(entries),
      ticket: ticketProgressFromEntries(entries, null),
    });
  }
  return sessions;
}
