(function () {
  if (window.__ytRemoteContentLoaded) return;
  window.__ytRemoteContentLoaded = true;

  // Default matches server port 8790. If you change YT_REMOTE_PORT, update this URL and extension/manifest.json host_permissions.
  const BRIDGE_URL = 'ws://127.0.0.1:8790/?role=bridge';
  let socket = null;
  let reconnectTimer = null;
  let statusTimer = null;

  function videoEl() {
    return document.querySelector('video');
  }

  function player() {
    return document.getElementById('movie_player') || document.querySelector('.html5-video-player');
  }

  function getVideoId() {
    try {
      const u = new URL(location.href);
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const shorts = u.pathname.match(/\/shorts\/([^/?]+)/);
      if (shorts) return shorts[1];
    } catch (_) {}
    return null;
  }

  function getTitle() {
    const t = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.title, h1');
    if (t && t.textContent) return t.textContent.trim();
    const raw = document.title || '';
    return raw.replace(/ - YouTube$/i, '').trim();
  }

  function getChannel() {
    const a = document.querySelector('#channel-name a, ytd-channel-name a, #owner #text a');
    return a && a.textContent ? a.textContent.trim() : '';
  }

  function getStatus() {
    const v = videoEl();
    const p = player();
    let paused = true;
    let currentTime = 0;
    let duration = 0;
    let volume = 1;
    let muted = false;
    if (v) {
      paused = !!v.paused;
      currentTime = v.currentTime || 0;
      duration = v.duration && isFinite(v.duration) ? v.duration : 0;
      volume = typeof v.volume === 'number' ? v.volume : 1;
      muted = !!v.muted;
    }
    if (p && typeof p.getPlayerState === 'function') {
      const st = p.getPlayerState();
      if (st === 1) paused = false;
      if (st === 2) paused = true;
    }
    if (p && typeof p.getCurrentTime === 'function') {
      try { currentTime = p.getCurrentTime() || currentTime; } catch (_) {}
    }
    if (p && typeof p.getDuration === 'function') {
      try {
        const d = p.getDuration();
        if (d && isFinite(d)) duration = d;
      } catch (_) {}
    }
    if (p && typeof p.getVolume === 'function') {
      try { volume = (p.getVolume() || 0) / 100; } catch (_) {}
    }
    if (p && typeof p.isMuted === 'function') {
      try { muted = !!p.isMuted(); } catch (_) {}
    }
    ensureBassGraph();
    return {
      title: getTitle(),
      channel: getChannel(),
      videoId: getVideoId(),
      url: location.href,
      paused,
      currentTime,
      duration,
      volume,
      muted,
      bass: bassState.amount,
      bassDb: amountToDb(bassState.amount),
      bassError: bassState.error,
    };
  }

  function clamp01(n) {
    n = Number(n);
    if (!isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }


  const BASS_KEY = 'ytRemoteBassAmount';
  const bassState = {
    amount: 0,
    ctx: null,
    filter: null,
    source: null,
    attachedVideo: null,
    error: null,
    sources: (window.__ytRemoteBassSources = window.__ytRemoteBassSources || new WeakMap()),
  };
  try {
    const saved = sessionStorage.getItem(BASS_KEY);
    if (saved != null && saved !== '') {
      const n = Number(saved);
      if (isFinite(n)) bassState.amount = Math.max(0, Math.min(1, n));
    }
  } catch (_) {}

  function amountToDb(amount) {
    return -30 * clamp01(amount);
  }

  function ensureBassGraph() {
    const v = videoEl();
    if (!v) return false;
    try {
      if (!bassState.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        bassState.ctx = new AC();
        bassState.filter = bassState.ctx.createBiquadFilter();
        bassState.filter.type = 'lowshelf';
        bassState.filter.frequency.value = 200;
        bassState.filter.Q.value = 0.7;
        bassState.filter.gain.value = amountToDb(bassState.amount);
        bassState.filter.connect(bassState.ctx.destination);
      }
      if (bassState.attachedVideo === v && bassState.source) {
        bassState.filter.gain.value = amountToDb(bassState.amount);
        return true;
      }
      let source = bassState.sources.get(v);
      if (!source) {
        source = bassState.ctx.createMediaElementSource(v);
        bassState.sources.set(v, source);
      }
      try { if (bassState.source && bassState.source !== source) bassState.source.disconnect(); } catch (_) {}
      source.connect(bassState.filter);
      bassState.source = source;
      bassState.attachedVideo = v;
      bassState.filter.gain.value = amountToDb(bassState.amount);
      bassState.error = null;
      return true;
    } catch (e) {
      bassState.error = e && e.message ? e.message : String(e);
      return false;
    }
  }

  async function resumeBassContext() {
    ensureBassGraph();
    if (bassState.ctx && bassState.ctx.state === 'suspended') {
      try { await bassState.ctx.resume(); } catch (_) {}
    }
  }

  function setBass(amount) {
    bassState.amount = clamp01(amount);
    try { sessionStorage.setItem(BASS_KEY, String(bassState.amount)); } catch (_) {}
    ensureBassGraph();
    if (bassState.filter) bassState.filter.gain.value = amountToDb(bassState.amount);
    return resumeBassContext();
  }

  setInterval(() => { try { ensureBassGraph(); } catch (_) {} }, 2000);

  function setVolume(vol) {
    vol = clamp01(vol);
    const v = videoEl();
    const p = player();
    if (p && typeof p.setVolume === 'function') p.setVolume(Math.round(vol * 100));
    if (v) {
      v.volume = vol;
      if (vol > 0 && v.muted) v.muted = false;
    }
  }

  function seekTo(seconds) {
    seconds = Math.max(0, Number(seconds) || 0);
    const v = videoEl();
    const p = player();
    if (p && typeof p.seekTo === 'function') {
      p.seekTo(seconds, true);
      return;
    }
    if (v) v.currentTime = seconds;
  }

  async function handle(msg) {
    const action = msg.action;
    const v = videoEl();
    const p = player();

    if (['load','play','togglePlay','showYouTube'].includes(action)) {
      await chrome.runtime.sendMessage({ action: 'focusYouTube' });
    }
    if (['load','play','togglePlay'].includes(action)) {
      const cleanup = await chrome.runtime.sendMessage({action:'cleanupYouTube'});
      if (cleanup && cleanup.error) throw new Error(cleanup.error);
    }
    switch (action) {
      case 'reloadExtension':
        return await chrome.runtime.sendMessage({action:'reloadExtension'});
      case 'cleanupYouTube':
        return await chrome.runtime.sendMessage({action:'cleanupYouTube'});

      case 'showYouTube': return getStatus();
      case 'status':
        return getStatus();
      case 'togglePlay': {
        if (p && typeof p.getPlayerState === 'function') {
          const st = p.getPlayerState();
          if (st === 1 && typeof p.pauseVideo === 'function') p.pauseVideo();
          else if (typeof p.playVideo === 'function') p.playVideo();
        } else if (v) {
          if (v.paused) await v.play();
          else v.pause();
        }
        await resumeBassContext();
        return getStatus();
      }
      case 'play': {
        if (p && typeof p.playVideo === 'function') p.playVideo();
        else if (v) await v.play();
        await resumeBassContext();
        return getStatus();
      }
      case 'setBass': {
        await setBass(msg.amount);
        return getStatus();
      }
      case 'bassBy': {
        await setBass((bassState.amount || 0) + (Number(msg.delta) || 0));
        return getStatus();
      }
      case 'pause': {
        if (p && typeof p.pauseVideo === 'function') p.pauseVideo();
        else if (v) v.pause();
        return getStatus();
      }
      case 'seekBy': {
        const delta = Number(msg.seconds) || 0;
        const st = getStatus();
        seekTo((st.currentTime || 0) + delta);
        return getStatus();
      }
      case 'seekTo': {
        seekTo(msg.seconds);
        return getStatus();
      }
      case 'setVolume': {
        setVolume(msg.volume);
        return getStatus();
      }
      case 'volumeBy': {
        const st = getStatus();
        setVolume((st.volume || 0) + (Number(msg.delta) || 0));
        return getStatus();
      }
      case 'toggleMute': {
        if (p && typeof p.isMuted === 'function') {
          if (p.isMuted()) p.unMute();
          else p.mute();
        } else if (v) {
          v.muted = !v.muted;
        }
        return getStatus();
      }
      case 'mute': {
        if (p && typeof p.mute === 'function') p.mute();
        else if (v) v.muted = true;
        return getStatus();
      }
      case 'unmute': {
        if (p && typeof p.unMute === 'function') p.unMute();
        else if (v) v.muted = false;
        return getStatus();
      }
      case 'next': {
        if (p && typeof p.nextVideo === 'function') p.nextVideo();
        else {
          const btn = document.querySelector('.ytp-next-button, .ytp-next-button.ytp-button');
          if (btn) btn.click();
        }
        return getStatus();
      }
      case 'load': {
        const url = msg.url || (msg.videoId ? ('https://www.youtube.com/watch?v=' + msg.videoId) : null);
        if (!url) throw new Error('url required');
        if (location.href !== url) location.href = url;
        return { ok: true, loading: url };
      }
      default:
        throw new Error('Unknown action: ' + action);
    }
  }

  function reply(id, result, error) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (error) socket.send(JSON.stringify({ id, error: String(error) }));
    else socket.send(JSON.stringify({ id, result }));
  }

  function pushStatus() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: 'status', status: getStatus() }));
    } catch (_) {}
  }

  function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    try {
      socket = new WebSocket(BRIDGE_URL);
    } catch (_) {
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (statusTimer) clearInterval(statusTimer);
      statusTimer = setInterval(pushStatus, 1500);
      pushStatus();
    };

    socket.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id == null || !msg.action) return;
      try {
        const result = await handle(msg);
        if (result && (result.title !== undefined || result.currentTime !== undefined || result.paused !== undefined)) {
          reply(msg.id, { status: result });
        } else {
          reply(msg.id, { ...(result || { ok: true }), status: getStatus() });
        }
      } catch (e) {
        reply(msg.id, null, e.message || String(e));
      }
    };

    socket.onclose = () => {
      if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
      scheduleReconnect();
    };

    socket.onerror = () => {
      try { socket.close(); } catch (_) {}
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1500);
  }

  // Also respond to extension messaging (background helper).
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      Promise.resolve()
        .then(() => handle(msg || {}))
        .then((result) => sendResponse(result))
        .catch((e) => sendResponse({ error: e.message || String(e) }));
      return true;
    });
  }

  connect();
})();
