import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acknowledgeSession,
  applyDesktopMetadata,
  applyHookEvent,
  applyTranscriptMessage,
  expireFinishedSessions,
  generalLight,
  sortSessions,
  STATUS,
} from './session-state.mjs';
import { readDesktopMetadata } from './desktop-metadata.mjs';
import {
  lastMessageFromTranscriptEntries,
  parseTranscriptLines,
  readTranscriptTail,
  scanTranscripts,
  transcriptAsksQuestion,
} from './transcript-scan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.SESSION_ASSISTANT_PORT ?? 4317);
const projectsDir = join(homedir(), '.claude', 'projects');

const scannedSessions = await scanTranscripts({ projectsDir, now: Date.now() });
let sessionsById = new Map(scannedSessions.map((session) => [session.sessionId, session]));
const transcriptSizeById = new Map();

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

async function withTranscriptQuestion(eventName, payload) {
  if (eventName !== 'Stop' || !payload.transcript_path) {
    return payload;
  }
  const rawTranscript = await readFile(payload.transcript_path, 'utf8').catch(() => '');
  return { ...payload, transcript_asks_question: transcriptAsksQuestion(parseTranscriptLines(rawTranscript)) };
}

async function handleHookEvent(request, response) {
  const { eventName, payload: hookPayload } = JSON.parse(await readRequestBody(request));
  const payload = await withTranscriptQuestion(eventName, hookPayload);
  const result = applyHookEvent(sessionsById, { eventName, payload, now: Date.now() });
  sessionsById = result.sessionsById;
  response.writeHead(204);
  response.end();
}

async function refreshActiveMessages() {
  for (const session of sessionsById.values()) {
    if (session.status === STATUS.ended || !session.transcriptPath) {
      continue;
    }
    const fileStats = await stat(session.transcriptPath).catch(() => null);
    if (!fileStats || fileStats.size === transcriptSizeById.get(session.sessionId)) {
      continue;
    }
    transcriptSizeById.set(session.sessionId, fileStats.size);
    const tailEntries = parseTranscriptLines(await readTranscriptTail(session.transcriptPath, fileStats.size));
    sessionsById = applyTranscriptMessage(sessionsById, session.sessionId, lastMessageFromTranscriptEntries(tailEntries));
  }
}

async function handleState(response) {
  await refreshActiveMessages();
  const metadataByTranscriptId = await readDesktopMetadata();
  const sessionsWithMetadata = applyDesktopMetadata([...sessionsById.values()], metadataByTranscriptId);
  const sessions = sortSessions(expireFinishedSessions(sessionsWithMetadata, Date.now()));
  const activeSessions = sessions.filter((session) => !session.isArchived);
  sendJson(response, 200, { light: generalLight(activeSessions), sessions });
}

async function handleAcknowledge(request, response) {
  const { sessionId } = JSON.parse(await readRequestBody(request));
  sessionsById = acknowledgeSession(sessionsById, sessionId, Date.now());
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

server.listen(port, '127.0.0.1', () => {
  console.log(`session-assistant on http://127.0.0.1:${port} with ${sessionsById.size} sessions`);
});
