# Mr Claudio's Assistant

A small always-on-top Electron window for macOS that shows the state of your Claude Code sessions, so you know when one needs you.

Each session gets a light:

| Light | Status | Meaning |
| --- | --- | --- |
| Red | waiting | Claude has been waiting for you for more than 10 minutes |
| Orange | waiting | Claude asked a question or needs a permission |
| Yellow | finished | Claude finished a turn you haven't looked at yet (for up to 5 minutes) |
| Green | running | Claude is working |
| Grey | ended | Nothing to do |

A waiting session shows how long it has waited and, for a permission prompt, what Claude needs, like "Claude needs your permission to use Bash". Other sessions show Claude's latest message, updated while it works. Right after you send a prompt, it shows "You: …" with your prompt until Claude writes its first reply. A session stays green while background agents it launched are still working. A session you interrupt turns grey and says "Stopped by you" until you send a new prompt. Compacting or reopening a session keeps its light as it was. A new session only shows up once you send its first prompt, so a draft you never send never appears.

The header shows one Claudio for each session behind the overall light, up to 5, so two sessions waiting on you show two orange Claudios. The header card glows in the overall light's color, and colored chips under the title count your sessions by status, like "1 needs you" and "2 running", or say "All quiet". Sessions that need you (waiting or finished) get a colored edge on their card. Cards fade in when a session appears, fade out when it's archived or goes away, and slide into place when a session moves to another status group. Archived sessions are hidden until you click "Show archived" at the bottom. A session counts as archived if any of the desktop app's session files says so. `/btw` side questions are always hidden, because they show inside the session you asked them from.

While a session started with `claude` in a terminal is active, Desktop and Terminal tabs appear above the list. A session goes under the tab of the app it was last used from.

The window sits in a corner of the screen and pops up (without taking focus) when a session turns orange or yellow. It has no title bar: drag it by the header card, and hover the top-left corner to show the close and minimize buttons. When you let go, it snaps to the nearest corner of that display, and it opens there next time (saved in `window.json`, next to `sessions.json`). The chevron button on the header collapses the window down to just the header, staying in its corner; click it again to expand. The window remembers whether it was collapsed.

## Ticket board

A session started with `/zero-to-shipped` shows as a ticket: its key, five stage bars and its pull requests.

| Stage | Starts when the session |
| --- | --- |
| Design | runs `/zero-to-shipped` (setup, ticket, `grill-me`, brainstorming, writing plans or plan mode) |
| Build | runs `superpowers:executing-plans` or `superpowers:subagent-driven-development`, or edits code outside the design skills and plan mode |
| Review | runs `simplify`, `look-for-bugs` or `code-review` |
| Ship | runs `open-nice-pr` or `ship-it` |
| Feedback | runs `review-pr-comments`, gets its first Auto-fix event, or has a pull request |

- The skill names for each stage live in `stage-skills.mjs`. On a machine with other skills, add their names to the right stage there and change nothing else. Keep the five stage keys, since the window shows those five bars.
- Stages only move forward. Finished stages are dark green, and the current one takes the session's light color.
- The ticket key comes from the git branch (`dev/abc-123-search` becomes `ABC-123`), falling back to the `/zero-to-shipped` arguments, `initialize-worktree` or `getJiraIssue`.
- PR numbers and the Auto-fix tag come from the Claude desktop app's session file. Once a ticket has a pull request, Ship is done and Feedback is current, with or without Auto-fix. When every PR is merged, all bars fill and the ticket shows "Merged".

## How it works

- `hook.mjs` is a Claude Code hook. It receives each hook event on stdin and posts it to the local server.
- `server.mjs` runs on `http://127.0.0.1:4317`. It keeps session state, serves the UI from `public/index.html`, exposes `GET /api/state`, and pushes every change to the window over `GET /api/stream`.
- The server watches `~/.claude/projects` and updates a session's preview as soon as its transcript changes.
- State is saved to `~/Library/Application Support/Mr Claudio Session Assistant/sessions.json`. After a restart, a saved session is kept unless its transcript got a newer message while the app was down.
- On startup, `transcript-scan.mjs` reads the transcripts in `~/.claude/projects` so sessions show up before any hook fires. It reads every session the Claude desktop app still lists (not archived, not a scheduled run), plus any other transcript from the last 24 hours.
- `desktop-metadata.mjs` reads the Claude desktop app's session files for titles, archived state and pull requests.
- `transcript-scan.mjs` also works out ticket progress and pending background agents from the transcript.
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

Electron downloads its binary the first time you run `pnpm start`.

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
- `SESSION_ASSISTANT_DEBUG=1` makes `hook.mjs` append every hook payload to `hook-payloads.jsonl`. It's off by default because the payloads include your prompts. Set it in the `env` block of `~/.claude/settings.json` to turn it on.

## Files not in the repo

- `hook-payloads.jsonl`, the debug log, is ignored because it holds your prompts.
- The Automator `.app` is machine-specific, so it's ignored too.

## Previews

`preview/` has standalone HTML pages for the mascot's states and hat options.
