// background.js — MV3 background service worker
//
// Responsibilities:
//   1. On the toolbar action click, open the side panel and (if the active tab
//      is YouTube) start capturing its audio.
//   2. Ensure an offscreen document exists, capture the active YouTube tab's
//      audio via chrome.tabCapture, and hand the MediaStream id to offscreen.js.
//   3. Track connected side panel ports and broadcast ASR_STATUS / ASR_TEXT /
//      ASR_ERROR events (received from offscreen.js) to all of them.
//   4. Keep the last 100 messages in memory so a freshly (re)opened side panel
//      can show recent history.
//
// IMPORTANT — why we do NOT use chrome.sidePanel.setPanelBehavior():
// chrome.tabCapture.getMediaStreamId({ targetTabId }) only works on a tab that
// currently has the "activeTab" permission granted. Per Chrome's docs, activeTab
// is granted ONLY by a direct user gesture recognized by the extension system —
// clicking the action, a context menu item, a keyboard shortcut, or an omnibox
// suggestion. Opening the side panel via setPanelBehavior({ openPanelOnActionClick })
// consumes the click internally and chrome.action.onClicked never fires, so
// activeTab is never granted and tabCapture fails with:
//   "Extension has not been invoked for the current page (see activeTab permission)."
// So instead we open the side panel manually (chrome.sidePanel.open()) AND start
// capture, both directly inside chrome.action.onClicked, so the real click is what
// grants activeTab for the target tab.

const OFFSCREEN_DOCUMENT_PATH = 'offscreen/offscreen.html';
const MAX_HISTORY = 100;

/** @type {Array<object>} */
let history = [];
/** @type {Set<chrome.runtime.Port>} */
const sidepanelPorts = new Set();

let capturingTabId = null;
let creatingOffscreenPromise = null;

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;

  await openSidePanelForTab(tab);

  if (!isYouTubeUrl(tab.url)) {
    broadcast({
      type: 'ASR_STATUS',
      status: 'error',
      message: 'Please open a YouTube tab and try again.',
    });
    return;
  }

  await startCaptureForTab(tab);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;

  sidepanelPorts.add(port);

  port.onMessage.addListener((message) => {
    if (message?.type === 'GET_HISTORY') {
      port.postMessage({ type: 'HISTORY', history });
    }
  });

  port.onDisconnect.addListener(() => {
    sidepanelPorts.delete(port);
  });
});

// Messages sent from offscreen.js via chrome.runtime.sendMessage().
chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.type !== 'string') return;

  if (
    message.type === 'ASR_STATUS' ||
    message.type === 'ASR_TEXT' ||
    message.type === 'ASR_ERROR'
  ) {
    broadcast(message);
  }
});

async function startCaptureForTab(tab) {
  if (capturingTabId === tab.id) return; // already capturing this tab

  broadcast({
    type: 'ASR_STATUS',
    status: 'starting',
    message: 'Starting YouTube audio capture...',
  });

  try {
    await ensureOffscreenDocument();

    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    capturingTabId = tab.id;

    await chrome.runtime.sendMessage({
      type: 'START_TAB_AUDIO_ASR',
      streamId,
      tabId: tab.id,
    });
  } catch (err) {
    capturingTabId = null;
    broadcast({ type: 'ASR_ERROR', message: err?.message || String(err) });
  }
}

async function openSidePanelForTab(tab) {
  try {
    if (tab.id != null) {
      await chrome.sidePanel.open({ tabId: tab.id });
      return;
    }
  } catch (err) {
    // Fall back to windowId below.
  }
  try {
    if (tab.windowId != null) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (err) {
    console.warn('[background] Unable to open side panel', err);
  }
}

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
    });
    return contexts.length > 0;
  }
  // Fallback for older Chrome versions without getContexts().
  return chrome.offscreen.hasDocument();
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;

  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }

  creatingOffscreenPromise = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Capture YouTube tab audio and analyze it for realtime ASR.',
  });

  try {
    await creatingOffscreenPromise;
  } finally {
    creatingOffscreenPromise = null;
  }
}

function isYouTubeUrl(url) {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    return hostname === 'youtube.com' || hostname.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

function broadcast(message) {
  const entry = { ...message, receivedAt: Date.now() };

  history.push(entry);
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }

  for (const port of sidepanelPorts) {
    try {
      port.postMessage(entry);
    } catch (err) {
      // Port likely disconnected; it will be cleaned up by onDisconnect.
    }
  }
}
