import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APPLICATION_SUPPORT_DIR = join(homedir(), 'Library', 'Application Support');
const DESKTOP_METADATA_ROOTS = [
  join(APPLICATION_SUPPORT_DIR, 'Claude-3p', 'claude-code-sessions'),
  join(APPLICATION_SUPPORT_DIR, 'Claude', 'claude-code-sessions'),
];
const LOCAL_SESSION_FILE_PATTERN = /^local_.*\.json$/;

const metadataCacheByPath = new Map();

function metadataFieldsOf(metadata) {
  if (!metadata?.cliSessionId) {
    return null;
  }
  return {
    transcriptId: metadata.cliSessionId,
    title: metadata.title ?? '',
    isArchived: metadata.isArchived === true,
    isSideQuestion: metadata.spawnedFrom?.btw === true,
    isScheduledRun: Boolean(metadata.scheduledTaskId),
    lastFocusedAt: metadata.lastFocusedAt ?? 0,
    lastTurnEdgeAt: metadata.lastTurnEdgeAt ?? 0,
    pullRequests: (metadata.prs ?? []).map((pullRequest) => ({
      number: pullRequest.prNumber,
      url: pullRequest.url,
      state: pullRequest.state,
      autoFix: pullRequest.autoFix === true,
    })),
  };
}

async function readSessionMetadataFile(filePath) {
  const fileStats = await stat(filePath).catch(() => null);
  const cached = metadataCacheByPath.get(filePath);
  if (cached && fileStats && cached.mtimeMs === fileStats.mtimeMs && cached.size === fileStats.size) {
    return cached.fields;
  }
  const fields = metadataFieldsOf(JSON.parse(await readFile(filePath, 'utf8').catch(() => 'null')));
  if (fileStats) {
    metadataCacheByPath.set(filePath, { mtimeMs: fileStats.mtimeMs, size: fileStats.size, fields });
  }
  return fields;
}

async function sessionFilePathsOf(metadataRoot) {
  const filePaths = [];
  for (const accountName of await readdir(metadataRoot).catch(() => [])) {
    const accountPath = join(metadataRoot, accountName);
    for (const organizationName of await readdir(accountPath).catch(() => [])) {
      const organizationPath = join(accountPath, organizationName);
      for (const fileName of await readdir(organizationPath).catch(() => [])) {
        if (LOCAL_SESSION_FILE_PATTERN.test(fileName)) {
          filePaths.push(join(organizationPath, fileName));
        }
      }
    }
  }
  return filePaths;
}

export async function readDesktopMetadata(metadataRoots = DESKTOP_METADATA_ROOTS) {
  const filePaths = (await Promise.all(metadataRoots.map(sessionFilePathsOf))).flat();
  const fieldsList = await Promise.all(filePaths.map(readSessionMetadataFile));
  for (const cachedPath of metadataCacheByPath.keys()) {
    if (!filePaths.includes(cachedPath)) {
      metadataCacheByPath.delete(cachedPath);
    }
  }
  const metadataByTranscriptId = new Map();
  for (const fields of fieldsList.filter(Boolean)) {
    const { transcriptId, ...metadata } = fields;
    const isArchived = metadata.isArchived || metadataByTranscriptId.get(transcriptId)?.isArchived === true;
    metadataByTranscriptId.set(transcriptId, { ...metadata, isArchived });
  }
  return metadataByTranscriptId;
}
