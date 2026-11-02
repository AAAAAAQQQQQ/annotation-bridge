// 元素拾取 + 控制台捕获
(() => {
  if (window.__annotationBridgeLoaded) return;
  window.__annotationBridgeLoaded = true;

  const MAX_LOGS = 200;
  const logs = [];
  const net = [];
  const push = (level, text) => {
    logs.push({ level, text: String(text).slice(0, 600), ts: Date.now() });
    if (logs.length > MAX_LOGS) logs.shift();
  };

  // 控制台：由主世界的 inject-console.js 通过 postMessage 送过来
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__abConsole === 1) push(e.data.level, e.data.text);
    if (e.data.__abNet === 1 && e.data.rec) {
      net.push(e.data.rec);
      while (net.length > 100) net.shift();
    }
  });

  // 拾取
  let picking = false;
  let hoverEl = null;
  let picked = [];          // 已选元素（多选）
  let marks = [];           // 屏幕上的编号标记

  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #1f6feb;background:rgba(31,111,235,.12);border-radius:4px;display:none';
  const tip = document.createElement('div');
  tip.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:#1f6feb;color:#fff;font:12px/1.5 -apple-system,PingFang SC,sans-serif;padding:3px 8px;border-radius:4px;max-width:520px;display:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;background:#111827;color:#fff;font:13px/1.6 -apple-system,PingFang SC,sans-serif;padding:8px 16px;border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.3);display:none';
  banner.textContent = '拾取模式：点击元素可多选（再点取消），Enter 完成 · Esc 退出';

  const mount = () => { if (!box.isConnected) document.documentElement.append(box, tip, banner); };
  const unmount = () => [box, tip, banner].forEach((n) => n.remove());

  const NOISE = /^(active|hover|focus|focused|selected|open|show|visible|disabled|is-.*|js-.*)$/i;
  const esc = (s) => (window.CSS?.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));

  function cssPath(el, maxDepth = 6) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + esc(el.id);
    const parts = [];
    let node = el, depth = 0;
    while (node && node.nodeType === 1 && depth < maxDepth) {
      for (const a of node.attributes || []) {
        if (a.name.startsWith('data-') && a.value && a.value.length < 40) {
          parts.unshift(`${node.tagName.toLowerCase()}[${a.name}="${a.value}"]`);
          return parts.join(' > ');
        }
      }
      let sel = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + esc(node.id)); break; }
      const cls = [...node.classList].filter((c) => !NOISE.test(c)).slice(0, 2);
      if (cls.length) sel += '.' + cls.map(esc).join('.');
      const parent = node.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(' > ').replace(/^html\s*>\s*body\s*>\s*/, '');
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    const txt = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    return {
      selector: cssPath(el), tag: el.tagName.toLowerCase(), text: txt.slice(0, 160),
      url: location.href, title: document.title,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }

  const onMove = (e) => {
    if (!picking) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === hoverEl || el === box || el === tip) return;
    hoverEl = el;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    const sel = cssPath(el);
    tip.style.display = 'block';
    tip.textContent = sel.length > 90 ? sel.slice(0, 88) + '…' : sel;
    tip.style.left = Math.max(8, r.left) + 'px';
    tip.style.top = Math.max(8, r.top - 26) + 'px';
  };
  function addMark(el, n) {
    const r = el.getBoundingClientRect();
    const m = document.createElement('div');
    m.style.cssText = `position:fixed;pointer-events:none;z-index:2147483647;
      left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;
      border:2px solid #1f6feb;border-radius:4px;background:rgba(31,111,235,.10)`;
    const tag = document.createElement('div');
    tag.textContent = String(n);
    tag.style.cssText = `position:absolute;left:-9px;top:-9px;width:18px;height:18px;border-radius:50%;
      background:#1f6feb;color:#fff;font:11px/18px -apple-system,PingFang SC,sans-serif;text-align:center`;
    m.appendChild(tag);
    document.documentElement.appendChild(m);
    marks.push(m);
  }
  function clearMarks() { marks.forEach((m) => m.remove()); marks = []; }

  const onClick = (e) => {
    if (!picking) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.target;
    const info = describe(el);
    // 同一个元素重复点 = 取消
    const idx = picked.findIndex((x) => x.selector === info.selector);
    if (idx >= 0) { picked.splice(idx, 1); }
    else { picked.push(info); }
    clearMarks();
    picked.forEach((x, i) => {
      const node = document.querySelector(x.selector);
      if (node) addMark(node, i + 1);
    });
    chrome.runtime.sendMessage({ type: 'ELEMENT_PICKED', payload: { multi: true, items: picked } }).catch(() => {});
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && picking) {
      stopPick();
      chrome.runtime.sendMessage({ type: 'PICK_CANCELLED' }).catch(() => {});
    }
  };

  function startPick() {
    picking = true; mount();
    banner.style.display = 'block';
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }
  function stopPick() {
    picking = false; hoverEl = null;
    clearMarks();
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    banner.style.display = 'none'; box.style.display = 'none'; tip.style.display = 'none';
    unmount();
  }

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg?.type === 'START_PICK') { startPick(); reply({ ok: true }); }
    if (msg?.type === 'STOP_PICK') { stopPick(); reply({ ok: true }); }
    if (msg?.type === 'PING') reply({ ok: true });
    if (msg?.type === 'GET_LOGS') reply({ ok: true, logs: logs.slice(-80), total: logs.length, net: net.slice(-50) });
    if (msg?.type === 'GET_PICKS') reply({ ok: true, items: picked });
    if (msg?.type === 'CLEAR_PICKS') { picked = []; clearMarks(); reply({ ok: true }); }
    if (msg?.type === 'CLEAR_LOGS') { logs.length = 0; net.length = 0; reply({ ok: true }); }
  });
})();
