// 运行在页面主世界（MAIN world），只做一件事：把 console/error 转发到内容脚本。
// 内容脚本在隔离世界，直接包 console 捕获不到页面自己的日志。
(() => {
  if (window.__abConsoleHooked) return;
  window.__abConsoleHooked = true;

  const toText = (a) => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  };
  // 页面加载早期打的日志，内容脚本还没开始听，先存着
  const backlog = [];
  const post = (level, text) => {
    const rec = { level, text: String(text).slice(0, 600) };
    backlog.push(rec);
    while (backlog.length > 200) backlog.shift();
    try { window.postMessage({ __abConsole: 1, ...rec }, '*'); } catch {}
  };
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__abNeedBacklog !== 1) return;
    try { window.postMessage({ __abBacklog: 1, items: backlog.slice() }, '*'); } catch {}
  });

  for (const lvl of ['log', 'info', 'warn', 'error']) {
    const orig = console[lvl];
    console[lvl] = function (...args) {
      try { post(lvl === 'log' ? 'info' : lvl, args.map(toText).join(' ')); } catch {}
      return orig.apply(this, args);
    };
  }
  // ── 网络：fetch / XHR ──
  const postNet = (rec) => { try { window.postMessage({ __abNet: 1, rec }, '*'); } catch {} };

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function (...args) {
      const input = args[0];
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = String((args[1] && args[1].method) || (input && input.method) || 'GET').toUpperCase();
      const t0 = performance.now();
      try {
        const res = await origFetch.apply(this, args);
        const ms = Math.round(performance.now() - t0);
        let snippet = '';
        if (!res.ok) {
          try { snippet = (await res.clone().text()).slice(0, 300); } catch {}
        }
        postNet({ url: String(url).slice(0, 300), method, status: res.status, ok: res.ok, ms, snippet });
        return res;
      } catch (e) {
        postNet({ url: String(url).slice(0, 300), method, status: 0, ok: false, ms: Math.round(performance.now() - t0), error: String((e && e.message) || e) });
        throw e;
      }
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (m, u, ...rest) {
      try { this.__abM = String(m || 'GET').toUpperCase(); this.__abU = String(u || ''); } catch {}
      return origOpen.call(this, m, u, ...rest);
    };
    XHR.prototype.send = function (...args) {
      const t0 = performance.now();
      try {
        this.addEventListener('loadend', () => {
          let snippet = '';
          try { if (this.status >= 400) snippet = String(this.responseText || '').slice(0, 300); } catch {}
          postNet({ url: String(this.__abU || '').slice(0, 300), method: this.__abM || 'GET', status: this.status, ok: this.status >= 200 && this.status < 300, ms: Math.round(performance.now() - t0), snippet });
        });
      } catch {}
      return origSend.apply(this, args);
    };
  }

  window.addEventListener('error', (e) => post('error', `${e.message} @ ${e.filename}:${e.lineno}`), true);
  window.addEventListener('unhandledrejection', (e) => post('error', `unhandled: ${e.reason?.message || e.reason}`));
})();
