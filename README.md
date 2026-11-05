# Mr Claudio Session Assistant

A small always-on-top Electron window for macOS that shows the state of your Claude Code sessions, so you know when one needs you.

Each session gets a light:

| Light | Status | Meaning |
| --- | --- | --- |
| Orange | waiting | Claude asked a question or needs a permission |
| Yellow | finished | Claude finished a turn you haven't looked at yet |
| Green | running | Claude is working |
| Grey | ended | Nothing to do |

The window sits in the bottom-right corner and pops up (without taking focus) when a session turns orange or yellow.

## How it works

- `hook.mjs` is a Claude Code hook. It receives each hook event on stdin, appends it to `hook-payloads.jsonl`, and posts it to the local server.
- `server.mjs` runs on `http://127.0.0.1:4317`. It keeps session state in memory, serves the UI from `public/index.html`, and exposes `GET /api/state`.
- On startup, `transcript-scan.mjs` reads the last 24 hours of transcripts in `~/.claude/projects` so existing sessions show up before any hook fires.
- `desktop-metadata.mjs` reads the Claude desktop app's session files for titles and archived state.
- `session-state.mjs` holds the status rules. `main.mjs` is the Electron entry point.

## Requirements

- macOS
- Node 20+
- pnpm (`corepack enable` if it's missing)

## Install

```bash
pnpm install
pnpm test
```

If `pnpm start` fails because Electron isn't installed, pnpm skipped Electron's download script. Run it by hand:

```bash
node node_modules/electron/install.js
```

## Add the hooks

Add these entries to `~/.claude/settings.json` under `hooks`, using the absolute path of this folder. Append them next to any hooks you already have.

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /path/to/mr-claudios-assistant/hook.mjs SessionStart" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /path/to/mr-claudios-assistant/hook.mjs UserPromptSubmit" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /path/to/mr-claudios-assistant/hook.mjs Stop" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "node /path/to/mr-claudios-assistant/hook.mjs Notification" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /path/to/mr-claudios-assistant/hook.mjs SessionEnd" }] }]
  }
}
```

Restart your Claude Code sessions afterwards, because hooks load when a session starts.

## Run

```bash
pnpm start
```

Check it's up:

```bash
curl http://127.0.0.1:4317/api/state
```

To stop it:

```bash
kill $(lsof -ti tcp:4317)
```

## Launcher

`start-assistant.sh` stops any running copy and starts a fresh one in the background, logging to `/tmp/session-assistant-electron.log`. Edit the node path and folder path in it to match your machine.

To launch it from the Dock or Finder, create an Automator **Application** with one **Run Shell Script** action that calls the script, and save it wherever you like. You can paste `assets/app-icon.png` onto it in Finder's Get Info window to give it the app icon.

## Configuration

- `SESSION_ASSISTANT_PORT` changes the port that `hook.mjs` and `server.mjs` use. `main.mjs` always loads port 4317, so change it there too.

## Files not in the repo

- `hook-payloads.jsonl` holds every hook payload, including your prompts, so it's ignored.
- The Automator `.app` is machine-specific, so it's ignored too.

## Previews

`preview/` has standalone HTML pages for the mascot's states and hat options.
