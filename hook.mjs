import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const payloadLogPath = join(here, 'hook-payloads.jsonl');
const serverPort = Number(process.env.SESSION_ASSISTANT_PORT ?? 4317);
const eventName = process.argv[2] ?? 'unknown';
const shouldLogPayloads = process.env.SESSION_ASSISTANT_DEBUG === '1';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const rawInput = await readStdin();
  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    payload = { unparsedInput: rawInput };
  }

  if (shouldLogPayloads) {
    mkdirSync(here, { recursive: true });
    appendFileSync(payloadLogPath, JSON.stringify({ eventName, receivedAt: new Date().toISOString(), payload }) + '\n');
  }

  try {
    await fetch(`http://127.0.0.1:${serverPort}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventName, payload }),
      signal: AbortSignal.timeout(500),
    });
  } catch {}
}

main().finally(() => process.exit(0));
