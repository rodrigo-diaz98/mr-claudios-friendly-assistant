import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APPLICATION_SUPPORT_DIR = join(homedir(), 'Library', 'Application Support');
const DESKTOP_METADATA_ROOTS = [
  join(APPLICATION_SUPPORT_DIR, 'Claude-3p', 'claude-code-sessions'),
  join(APPLICATION_SUPPORT_DIR, 'Claude', 'claude-code-sessions'),
];
const LOCAL_SESSION_FILE_PATTERN = /^local_.*\.json$/;

async function readSessionMetadataFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function readMetadataRoot(metadataRoot, metadataByTranscriptId) {
  for (const accountName of await readdir(metadataRoot).catch(() => [])) {
    const accountPath = join(metadataRoot, accountName);
    for (const organizationName of await readdir(accountPath).catch(() => [])) {
      const organizationPath = join(accountPath, organizationName);
      for (const fileName of await readdir(organizationPath).catch(() => [])) {
        if (!LOCAL_SESSION_FILE_PATTERN.test(fileName)) {
          continue;
        }
        const metadata = await readSessionMetadataFile(join(organizationPath, fileName));
        if (!metadata?.cliSessionId) {
          continue;
        }
        metadataByTranscriptId.set(metadata.cliSessionId, {
          title: metadata.title ?? '',
          isArchived: metadata.isArchived === true,
          lastFocusedAt: metadata.lastFocusedAt ?? 0,
          lastTurnEdgeAt: metadata.lastTurnEdgeAt ?? 0,
          pullRequests: (metadata.prs ?? []).map((pullRequest) => ({
            number: pullRequest.prNumber,
            url: pullRequest.url,
            state: pullRequest.state,
            autoFix: pullRequest.autoFix === true,
          })),
        });
      }
    }
  }
}

export async function readDesktopMetadata(metadataRoots = DESKTOP_METADATA_ROOTS) {
  const metadataByTranscriptId = new Map();
  for (const metadataRoot of metadataRoots) {
    await readMetadataRoot(metadataRoot, metadataByTranscriptId);
  }
  return metadataByTranscriptId;
}
