// 点插件图标就打开侧边栏
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

// 侧边栏请求当前标签页时，把 tabId 给它
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'GET_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const t = tabs[0];
      reply(t ? { tabId: t.id, url: t.url, title: t.title } : null);
    });
    return true;
  }
});
