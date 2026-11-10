import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { subscribeToState } from './server.mjs';
import { cornerBounds, CORNERS, DEFAULT_CORNER, nearestCorner } from './window-corner.mjs';

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ICON_PATH = join(APP_DIR, 'assets', 'app-icon.png');
const PRELOAD_PATH = join(APP_DIR, 'preload.cjs');
const APP_NAME = "Mr Claudio's Assistant";

app.setName(APP_NAME);

const ASSISTANT_URL = 'http://127.0.0.1:4317/';
const STATE_URL = `${ASSISTANT_URL}api/state`;
const WINDOW_WIDTH = 360;
const WINDOW_HEIGHT = 460;
const CORNER_MARGIN = 16;
const SERVER_RETRY_INTERVAL_MS = 250;
const SERVER_RETRY_LIMIT = 40;
const ATTENTION_LIGHTS = new Set(['yellow', 'orange']);
const DRAG_FRAME_MS = 16;
const PLACEMENT_PATH = join(homedir(), 'Library', 'Application Support', 'Mr Claudio Session Assistant', 'window.json');

let assistantWindow = null;
let lastLight = null;
let placement = loadPlacement();
let dragTimer = null;

function loadPlacement() {
  try {
    const saved = JSON.parse(readFileSync(PLACEMENT_PATH, 'utf8'));
    return { corner: CORNERS.includes(saved.corner) ? saved.corner : DEFAULT_CORNER, displayId: saved.displayId ?? null };
  } catch {
    return { corner: DEFAULT_CORNER, displayId: null };
  }
}

function savePlacement() {
  mkdirSync(dirname(PLACEMENT_PATH), { recursive: true });
  writeFileSync(PLACEMENT_PATH, JSON.stringify(placement));
}

async function waitForServer() {
  for (let attempt = 0; attempt < SERVER_RETRY_LIMIT; attempt += 1) {
    try {
      await fetch(STATE_URL);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, SERVER_RETRY_INTERVAL_MS));
    }
  }
}

function placeInCorner(animate = false) {
  const display =
    screen.getAllDisplays().find((candidate) => candidate.id === placement.displayId) ?? screen.getPrimaryDisplay();
  const size = { width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
  assistantWindow.setBounds(cornerBounds(placement.corner, display.workArea, size, CORNER_MARGIN), animate);
}

function startDrag() {
  clearInterval(dragTimer);
  const cursor = screen.getCursorScreenPoint();
  const [windowX, windowY] = assistantWindow.getPosition();
  const offset = { x: cursor.x - windowX, y: cursor.y - windowY };
  dragTimer = setInterval(() => {
    const point = screen.getCursorScreenPoint();
    assistantWindow.setPosition(point.x - offset.x, point.y - offset.y);
  }, DRAG_FRAME_MS);
}

function endDrag() {
  if (dragTimer === null) {
    return;
  }
  clearInterval(dragTimer);
  dragTimer = null;
  const bounds = assistantWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  placement = { corner: nearestCorner(bounds, display.workArea), displayId: display.id };
  savePlacement();
  placeInCorner(true);
}

function createAssistantWindow() {
  assistantWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    title: APP_NAME,
    titleBarStyle: 'customButtonsOnHover',
    alwaysOnTop: true,
    resizable: false,
    fullscreenable: false,
    visibleOnAllWorkspaces: true,
    acceptFirstMouse: true,
    webPreferences: { preload: PRELOAD_PATH },
  });
  placeInCorner();
  ipcMain.on('drag-start', startDrag);
  ipcMain.on('drag-end', endDrag);
  assistantWindow.on('blur', endDrag);
  screen.on('display-removed', () => placeInCorner());
  screen.on('display-metrics-changed', () => placeInCorner());

  assistantWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  assistantWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(ASSISTANT_URL)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  assistantWindow.loadURL(ASSISTANT_URL);
}

function showOnAttention({ light }) {
  if (light !== lastLight && ATTENTION_LIGHTS.has(light)) {
    assistantWindow.showInactive();
  }
  lastLight = light;
}

app.whenReady().then(async () => {
  app.dock?.setIcon(APP_ICON_PATH);
  await waitForServer();
  createAssistantWindow();
  assistantWindow.showInactive();
  subscribeToState(showOnAttention);
});

app.on('window-all-closed', () => {
  app.quit();
});
