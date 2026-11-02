// 运行在页面主世界（MAIN world），只做一件事：把 console/error 转发到内容脚本。
// 内容脚本在隔离世界，直接包 console 捕获不到页面自己的日志。
(() => {
  if (window.__abConsoleHooked) return;
  window.__abConsoleHooked = true;

  const toText = (a) => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  };
  const post = (level, text) => {
    try { window.postMessage({ __abConsole: 1, level, text: String(text).slice(0, 600) }, '*'); } catch {}
  };

  for (const lvl of ['log', 'info', 'warn', 'error']) {
    const orig = console[lvl];
    console[lvl] = function (...args) {
      try { post(lvl === 'log' ? 'info' : lvl, args.map(toText).join(' ')); } catch {}
      return orig.apply(this, args);
    };
  }
  window.addEventListener('error', (e) => post('error', `${e.message} @ ${e.filename}:${e.lineno}`), true);
  window.addEventListener('unhandledrejection', (e) => post('error', `unhandled: ${e.reason?.message || e.reason}`));
})();
