// 点插件图标打开侧边栏
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

const HOST = 'com.gjr.annotation_bridge';
const REQUEST_TIMEOUT = 15 * 60 * 1000;   // /send 可能跑十几分钟，不能 20 秒就断
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

/** 连上原生宿主；宿主没装/清单没生效时，port 会在下一拍断开。 */
function getPort() {
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative(HOST);
  port.onDisconnect.addListener(() => {
    if (nativePort === port) nativePort = null;
  });
  // 宿主推来的命令（目前只有 OPEN_PANEL）
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'COMMAND' && msg.command === 'OPEN_PANEL') openPanelWindow();
  });
  nativePort = port;
  return port;
}

// 一启动就连上宿主：桌面 app 随时能唤起面板，不用等用户先点扩展图标。
// 宿主每秒来取一次命令，这条长连接同时让 service worker 保持唤醒。
try { getPort(); } catch {}
chrome.runtime.onStartup.addListener(() => { try { getPort(); } catch {} });
chrome.runtime.onInstalled.addListener(() => { try { getPort(); } catch {} });

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'GET_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const t = tabs[0];
      reply(t ? { tabId: t.id, url: t.url, title: t.title } : null);
    });
    return true;
  }

  if (msg?.type === 'API') {
    let port;
    try { port = getPort(); }
    catch (e) {
      nativePort = null;
      reply({ native: false, error: String(e?.message || e) });   // 没装 host → 面板回退到 HTTP
      return true;
    }

    const id = ++seq;
    let settled = false, sent = false;
    const cleanup = () => {
      clearTimeout(timer);
      try { port.onMessage.removeListener(onMsg); } catch {}
      try { port.onDisconnect.removeListener(onDisc); } catch {}
    };
    // native:false 只在「宿主根本没起来」时返回，让面板回退 HTTP；
    // 请求已经发出去之后断开则报错，避免 POST /send 被 HTTP 重放两次。
    const done = (r) => { if (settled) return; settled = true; cleanup(); reply(r); };
    const onMsg = (resp) => {
      if (!resp || resp.id !== id) return;
      done(resp);
    };
    const onDisc = () => {
      const err = chrome.runtime.lastError?.message || 'native host 断开';
      if (nativePort === port) nativePort = null;
      const neverSent = !sent;
      done(neverSent ? { native: false, error: err } : { native: true, status: 599, data: { error: `原生宿主中断：${err}` } });
    };
    const timer = setTimeout(() => done({ native: true, status: 599, data: { error: '原生宿主 15 分钟没有返回' } }), REQUEST_TIMEOUT);

    port.onMessage.addListener(onMsg);
    port.onDisconnect.addListener(onDisc);
    try {
      port.postMessage({ id, ...msg.req });
      sent = true;
    } catch (e) {
      nativePort = null;
      done({ native: false, error: String(e?.message || e) });
    }
    return true;
  }
});
