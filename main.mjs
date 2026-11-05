import { app, BrowserWindow, screen, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { subscribeToState } from './server.mjs';

const APP_ICON_PATH = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'app-icon.png');
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

let assistantWindow = null;
let lastLight = null;

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

function placeInBottomRightCorner(window) {
  const { workArea } = screen.getPrimaryDisplay();
  window.setBounds({
    x: workArea.x + workArea.width - WINDOW_WIDTH - CORNER_MARGIN,
    y: workArea.y + workArea.height - WINDOW_HEIGHT - CORNER_MARGIN,
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
  });
}

function createAssistantWindow() {
  assistantWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    title: APP_NAME,
    alwaysOnTop: true,
    resizable: false,
    fullscreenable: false,
    visibleOnAllWorkspaces: true,
  });
  placeInBottomRightCorner(assistantWindow);

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
