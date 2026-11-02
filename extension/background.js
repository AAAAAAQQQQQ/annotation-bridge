// 点插件图标打开侧边栏
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

const HOST = 'com.gjr.annotation_bridge';
let nativePort = null;
let seq = 0;

function getPort() {
  if (nativePort) return nativePort;
  nativePort = chrome.runtime.connectNative(HOST);
  nativePort.onDisconnect.addListener(() => { nativePort = null; });
  return nativePort;
}

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
    const done = (r) => { try { port.onMessage.removeListener(onMsg); } catch {}; reply(r); };
    const timer = setTimeout(() => done({ native: false, error: 'native timeout' }), 20000);
    const onMsg = (resp) => {
      if (!resp || resp.id !== id) return;
      clearTimeout(timer);
      done(resp);
    };
    port.onMessage.addListener(onMsg);
    try { port.postMessage({ id, ...msg.req }); }
    catch (e) { clearTimeout(timer); nativePort = null; done({ native: false, error: String(e?.message || e) }); }
    return true;
  }
});
