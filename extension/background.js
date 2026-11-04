// 点插件图标打开侧边栏
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

const HOST = 'com.gjr.annotation_bridge';
const REQUEST_TIMEOUT = 15 * 60 * 1000;   // /send 可能跑很久
let nativePort = null;
let seq = 0;

/** 打开（或聚焦）标注面板；独立小窗口，像桌面 app 一样 */
async function openPanelWindow() {
  const base = chrome.runtime.getURL('sidepanel.html');
  try {
    const tabs = await chrome.tabs.query({});
    const existing = tabs.find((t) => t.url && t.url.startsWith(base));
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
      return;
    }
    await chrome.windows.create({
      url: base + '?standalone=1',
      type: 'popup', width: 440, height: 940, top: 60, left: 120, focused: true,
    });
  } catch (e) {
    console.warn('openPanelWindow failed', e);
  }
}

/**
 * 后台这个端口主要给「面板没开时，桌面 app 能唤起面板」用。
 * 面板自己会再开一个端口（sidepanel.js），所以面板开着时请求不依赖这里，
 * service worker 被回收也不会影响面板里的操作。
 */
function getPort() {
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative(HOST);
  port.onDisconnect.addListener(() => {
    if (nativePort === port) nativePort = null;
  });
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'COMMAND' && msg.command === 'OPEN_PANEL') openPanelWindow();
  });
  nativePort = port;
  return port;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'GET_ACTIVE_TAB') {
    chrome.tabs.query({}, (tabs) => {
      const pages = (tabs || []).filter((t) => t.url && /^https?:\/\//.test(t.url));
      if (!pages.length) return reply(null);
      const active = pages.filter((t) => t.active).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      const t = active[0] || pages.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
      reply({ tabId: t.id, url: t.url, title: t.title, windowId: t.windowId });
    });
    return true;
  }

  // 兼容旧调用方；正常的面板请求走 sidepanel.js 自己的端口
  if (msg?.type === 'API') {
    let port;
    try { port = getPort(); }
    catch (e) {
      nativePort = null;
      reply({ native: false, error: String(e?.message || e) });
      return true;
    }
    const id = ++seq;
    let settled = false, sent = false;
    const cleanup = () => {
      clearTimeout(timer);
      try { port.onMessage.removeListener(onMsg); } catch {}
      try { port.onDisconnect.removeListener(onDisc); } catch {}
    };
    const done = (r) => { if (settled) return; settled = true; cleanup(); reply(r); };
    const onMsg = (m) => { if (!m || m.id !== id) return; done(m); };
    const onDisc = () => {
      const err = chrome.runtime.lastError?.message || 'native host 断开';
      if (nativePort === port) nativePort = null;
      done(sent ? { native: true, status: 599, data: { error: `原生宿主中断：${err}` } } : { native: false, error: err });
    };
    const timer = setTimeout(() => done({ native: true, status: 599, data: { error: '原生宿主 15 分钟没有返回' } }), REQUEST_TIMEOUT);
    port.onMessage.addListener(onMsg);
    port.onDisconnect.addListener(onDisc);
    try { port.postMessage({ id, ...msg.req }); sent = true; }
    catch (e) { done({ native: false, error: String(e?.message || e) }); }
    return true;
  }
});

// service worker 会休眠，用 alarms 每 30 秒醒一次把端口接回来，
// 这样桌面 app 点了「打开面板」最多 30 秒内也能把扩展叫起来。
chrome.alarms.create('native-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'native-keepalive') { try { getPort(); } catch {} } });
chrome.runtime.onStartup.addListener(() => { try { getPort(); } catch {} });
chrome.runtime.onInstalled.addListener(() => { try { getPort(); } catch {} });
try { getPort(); } catch {}
