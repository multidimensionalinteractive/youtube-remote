// Optional helper: open/focus a YouTube tab if none exists.
// The content script owns the WebSocket bridge while a YouTube page is open.

async function findYouTubeTab() {
  const tabs = await chrome.tabs.query({
    url: ['*://www.youtube.com/*', '*://youtube.com/*', '*://m.youtube.com/*'],
  });
  if (!tabs.length) return null;
  return tabs.find((t) => t.active) || tabs[0];
}

chrome.action.onClicked.addListener(async () => {
  const tab = await findYouTubeTab();
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: 'https://www.youtube.com/', active: true });
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const tab = await findYouTubeTab();
  if (!tab) await chrome.tabs.create({ url: 'https://www.youtube.com/', active: false });
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.action !== 'focusYouTube' || !sender.tab) return;
  (async () => {
    await chrome.tabs.update(sender.tab.id, { active: true });
    await chrome.windows.update(sender.tab.windowId, { focused: true });
    reply({ ok: true });
  })().catch((e) => reply({ error: e.message }));
  return true;
});

// Only tabs on the exact YouTube domain or its subdomains are eligible.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.action === 'reloadExtension') {
    reply({ ok: true, reloading: true });
    setTimeout(() => chrome.runtime.reload(), 250);
    return;
  }
  if (msg.action !== 'cleanupYouTube' || !sender.tab) return;
  (async () => {
    const keep = sender.tab.id;
    const tabs = await chrome.tabs.query({});
    const remove = tabs.filter((t) => {
      if (t.id === keep || !t.url) return false;
      try {
        const h = new URL(t.url).hostname;
        return h === 'youtube.com' || h.endsWith('.youtube.com');
      } catch {
        return false;
      }
    }).map((t) => t.id);
    if (remove.length) await chrome.tabs.remove(remove);
    reply({ ok: true, kept: keep, closed: remove.length });
  })().catch((e) => reply({ error: e.message }));
  return true;
});

async function reloadYouTubeTabs() {
  const tabs = await chrome.tabs.query({
    url: ['*://www.youtube.com/*', '*://youtube.com/*', '*://m.youtube.com/*'],
  });
  for (const t of tabs) {
    try { await chrome.tabs.reload(t.id); } catch (_) {}
  }
}
chrome.runtime.onInstalled.addListener(() => { reloadYouTubeTabs(); });
