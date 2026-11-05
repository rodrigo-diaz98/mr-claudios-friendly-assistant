import { open, readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { endsWithQuestion, STATUS, nameFromCwd } from './session-state.mjs';

const SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;
const QUIET_AFTER_MS = 10 * 60 * 1000;
const WRAP_UP_TOOL_NAME = 'mcp__ccd_turn__wrap_up';
const NAME_MAX_LENGTH = 80;
const LAST_MESSAGE_MAX_LENGTH = 140;
const TAIL_BYTES = 512 * 1024;
const TASK_NOTIFICATION_ID_PATTERN = /<task-notification>[\s\S]*?<task-id>([^<]+)<\/task-id>/;
const INTERIM_REPORT_PATTERN = /<summary>[^<]*waiting on its own background work<\/summary>/;
const TICKET_STAGES = ['design', 'build', 'test', 'ship', 'feedback'];
const STAGE_BY_SKILL = new Map([
  ['superpowers:executing-plans', 'build'],
  ['superpowers:subagent-driven-development', 'build'],
  ['taking-evidence', 'test'],
  ['ship-it', 'ship'],
  ['review-pr-comments', 'feedback'],
]);
const DESIGN_SKILLS = new Set(['superpowers:brainstorming', 'superpowers:writing-plans']);
const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const COMMAND_NAME_PATTERN = /<command-name>\/?([^<]+)<\/command-name>/;
const TICKET_KEY_IN_BRANCH_PATTERN = /(?:^|\/)([a-z]{2,10}-\d+)(?=-|$)/i;
const TICKET_KEY_IN_TEXT_PATTERN = /\b([A-Z]{2,10}-\d+)\b/;

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

export function hasPendingBackgroundAgents(entries) {
  const pendingAgentIds = new Set();
  for (const entry of entries) {
    if (entry.toolUseResult?.status === 'async_launched' && entry.toolUseResult.agentId) {
      pendingAgentIds.add(entry.toolUseResult.agentId);
    }
    const notificationText = notificationTextOf(entry);
    const notifiedAgentId = typeof notificationText === 'string' ? notificationText.match(TASK_NOTIFICATION_ID_PATTERN)?.[1] : null;
    if (notifiedAgentId && INTERIM_REPORT_PATTERN.test(notificationText)) {
      pendingAgentIds.add(notifiedAgentId);
    } else if (notifiedAgentId) {
      pendingAgentIds.delete(notifiedAgentId);
    }
  }
  return pendingAgentIds.size > 0;
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
      if (skillNames.includes('zero-to-shipped')) {
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
      if (DESIGN_SKILLS.has(skillName)) {
        progress = { ...progress, designMode: 'superpowers' };
      } else if (STAGE_BY_SKILL.has(skillName)) {
        progress = advanceStage(progress, STAGE_BY_SKILL.get(skillName), at);
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

export function lastEntryTimeOf(entries) {
  const timestamp = lastMessageEntryOf(entries)?.timestamp;
  return timestamp ? Date.parse(timestamp) : 0;
}

function entriesSincePrompt(entries) {
  const lastPromptIndex = entries.findLastIndex(
    (entry) => entry.type === 'user' && typeof entry.message?.content === 'string',
  );
  return entries.slice(lastPromptIndex + 1);
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

export function statusFromTranscriptEntries(entries, { lastActivityAt, now }) {
  const lastMessageEntry = lastMessageEntryOf(entries);
  if (!lastMessageEntry) {
    return STATUS.ended;
  }
  if (hasPendingBackgroundAgents(entries) && now - lastActivityAt <= QUIET_AFTER_MS) {
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

export function lastMessageFromTranscriptEntries(entries) {
  const lastAssistantEntry = lastAssistantEntryWithText(entries);
  return lastAssistantEntry ? singleLine(textFromAssistantEntry(lastAssistantEntry)) : '';
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

export async function scanTranscripts({ projectsDir, now }) {
  const transcriptPaths = await listTranscriptFiles(projectsDir);
  const sessions = [];
  for (const transcriptPath of transcriptPaths) {
    const fileStats = await stat(transcriptPath);
    if (now - fileStats.mtimeMs > SCAN_WINDOW_MS) {
      continue;
    }
    const entries = parseTranscriptLines(await readFile(transcriptPath, 'utf8'));
    const cwd = entries.find((entry) => entry.cwd)?.cwd ?? '';
    sessions.push({
      sessionId: basename(transcriptPath, '.jsonl'),
      status: statusFromTranscriptEntries(entries, { lastActivityAt: fileStats.mtimeMs, now }),
      statusChangedAt: fileStats.mtimeMs,
      lastEntryAt: lastEntryTimeOf(entries),
      cwd,
      transcriptPath,
      name: nameFromTranscriptEntries(entries, cwd),
      lastMessage: lastMessageFromTranscriptEntries(entries),
      ticket: ticketProgressFromEntries(entries, null),
    });
  }
  return sessions;
}
