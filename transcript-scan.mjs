import { open, readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { endsWithQuestion, STATUS, nameFromCwd } from './session-state.mjs';

const SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;
const QUIET_AFTER_MS = 10 * 60 * 1000;
const WRAP_UP_TOOL_NAME = 'mcp__ccd_turn__wrap_up';
const NAME_MAX_LENGTH = 80;
const LAST_MESSAGE_MAX_LENGTH = 140;
const TAIL_BYTES = 512 * 1024;

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
      cwd,
      transcriptPath,
      name: nameFromTranscriptEntries(entries, cwd),
      lastMessage: lastMessageFromTranscriptEntries(entries),
    });
  }
  return sessions;
}
