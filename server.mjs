import { watch } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acknowledgeSession,
  applyDesktopMetadata,
  applyHookEvent,
  applyTranscriptTail,
  expireFinishedSessions,
  generalLight,
  mergeSavedSessions,
  sortSessions,
  STATUS,
} from './session-state.mjs';
import { readDesktopMetadata } from './desktop-metadata.mjs';
import {
  hasPendingBackgroundAgents,
  interruptedAtOf,
  lastEntryTimeOf,
  lastMessageFromTranscriptEntries,
  parseTranscriptLines,
  readTranscriptTail,
  scanTranscripts,
  ticketProgressFromEntries,
  transcriptAsksQuestion,
} from './transcript-scan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.SESSION_ASSISTANT_PORT ?? 4317);
const projectsDir = join(homedir(), '.claude', 'projects');
const savedStatePath = join(homedir(), 'Library', 'Application Support', 'Mr Claudio Session Assistant', 'sessions.json');
const SAVE_DELAY_MS = 500;
const TRANSCRIPT_SETTLE_MS = 300;
const TICK_INTERVAL_MS = 5000;

async function readSavedState() {
  try {
    return JSON.parse(await readFile(savedStatePath, 'utf8'));
  } catch {
    return null;
  }
}

const openSessionIds = new Set(
  [...(await readDesktopMetadata()).entries()]
    .filter(([, metadata]) => !metadata.isArchived && !metadata.isSideQuestion && !metadata.isScheduledRun)
    .map(([sessionId]) => sessionId),
);
const scannedSessions = await scanTranscripts({ projectsDir, now: Date.now(), openSessionIds });
const startupSessions = mergeSavedSessions(scannedSessions, await readSavedState());
let sessionsById = new Map(startupSessions.map((session) => [session.sessionId, session]));
const transcriptSizeById = new Map();
const settleTimerById = new Map();
const streamClients = new Set();
const stateListeners = new Set();
let lastPublishedJson = '';
let publishQueue = Promise.resolve();
let saveTimer = null;

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const savedState = { savedAt: Date.now(), sessions: [...sessionsById.values()] };
    mkdir(dirname(savedStatePath), { recursive: true })
      .then(() => writeFile(savedStatePath, JSON.stringify(savedState)))
      .catch(() => {});
  }, SAVE_DELAY_MS);
}

async function currentState() {
  const metadataByTranscriptId = await readDesktopMetadata();
  const sessionsWithMetadata = applyDesktopMetadata([...sessionsById.values()], metadataByTranscriptId);
  const sessions = sortSessions(expireFinishedSessions(sessionsWithMetadata, Date.now()));
  const activeSessions = sessions.filter((session) => !session.isArchived);
  return { light: generalLight(activeSessions), sessions };
}

async function publishNow() {
  const state = await currentState();
  const stateJson = JSON.stringify(state);
  if (stateJson === lastPublishedJson) {
    return;
  }
  lastPublishedJson = stateJson;
  for (const client of streamClients) {
    client.write(`data: ${stateJson}\n\n`);
  }
  for (const listener of stateListeners) {
    listener(state);
  }
}

function publishState() {
  publishQueue = publishQueue.then(publishNow).catch(() => {});
  return publishQueue;
}

function setSessionsById(nextSessionsById) {
  if (nextSessionsById === sessionsById) {
    return;
  }
  sessionsById = nextSessionsById;
  saveSoon();
  publishState();
}

export function subscribeToState(listener) {
  stateListeners.add(listener);
  currentState().then(listener).catch(() => {});
}

async function refreshTranscriptMessage(sessionId) {
  const session = sessionsById.get(sessionId);
  if (!session || session.status === STATUS.ended || !session.transcriptPath) {
    return;
  }
  const fileStats = await stat(session.transcriptPath).catch(() => null);
  if (!fileStats || fileStats.size === transcriptSizeById.get(sessionId)) {
    return;
  }
  transcriptSizeById.set(sessionId, fileStats.size);
  const tailEntries = parseTranscriptLines(await readTranscriptTail(session.transcriptPath, fileStats.size));
  setSessionsById(
    applyTranscriptTail(sessionsById, sessionId, {
      lastMessage: lastMessageFromTranscriptEntries(tailEntries),
      lastEntryAt: lastEntryTimeOf(tailEntries),
      interruptedAt: interruptedAtOf(tailEntries),
      ticket: ticketProgressFromEntries(tailEntries, session.ticket ?? null),
    }),
  );
}

function refreshTranscriptSoon(sessionId) {
  clearTimeout(settleTimerById.get(sessionId));
  settleTimerById.set(
    sessionId,
    setTimeout(() => {
      settleTimerById.delete(sessionId);
      refreshTranscriptMessage(sessionId).catch(() => {});
    }, TRANSCRIPT_SETTLE_MS),
  );
}

async function tick() {
  for (const sessionId of sessionsById.keys()) {
    await refreshTranscriptMessage(sessionId).catch(() => {});
  }
  await publishState();
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function withTranscriptFacts(eventName, payload) {
  if (eventName !== 'Stop' || !payload.transcript_path) {
    return payload;
  }
  const rawTranscript = await readFile(payload.transcript_path, 'utf8').catch(() => '');
  const entries = parseTranscriptLines(rawTranscript);
  return {
    ...payload,
    transcript_asks_question: transcriptAsksQuestion(entries),
    transcript_has_pending_agents: hasPendingBackgroundAgents(entries),
  };
}

async function handleHookEvent(request, response) {
  const { eventName, payload: hookPayload } = JSON.parse(await readRequestBody(request));
  const payload = await withTranscriptFacts(eventName, hookPayload);
  const result = applyHookEvent(sessionsById, { eventName, payload, now: Date.now() });
  setSessionsById(result.sessionsById);
  response.writeHead(204);
  response.end();
}

async function handleState(response) {
  sendJson(response, 200, await currentState());
}

async function handleStream(request, response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  response.write(`data: ${JSON.stringify(await currentState())}\n\n`);
  streamClients.add(response);
  request.on('close', () => streamClients.delete(response));
}

async function handleAcknowledge(request, response) {
  const { sessionId } = JSON.parse(await readRequestBody(request));
  setSessionsById(acknowledgeSession(sessionsById, sessionId, Date.now()));
  response.writeHead(204);
  response.end();
}

async function handleIndexPage(response) {
  const html = await readFile(join(here, 'public', 'index.html'), 'utf8');
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'POST' && request.url === '/events') {
      await handleHookEvent(request, response);
    } else if (request.method === 'POST' && request.url === '/acknowledge') {
      await handleAcknowledge(request, response);
    } else if (request.method === 'GET' && request.url === '/api/state') {
      await handleState(response);
    } else if (request.method === 'GET' && request.url === '/api/stream') {
      await handleStream(request, response);
    } else if (request.method === 'GET' && request.url === '/') {
      await handleIndexPage(response);
    } else {
      response.writeHead(404);
      response.end();
    }
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});

watch(projectsDir, { recursive: true }, (eventType, fileName) => {
  if (fileName?.endsWith('.jsonl')) {
    refreshTranscriptSoon(basename(fileName, '.jsonl'));
  }
});

setInterval(() => tick().catch(() => {}), TICK_INTERVAL_MS);

server.listen(port, '127.0.0.1', () => {
  console.log(`session-assistant on http://127.0.0.1:${port} with ${sessionsById.size} sessions`);
});
