// 由桌面 app / 原生宿主唤起时用独立窗口打开（?standalone=1）
if (new URLSearchParams(location.search).has('standalone')) document.body.classList.add('standalone');

const $ = (id) => document.getElementById(id);
const K_TOOL = 'toolV3', K_THREAD = 'threadV3', K_CWD = 'cwdV3';

let bridge = 'http://127.0.0.1:47391';
let bridgeCandidates = [];   // 探测成功后缓存可用地址
let lastError = '';          // 最近一次连接错误，离线横幅用
let qSummary = {};           // 每个会话的待发条数，会话列表角标用
let lastSend = null;         // 最近一次发送的参数，回复轮询用
let captures = [];   // 待随下一条标注一起发送的截图/控制台
let tools = [], tool = 'codex', sessions = [], selected = null, picked = [], pollTimer = null;
let pickingActive = false;   // 面板这边记一下拾取状态，Esc 才能随时退出
let queueLen = 0;            // 当前会话队列条数（发送按钮上显示）
let currentJob = null;       // 正在执行的异步发送任务
let previewMessage = '';     // 预览里的完整消息
let jobTimer = null;
let pickTabId = null;        // 拾取发生在哪个标签页；切标签后别把消息发错地方

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const meta = () => tools.find((t) => t.id === tool) || {};

class ApiError extends Error {
  constructor(msg, code, data = null, status = 0) { super(msg); this.code = code; this.data = data; this.status = status; }
}

/** 把技术错误翻译成人话 */
function friendly(e) {
  const m = String(e?.message || e);
  if (e?.code === 'OFFLINE' || /Failed to fetch|NetworkError|Load failed/i.test(m)) {
    return '连不上本地服务 · 检查 bridge 是否在跑（终端执行 ./start.sh）';
  }
  if (/session not found/i.test(m)) return '这个会话找不到了 · 可能已被归档或删除';
  if (/timeout|ETIMEDOUT/i.test(m)) return '目标程序响应超时 · 它可能正在跑别的任务';
  if (/fetch failed|ECONNREFUSED|ECONNRESET/i.test(m)) return '本地服务暂时不可用（可能刚重启）· 等一秒再点一次';
  if (/EPIPE/i.test(m)) return '图片太大，传输被中断 · 换小一点的窗口再截，或先压缩';
  if (/HTTP 5\d\d/.test(m)) return '目标程序报错了 · 点“展开全部”看细节';
  if (/MISSING_CREDENTIAL|no API key/i.test(m)) return 'DSH 的 headless 通道没有模型凭据 · 需要给 headless profile 配 DEEPSEEK_API_KEY';
  if (/ACCOUNT_SIGN_IN_REQUIRED/i.test(m)) return 'DSH 的 headless 通道没登录账号 · 需要单独给它配凭据';
  if (/was recorded in .*, not/i.test(m)) return '这个 DSH 会话原目录对不上，headless 无法续跑';
  return m.length > 120 ? m.slice(0, 120) + '…' : m;
}

function setOffline(on, why) {
  if (why) lastError = why;
  $('offline')?.classList.toggle('hidden', !on);
  $('status')?.classList.toggle('ok', !on);
  const msg = $('offlineMsg');
  if (msg) {
    if (!on) msg.textContent = '';
    else {
      const v = navigator.userAgent.match(/Chrome\/(\d+)/);
      const modern = v && Number(v[1]) >= 142;
      msg.textContent = modern
        ? '连不上本地服务 · Chrome 142+ 请把 chrome://flags/#local-network-access-check 设为 Disabled 后重启'
        : `连不上本地服务${lastError ? ' · ' + lastError.slice(0, 40) : ''}`;
    }
  }
  if (on) { $('statusText') && ($('statusText').textContent = '离线'); startAutoRetry(); }
  else stopAutoRetry();
}

/** 依次尝试候选地址，返回可用的那个 */
async function probeBridge() {
  const cands = bridgeCandidates.length ? bridgeCandidates
    : ['http://127.0.0.1:47391', 'http://localhost:47391'];
  for (const c of cands) {
    try {
      const r = await fetch(c + '/health', { cache: 'no-store' });
      if (r.ok) { bridgeCandidates = cands; bridge = c; return true; }
      lastError = `HTTP ${r.status}`;
    } catch (e) { lastError = String(e?.message || e); }
  }
  return false;
}

let retryTimer = null;
function startAutoRetry() {
  if (retryTimer) return;
  retryTimer = setInterval(async () => {
    try { await fetch(bridge + '/health', { cache: 'no-store' }); await reconnect(); }
    catch {}
  }, 5000);
}
function stopAutoRetry() { clearInterval(retryTimer); retryTimer = null; }
async function reconnect() {
  await probeBridge();
  const ok = await loadTools();
  if (ok) { setOffline(false); await loadSessions(); await loadQueue(); hint('sendHint', '已重新连接', 'ok'); }
}

// 面板自己持有一个常驻的原生端口：
// service worker 休眠不会影响它，宿主跟着面板一起活着，请求也不会再被掐断。
const NATIVE_HOST = 'com.gjr.annotation_bridge';
let nativePort = null;
let nativeSeq = 0;

function getNativePort() {
  if (nativePort) return nativePort;
  const p = chrome.runtime.connectNative(NATIVE_HOST);
  p.onDisconnect.addListener(() => { if (nativePort === p) nativePort = null; });
  p.onMessage.addListener((m) => {
    if (m?.type === 'COMMAND' && m.command === 'OPEN_PANEL') {
      // 面板已经开着，聚焦当前窗口就行
      chrome.windows.getCurrent().then((w) => chrome.windows.update(w.id, { focused: true })).catch(() => {});
    }
  });
  nativePort = p;
  return p;
}

async function nativeCall(path, method, body) {
  let port;
  try { port = getNativePort(); } catch { return null; }   // host 没装 → 交给 HTTP
  const id = ++nativeSeq;
  return new Promise((resolve) => {
    let settled = false, sent = false;
    const cleanup = () => {
      clearTimeout(timer);
      try { port.onMessage.removeListener(onMsg); } catch {}
      try { port.onDisconnect.removeListener(onDisc); } catch {}
    };
    const done = (r) => { if (settled) return; settled = true; cleanup(); resolve(r); };
    const onMsg = (m) => { if (!m || m.id !== id) return; done(m); };
    const onDisc = () => {
      const err = chrome.runtime.lastError?.message || 'native host 断开';
      if (nativePort === port) nativePort = null;
      done(sent ? { native: true, status: 599, data: { error: `原生宿主中断：${err}` } } : { native: false, error: err });
    };
    // /send 可能要跑很久；其它请求 30 秒没回音就认为通道坏了，让上层重试/回退
    const waitMs = path.startsWith('/send') ? 15 * 60 * 1000 : 30000;
    const timer = setTimeout(() => done({ native: true, status: 599, data: { error: `原生宿主 ${Math.round(waitMs / 1000)} 秒没有返回` } }), waitMs);
    port.onMessage.addListener(onMsg);
    port.onDisconnect.addListener(onDisc);
    try { port.postMessage({ id, method, path, body }); sent = true; }
    catch (e) { nativePort = null; done({ native: false, error: String(e?.message || e) }); }
  });
}

async function api(path, opts = {}) {
  const method = opts.method || 'GET';
  let body;
  if (opts.body) { try { body = JSON.parse(opts.body); } catch {} }

  // 1) 原生消息（不经浏览器网络层，不受 LNA 限制）
  // 宿主偶尔会被 Chrome 回收，599 表示"请求发出去了、回复没回来"：
  // 对幂等操作自动重试一次（/queue 用 clientId 去重，不会加两条）。
  const idempotent = method === 'GET' || opts.idempotent === true;
  const tries = idempotent ? 2 : 1;
  let nativeErr = null;
  for (let i = 0; i < tries; i++) {
    let r = null;
    try { r = await nativeCall(path, method, body); }
    catch (e) { if (e instanceof ApiError) throw e; }
    if (!r) break;   // 没有原生通道 → 走 HTTP
    if (r.status === 599) {
      nativeErr = r;
      if (i + 1 < tries) { await new Promise((res) => setTimeout(res, 300)); continue; }
      break;         // 重试也没回音 → 退到 HTTP 再试一次
    }
    if (r.status === 0 || r.status >= 400) throw new ApiError(r.data?.error || `HTTP ${r.status}`, r.status === 502 ? 'UPSTREAM' : 'HTTP', r.data, r.status);
    setOffline(false);
    return r.data;
  }

  // 2) 回退 HTTP（开发/测试环境，或者原生通道一时断了）
  let res;
  try {
    res = await fetch(bridge + path, { headers: { 'content-type': 'application/json' }, ...opts });
  } catch (e) {
    setOffline(true, String(e?.message || e));
    if (nativeErr) throw new ApiError(nativeErr.data?.error || '原生宿主中断', 'HTTP', nativeErr.data, 599);
    throw new ApiError('连不上本地服务', 'OFFLINE');
  }
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) throw new ApiError(data?.error || `HTTP ${res.status}`, res.status === 502 ? 'UPSTREAM' : 'HTTP', data, res.status);
  setOffline(false);
  return data;
}
function setStatus(ok, t) { $('status')?.classList.toggle('ok', !!ok); const el = $('statusText'); if (el) el.textContent = t; }
function hint(el, t, kind = '') { const n = $(el); n.className = 'hint ' + kind; n.textContent = t; n.classList.toggle('hidden', !t); }
function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return '刚刚'; if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60); return h < 24 ? `${h} 小时前` : `${Math.floor(h / 24)} 天前`;
}

// ── 工具页签 ──
function renderTabs() {
  const usable = tools.filter((t) => t.available);
  if (!usable.length) {
    $('toolTabs').innerHTML = '<div class="tool off" style="cursor:default">没有可用的 CLI</div>';
    return;
  }
  $('toolTabs').innerHTML = usable.map((t) => `
    <div class="tool ${t.id === tool ? 'active' : ''}" data-id="${t.id}"
         title="${esc(t.note || '')}">${esc(t.label)}</div>`).join('');
  $('toolTabs').querySelectorAll('.tool').forEach((el) => el.addEventListener('click', async () => {
    const m = tools.find((x) => x.id === el.dataset.id);
    if (!m.available) return hint('sendHint', `${m.label} 不可用：${m.note || '未安装 CLI'}`, 'err');
    if (tool === m.id) return;
    tool = m.id; selected = null; picked = null;
    chrome.storage.local.set({ [K_TOOL]: tool });
    updateSelectedUI(); renderPicked(); renderTabs(); renderOpts();
    await loadSessions(); await loadQueue();
  }));
}

// ── 会话 ──
function updateSelectedUI() {
  const t = $('selTitle');
  if (!t) return;
  if (!selected) { t.textContent = '未选择会话'; return; }
  t.textContent = selected.title || String(selected.id).slice(0, 8);
}

async function refreshSummary() {
  try { qSummary = (await api('/queue/summary')).counts || {}; } catch { qSummary = {}; }
  renderList();
}

function renderList() {
  const q = ($('search').value || '').trim().toLowerCase();
  const list = !q ? sessions : sessions.filter((s) => [s.title, s.project, s.id, s.cwd].join(' ').toLowerCase().includes(q));
  const box = $('sessionList');
  if (!list.length) { box.innerHTML = `<div class="pop-empty">${sessions.length ? '没有匹配' : '还没有会话'}</div>`; return; }
  box.innerHTML = list.map((s) => `
    <div class="pop-item ${selected?.id === s.id ? 'active' : ''}" data-id="${s.id}">
      <b>${esc(s.title || String(s.id).slice(0, 8))}${qSummary[`${tool}|${s.id}`] ? `<span class="badge">${qSummary[`${tool}|${s.id}`]}</span>` : ''}${tool === 'dsh' && s.preset ? '<span class="ro" title="GUI 里创建的会话（agent preset），headless 不能投递，只能读">只读</span>' : ''}</b>
      <small>${esc(s.project || '')} · ${s.model ? esc(s.model) + ' · ' : ''}${String(s.id).slice(0, 8)} · ${ago(s.mtime)}</small>
    </div>`).join('');
  box.querySelectorAll('.pop-item').forEach((el) => el.addEventListener('click', () => {
    const s = sessions.find((x) => x.id === el.dataset.id);
    if (s) select(s);
  }));
}

function select(s) {
  selected = s;
  chrome.storage.local.set({ [K_THREAD]: { ...s, tool }, [K_CWD]: s.cwd || '' });
  updateSelectedUI(); renderList();
  if (tool === 'dsh' && s.preset) {
    hint('sendHint', `这个 DSH 会话是 GUI 创建的（预设 ${s.preset}），headless 不能投递 · 可以改用 Codex，或新建会话`, 'err');
  }
  switchTab('feedback');
  $('messages').innerHTML = '<div class="empty">发送后这里会显示回复</div>';
  loadQueue();
}

async function loadTools() {
  try {
    const d = await api('/tools');
    tools = d.tools || [];
    if (!tools.find((t) => t.id === tool)?.available) tool = tools.find((t) => t.available)?.id || tool;
    renderTabs(); renderOpts();
    return true;
  } catch { return false; }
}

async function loadSessionsOnce() {
  try { const d = await api(`/sessions?tool=${tool}&limit=60`); sessions = d.sessions || []; renderList(); $('sessCount').textContent = String(sessions.length); } catch {}
}

async function loadSessions() {
  try {
    const d = await api(`/sessions?tool=${tool}&limit=60`);
    sessions = d.sessions || [];
    renderList();
    $('sessCount').textContent = String(sessions.length);
    setStatus(true, `${sessions.length} 个会话`);
    // 首次没拿到模型目录（bridge 刚起来），这里补一次
    if (!tools.some((t) => (t.models || []).length)) {
      if (await loadTools()) await loadSessionsOnce();
    }
  } catch (e) {
    setStatus(false, '连接失败');
    setOffline(true);
    $('sessionList').innerHTML = '<div class="pop-empty">连不上本地服务<br/>终端执行 ./start.sh</div>';
  }
}

// ── 选项 ──
function renderOpts() {
  const m = meta();
  const fill = (sel, arr) => {
    const cur = $(sel).value;
    $(sel).innerHTML = arr.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
    if (cur && [...$(sel).options].some((o) => o.value === cur)) $(sel).value = cur;
  };
  fill('mode', (m.sendModes || []).map((x) => ({ value: x.id, label: x.label })));
  const sessionModel = selected?.model || '';
  const modelOpts = (m.models || []).map((x) => ({ value: x.id, label: x.label || x.id }));
  if (sessionModel && !modelOpts.some((o) => o.value === sessionModel)) {
    modelOpts.unshift({ value: sessionModel, label: sessionModel });
  }
  fill('model', [{ value: '', label: sessionModel ? `默认（${sessionModel}）` : '默认' }, ...modelOpts]);
  fill('newModel', [{ value: '', label: '默认' }, ...(m.models || []).map((x) => ({ value: x.id, label: x.label || x.id }))]);
  renderEfforts('model', 'effort');
  renderEfforts('newModel', 'newEffort');
  syncOpts();
}

function renderEfforts(modelSel, effortSel) {
  const opt = $(modelSel).selectedOptions?.[0];
  const levels = (opt?.dataset?.levels || '').split(',').filter(Boolean);
  const all = meta().efforts || [];
  const list = levels.length ? levels : all;
  $(effortSel).innerHTML = ['<option value="">默认</option>', ...list.map((l) => `<option value="${l}">${l}</option>`)].join('');
}

function syncOpts() {
  const editable = ['resume', 'print'].includes($('mode').value);
  $('model').disabled = !editable || $('model').options.length < 2;
  $('effort').disabled = !editable || !$('effort').options.length;
}

// ── 拾取 ──
const activeTab = async () => {
  try {
    const tabs = await chrome.tabs.query({});
    const pages = (tabs || []).filter((t) => t.url && /^https?:\/\//.test(t.url));
    if (!pages.length) return null;
    const active = pages.filter((t) => t.active).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const t = active[0] || pages.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    return { tabId: t.id, url: t.url, title: t.title, windowId: t.windowId };
  } catch { return null; }
};
async function ensureContent(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { type: 'PING' }); return true; }
  catch {
    try {
      // 页面是在扩展加载前打开的：补注入。日志只对之后的输出有效。
      try { await chrome.scripting.executeScript({ target: { tabId }, files: ['inject-console.js'], world: 'MAIN' }); } catch {}
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      return true;
    } catch { return false; }
  }
}
/** 拾取/删除/定位都发回「当初拾取的那个标签页」，不是当前 active 的 */
async function pageTabId() {
  if (pickTabId) return pickTabId;
  const tab = await activeTab();
  return tab?.tabId || null;
}

function setPicking(on) {
  pickingActive = !!on;
  const fab = $('fabPick');
  if (fab) fab.innerHTML = on ? '<span>⌖</span>退出拾取' : '<span>⌖</span>选元素';
  $('btnPick')?.classList.toggle('picking', on);
}

async function startPick() {
  if (pickingActive) return stopPickRemote();
  const tab = await activeTab();
  if (!tab?.tabId) return hint('sendHint', '没有可用的标签页', 'err');
  if (!(await ensureContent(tab.tabId))) return hint('sendHint', '这个页面不允许注入脚本', 'err');
  pickTabId = tab.tabId;
  await chrome.tabs.sendMessage(tab.tabId, { type: 'START_PICK' });
  setPicking(true);
  hint('sendHint', '拾取中：在页面上点元素 · 按 Esc 退出', 'ok');
}

/** 面板有焦点时也能退出拾取（页面那边收不到键盘事件） */
async function stopPickRemote() {
  const tabId = await pageTabId();
  if (tabId) chrome.tabs.sendMessage(tabId, { type: 'STOP_PICK' }).catch(() => {});
  setPicking(false);
  hint('sendHint', '已退出拾取', '');
}
function renderPicked() {
  const box = $('pickedBox');
  if (!box) return;
  if (!picked || !picked.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="picked-head">
      <span>已选 <b>${picked.length}</b> 个元素</span>
      <button class="link" id="btnClearPicked">清空</button>
    </div>
    ${picked.map((el, i) => {
      const size = el.rect ? ` · ${el.rect.w}×${el.rect.h}` : '';
      const label = (el.text || el.tag || '元素').replace(/\s+/g, ' ').slice(0, 60);
      return `
      <div class="pick-row" data-i="${i}">
        <span class="num">${i + 1}</span>
        <div class="pick-body">
          <span class="pick-label" title="${esc(label)}">${esc(label)}</span>
          <code class="pick-sel" title="${esc(el.selector)}">${esc(el.selector)}${size}</code>
        </div>
        <span class="pick-locate" data-i="${i}" title="在页面上定位（黄框闪一下）">⌖</span>
        <span class="pick-up" data-i="${i}" title="改成选它的上一层（点到了文字/图标时很有用）">↑</span>
        <span class="x" data-i="${i}" title="从选择里移除">✕</span>
      </div>`;
    }).join('')}`;
  box.querySelectorAll('.x').forEach((x) => x.addEventListener('click', (e) => {
    e.stopPropagation();
    removePick(Number(x.dataset.i));
  }));
  box.querySelectorAll('.pick-locate').forEach((x) => x.addEventListener('click', (e) => {
    e.stopPropagation();
    locatePick(Number(x.dataset.i));
  }));
  box.querySelectorAll('.pick-up').forEach((x) => x.addEventListener('click', (e) => {
    e.stopPropagation();
    promotePick(Number(x.dataset.i));
  }));
  // 鼠标划过行：在页面上把对应元素标出来，先看再决定
  box.querySelectorAll('.pick-row').forEach((row) => {
    row.addEventListener('mouseenter', async () => {
      const el = picked[Number(row.dataset.i)];
      if (!el) return;
      const tabId = await pageTabId();
      if (tabId) chrome.tabs.sendMessage(tabId, { type: 'HIGHLIGHT', selector: el.selector }).catch(() => {});
    });
    row.addEventListener('mouseleave', async () => {
      const tabId = await pageTabId();
      if (tabId) chrome.tabs.sendMessage(tabId, { type: 'UNHIGHLIGHT' }).catch(() => {});
    });
  });
  $('btnClearPicked')?.addEventListener('click', (e) => { e.stopPropagation(); clearPicked(); });
}

/** 面板里删掉一个元素时，页面那边的 picked 也要删，否则下次一选又回来 */
async function removePick(i) {
  const el = picked[i];
  if (!el) return;
  picked.splice(i, 1);
  renderPicked();
  const tabId = await pageTabId();
  if (!tabId) return;
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'REMOVE_PICK', selector: el.selector });
    if (Array.isArray(r?.items)) { picked = r.items; renderPicked(); }
  } catch { /* 页面没注入脚本就只改面板这边 */ }
}

async function clearPicked() {
  picked = [];
  renderPicked();
  const tabId = await pageTabId();
  if (tabId) chrome.tabs.sendMessage(tabId, { type: 'CLEAR_PICKS' }).catch(() => {});
}

/** 改成选上一层：点到了文字/图标、想选整张卡片时用 */
async function promotePick(i) {
  const el = picked[i];
  if (!el) return;
  const tabId = await pageTabId();
  if (!tabId) return;
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'PROMOTE', selector: el.selector });
    if (r?.ok && Array.isArray(r.items)) {
      picked = r.items;
      renderPicked();
      const now = picked.find((x) => x.selector === el.selector) || picked[Math.min(i, picked.length - 1)];
      hint('sendHint', now ? `已改成上一层：${String(now.selector).slice(0, 60)}` : '已改成上一层', 'ok');
    } else {
      hint('sendHint', r?.error || '没有上一层了', 'err');
    }
  } catch { hint('sendHint', '页面还没注入脚本 · 刷新一下', 'err'); }
}

async function locatePick(i) {
  const el = picked[i];
  if (!el) return;
  const tabId = await pageTabId();
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'FLASH', selector: el.selector });
    hint('sendHint', '已在页面上标出这个元素（黄框）', 'ok');
  } catch {
    hint('sendHint', '页面还没注入脚本 · 刷新一下页面', 'err');
  }
}

// ── 采集附件 ──
function updateCapWarn() {
  const el = $('capWarn'); if (!el) return;
  const hasShot = captures.some((c) => c.kind === 'screenshot');
  const queueMode = $('mode').value === 'queue';
  el.textContent = hasShot && queueMode ? '截图只在「续跑」模式下会作为图片送进模型；排队模式只给文件路径' : '';
  el.classList.toggle('hidden', !el.textContent);
}

function renderCaps() {
  const box = $('capsChips');
  if (!captures.length) {
    box.classList.add('hidden'); box.innerHTML = '';
    updateCapWarn();
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = captures.map((c, i) => {
    if (c.kind === 'screenshot') {
      const src = c.dataUrl || '';
      return `<div class="thumb-wrap" data-i="${i}">
        <img class="thumb" ${src ? `src="${src}"` : `data-cap="${c.id}"`} alt="截图" title="点击查看大图" />
        <span class="x" data-i="${i}">✕</span>
      </div>`;
    }
    return `<span class="chip console-chip" data-i="${i}" title="点击查看全部日志">🖥 日志 ${c.count}${c.netCount ? ` · 请求 ${c.netCount}` : ''}${c.perfCount ? ` · 资源 ${c.perfCount}` : ''}<span class="x" data-i="${i}">✕</span></span>`;
  }).join('');

  box.querySelectorAll('.x').forEach((el) => el.addEventListener('click', (e) => {
    e.stopPropagation();
    captures.splice(Number(el.dataset.i), 1); renderCaps();
    hint('sendHint', '已移除附件');
  }));
  box.querySelectorAll('.console-chip').forEach((chip) => chip.addEventListener('click', async (e) => {
    if (e.target.classList.contains('x')) return;
    const c = captures[Number(chip.dataset.i)];
    try {
      const d = await api(`/capture/data?id=${c.id}`);
      const blob = new Blob([d.text || JSON.stringify(d, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      chrome.tabs.create({ url });
    } catch (e2) { hint('sendHint', '打开日志失败：' + friendly(e2), 'err'); }
  }));
  updateCapWarn();
  box.querySelectorAll('.thumb[data-cap]').forEach(async (img) => {
    if (img.src) return;
    try {
      const d = await api(`/capture/data?id=${img.dataset.cap}`);
      if (d?.dataUrl) img.src = d.dataUrl;
    } catch {}
  });
  box.querySelectorAll('.thumb').forEach((img) => img.addEventListener('click', () => {
    const i = Number(img.parentElement.dataset.i);
    const c = captures[i];
    const url = c.url ? bridge + c.url : c.dataUrl;
    if (url) chrome.tabs.create({ url });   // 想看大图就在新标签打开
  }));
}

function setConsoleCount(text, title = '') {
  const el = $('consoleCount');
  if (!el) return;
  el.textContent = text;
  el.title = title;
}

/** 面板开着的时候每 3 秒看一眼：有多少日志、脚本有没有注入 */
async function refreshConsoleCount() {
  if (!($('capConsole')?.checked)) return setConsoleCount('已关闭', '勾上「带上页面日志」就会随标注一起发送');
  const tab = await activeTab();
  if (!tab?.tabId) return setConsoleCount('没有可用的页面');
  try {
    const r = await chrome.tabs.sendMessage(tab.tabId, { type: 'GET_LOGS' });
    const n = r?.total ?? 0;
    const netFail = (r?.net || []).filter((x) => !x.ok).length;
    setConsoleCount(n ? `${n} 条${netFail ? ` · 网络失败 ${netFail}` : ''}` : '0 条',
      n ? '' : '这个页面还没记录到日志。页面是在扩展加载前打开的，刷新一下就会开始捕获。');
  } catch {
    setConsoleCount('未注入', '这个页面是在扩展加载前打开的：点「读取日志」或刷新页面就能开始捕获。');
  }
}

async function grabConsole(silent) {
  const btn = $('btnGrabLogs');
  if (!silent && btn) { btn.disabled = true; hint('sendHint', '正在读取页面日志…'); }
  try {
    const tab = await activeTab();
    if (!tab?.tabId) { if (!silent) hint('sendHint', '没有可用的页面（先切到网页标签页）', 'err'); return; }
    if (!(await ensureContent(tab.tabId))) {
      if (!silent) hint('sendHint', '这个页面不允许注入脚本（chrome:// 或扩展页）', 'err');
      return;
    }
    const r = await chrome.tabs.sendMessage(tab.tabId, { type: 'GET_LOGS' });
    const n = r?.total ?? 0;
    const netCount = (r?.net || []).length;
    const perfCount = r?.perf?.total ?? 0;
    const netFail = (r?.net || []).filter((x) => !x.ok).length;
    setConsoleCount(n ? `${n} 条${netFail ? ` · 网络失败 ${netFail}` : ''}` : (perfCount ? `${perfCount} 个请求` : '0 条'));
    if (silent) return;

    // 控制台没日志也不代表没东西可看：Resource Timing 里有页面已经发过的请求
    if (!n && !perfCount) {
      hint('sendHint', '这个页面没有可读的日志或请求记录 · 刷新页面后再试', 'err');
      return;
    }
    const d = await api('/capture', { method: 'POST', body: JSON.stringify({ kind: 'console', logs: r.logs, net: r.net, perf: r.perf }) });
    captures.push({
      kind: 'console', id: d.id, count: d.count, netCount: d.netCount || 0,
      perfCount: d.perfCount || 0, path: d.path, url: d.url, preview: d.preview,
    });
    renderCaps();
    const bits = [`${d.count} 条日志`];
    if (d.netCount) bits.push(`${d.netCount} 个请求`);
    if (d.perfCount) bits.push(`${d.perfCount} 条资源耗时`);
    hint('sendHint', `已附上 ${bits.join(' · ')}`, 'ok');
  } catch (e) {
    if (!silent) hint('sendHint', '读取失败：' + friendly(e), 'err');
  } finally {
    if (btn) btn.disabled = false;
    // 提示在表单下方，滚一下保证用户看得到
    if (!silent) $('sendHint')?.scrollIntoView({ block: 'nearest' });
  }
}


// ── 截图标注编辑器 ────────────────────────────────────
const ED = { img: null, shapes: [], tool: 'rect', drawing: null, scale: 1, result: null };

function openEditor(dataUrl, onSave) {
  ED.shapes = []; ED.tool = 'rect'; ED.onSave = onSave;
  $('shotModal').classList.remove('hidden');
  $('edText').classList.add('hidden');
  $('edText').value = '';
  document.querySelectorAll('.ed-tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === 'rect'));
  const img = new Image();
  img.onload = () => {
    ED.img = img;
    const cv = $('edCanvas');
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    redraw();
  };
  img.src = dataUrl;
}

function redraw(preview) {
  const cv = $('edCanvas'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (ED.img) ctx.drawImage(ED.img, 0, 0);
  const all = preview ? [...ED.shapes, preview] : ED.shapes;
  for (const s of all) drawShape(ctx, s);
}

function drawShape(ctx, s) {
  ctx.save();
  ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
  ctx.lineWidth = Math.max(3, Math.round(ctx.canvas.width / 300));
  if (s.type === 'rect') {
    ctx.strokeRect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1);
  } else if (s.type === 'ellipse') {
    const cx = (s.x1 + s.x2) / 2, cy = (s.y1 + s.y2) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.abs(s.x2 - s.x1) / 2, Math.abs(s.y2 - s.y1) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (s.type === 'arrow') {
    const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    const head = Math.max(12, ctx.canvas.width / 60);
    ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(s.x2 - head * Math.cos(ang - 0.4), s.y2 - head * Math.sin(ang - 0.4));
    ctx.lineTo(s.x2 - head * Math.cos(ang + 0.4), s.y2 - head * Math.sin(ang + 0.4));
    ctx.closePath(); ctx.fill();
  } else if (s.type === 'text') {
    const size = Math.max(16, Math.round(ctx.canvas.width / 45));
    ctx.font = `600 ${size}px -apple-system, "PingFang SC", sans-serif`;
    ctx.lineWidth = Math.max(3, size / 6);
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.strokeText(s.text, s.x1, s.y1);
    ctx.fillStyle = s.color;
    ctx.fillText(s.text, s.x1, s.y1);
  }
  ctx.restore();
}

function canvasPoint(e) {
  const cv = $('edCanvas'), r = cv.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) };
}

function bindEditor() {
  document.querySelectorAll('.ed-tool').forEach((b) => b.addEventListener('click', () => {
    ED.tool = b.dataset.tool;
    document.querySelectorAll('.ed-tool').forEach((x) => x.classList.toggle('active', x === b));
    $('edText').classList.toggle('hidden', ED.tool !== 'text');
    if (ED.tool === 'text') $('edText').focus();
  }));

  const cv = $('edCanvas');
  cv.addEventListener('pointerdown', (e) => {
    const p = canvasPoint(e);
    if (ED.tool === 'text') {
      const t = $('edText').value.trim();
      if (!t) { $('edText').focus(); return hint('sendHint', '先输入文字再点图上位置', 'err'); }
      ED.shapes.push({ type: 'text', x1: p.x, y1: p.y, text: t, color: $('edColor').value });
      redraw(); return;
    }
    ED.drawing = { type: ED.tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: $('edColor').value };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!ED.drawing) return;
    const p = canvasPoint(e);
    ED.drawing.x2 = p.x; ED.drawing.y2 = p.y;
    redraw(ED.drawing);
  });
  cv.addEventListener('pointerup', () => {
    if (!ED.drawing) return;
    const d = ED.drawing; ED.drawing = null;
    if (Math.abs(d.x2 - d.x1) > 4 || Math.abs(d.y2 - d.y1) > 4) ED.shapes.push(d);
    redraw();
  });

  $('btnEdUndo').addEventListener('click', () => { ED.shapes.pop(); redraw(); });
  $('btnEdClose').addEventListener('click', () => $('shotModal').classList.add('hidden'));
  $('btnEdCancel').addEventListener('click', () => $('shotModal').classList.add('hidden'));
  $('btnEdSave').addEventListener('click', async () => {
    $('btnEdSave').disabled = true;
    try {
      const dataUrl = $('edCanvas').toDataURL('image/png');
      await ED.onSave(dataUrl);
      $('shotModal').classList.add('hidden');
    } catch (e) { hint('sendHint', '保存失败：' + friendly(e), 'err'); }
    finally { $('btnEdSave').disabled = false; }
  });
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

/** 长截图 base64 可能有十几 MB，先压到 2.5MB 左右再传（JPEG 0.9 / 长边 2600） */
async function shrinkDataUrl(dataUrl) {
  if (!dataUrl || dataUrl.length <= 2_500_000) return dataUrl;
  try {
    const img = await loadImage(dataUrl);
    const scale = Math.min(1, 2600 / Math.max(img.width, img.height));
    if (scale === 1 && dataUrl.length <= 8_000_000) return dataUrl;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(img.width * scale));
    cv.height = Math.max(1, Math.round(img.height * scale));
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', 0.9);
  } catch { return dataUrl; }
}

/** 图片进附件（截图 / 贴图 / 拖进来 都走这里） */
async function attachImage(dataUrl) {
  const small = await shrinkDataUrl(dataUrl);
  const d = await api('/capture', { method: 'POST', idempotent: true, body: JSON.stringify({ kind: 'screenshot', dataUrl: small }) });
  captures.push({ kind: 'screenshot', id: d.id, path: d.path, url: d.url, dataUrl: small });
  renderCaps();
  hint('sendHint', '已添加图片，会随下一条标注一起发', 'ok');
}

async function takeShot() {
  const tab = await activeTab();
  if (!tab?.tabId) return hint('sendHint', '没有可截图的页面', 'err');
  try {
    // 一定要传网页所在窗口：面板是独立窗口时，null 会把面板自己截下来
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    openEditor(dataUrl, attachImage);
  } catch (e) { hint('sendHint', '截图失败：' + friendly(e) + ' · 也可以直接 ⌘V 贴图', 'err'); }
}

const blobToDataUrl = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = rej;
  r.readAsDataURL(blob);
});

function imageIntoEditor(blob) {
  if (!blob || !(blob.type || '').startsWith('image/')) return;
  blobToDataUrl(blob)
    .then((d) => openEditor(d, attachImage))
    .catch(() => hint('sendHint', '读取图片失败', 'err'));
}

async function pasteFromClipboard() {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = (it.types || []).find((t) => t.startsWith('image/'));
      if (type) { imageIntoEditor(await it.getType(type)); return; }
    }
    hint('sendHint', '剪贴板里没有图片', '');
  } catch (e) {
    hint('sendHint', '读不到剪贴板 · 直接按 ⌘V 试试', 'err');
  }
}

// ── 队列 ──
async function loadQueue() {
  if (!selected) {
    queueLen = 0;
    $('queueCount').textContent = '0';
    updateSendButton();
    $('queue').innerHTML = '<div class="empty">还没选会话</div>';
    return;
  }
  // 先清空，避免切换会话时闪出上一个会话的条目
  $('queue').innerHTML = '<div class="empty">加载中…</div>';
  try {
    const d = await api(`/queue?thread=${encodeURIComponent(selected.id)}&tool=${tool}`);
    const q = d.queue || [];
    queueLen = q.length;
    $('queueCount').textContent = String(q.length);
    updateSendButton();
    $('queue').innerHTML = q.length ? q.map((it) => `
      <div class="qitem"><span class="x" data-del="${it.id}">✕</span>
        <div class="c">${esc(it.comment)}</div>
        <div class="s">${esc(it.selector || '(无选择器)')}</div></div>`).join('')
      : '<div class="empty">队列是空的</div>';
    $('queue').querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api('/queue/remove', { method: 'POST', idempotent: true, body: JSON.stringify({ id: el.dataset.del }) });
      await loadQueue(); await refreshSummary();
    }));
  } catch (e) { hint('sendHint', '读队列失败：' + friendly(e), 'err'); }
}

const newClientId = () => 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

async function addToQueue() {
  if (!selected) return hint('sendHint', '先选一个目标会话', 'err');
  const comment = $('comment').value.trim();
  // 不选元素也能发：只写一句整页备注就行
  if (!comment && !picked.length) return hint('sendHint', '写一句备注，或者先在页面上选个元素', 'err');
  try {
    if ($('capConsole').checked) await grabConsole(true);
    await api('/queue', { method: 'POST', idempotent: true, body: JSON.stringify({
      clientId: newClientId(),
      tool, thread: selected.id, comment,
      selector: picked[0]?.selector || '', text: picked[0]?.text || '', url: picked[0]?.url || (captures[0]?.url || ''),
      elements: picked.map((e) => ({ selector: e.selector, tag: e.tag, text: e.text })),
      severity: $('severity').value, captures: captures.slice() }) });
    captures = []; renderCaps();
    picked = []; renderPicked();
    if (pickingActive) await stopPickRemote();
    const tab = await activeTab();
    if (tab?.tabId) chrome.tabs.sendMessage(tab.tabId, { type: 'CLEAR_PICKS' }).catch(() => {});
    $('comment').value = ''; $('comment').focus();
    hint('sendHint', '已加入队列', 'ok');
    await loadQueue(); await refreshSummary();
  } catch (e) { hint('sendHint', '入队失败：' + friendly(e), 'err'); }
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(message)), ms)),
  ]);
}

function isReadOnlySession() {
  return tool === 'dsh' && !!selected?.preset;
}

/** 按钮文案：GUI 创建的 DSH 会话不能投递，按钮变成「复制」 */
function updateSendButton() {
  const b = $('btnSend');
  if (!b) return;
  if (isReadOnlySession()) {
    b.innerHTML = '复制 ' + queueLen + ' 条';
    b.title = '这个 DSH 会话是 GUI 创建的（headless 不能投递）· 复制后去 DSH 里 ⌘V 粘贴发送';
  } else {
    b.innerHTML = '发送 <b id="fabCount">' + queueLen + '</b>';
    b.title = '';
  }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}

/** 给不能投递的会话生成完整消息并复制，用户粘到 DSH 里发 */
async function copyComposed() {
  if (!selected) return hint('sendHint', '先选一个目标会话', 'err');
  if (!queueLen) return hint('sendHint', '队列是空的 · 先把标注加入队列', 'err');
  try {
    const d = await api('/compose', { method: 'POST', idempotent: true, body: JSON.stringify({ tool, thread: selected.id }) });
    const ok = await copyText(d.message);
    hint('sendHint', ok
      ? `已复制 ${d.count} 条标注 · 去 DSH 会话里 ⌘V 粘贴发送`
      : `复制失败 · 再点一次试试`, ok ? 'ok' : 'err');
    $('sendHint')?.scrollIntoView({ block: 'nearest' });
  } catch (e) { hint('sendHint', '复制失败：' + friendly(e), 'err'); }
}

async function sendAll() {
  if (isReadOnlySession()) return copyComposed();
  if (!selected) return hint('sendHint', '先选一个目标会话', 'err');
  if (currentJob && currentJob.thread === selected.id) {
    const sec = Math.round((Date.now() - currentJob.startedAt) / 1000);
    return hint('sendHint', `这个会话上一条还在执行（已 ${sec}s），等它结束再发`, 'err');
  }
  const mode = $('mode').value;
  $('btnSend').disabled = true;
  hint('sendHint', '正在提交…');
  try {
    lastSend = { mode, model: $('model').value, effort: $('effort').value, count: null };
    const d = await withTimeout(api('/send', { method: 'POST', idempotent: true, body: JSON.stringify({
      tool, thread: selected.id, mode,
      model: $('model').value || undefined, effort: $('effort').value || undefined }) }), 20000, '提交超时');
    lastSend.count = d.count;
    if (d.dryRun) { hint('sendHint', `DRY_RUN：已生成 ${d.count} 条，未真正投递`, 'ok'); return; }
    if (d.job) {
      currentJob = d.job;
      startJobPoll();
      hint('sendHint', `${d.job.mode === 'queue' ? '已入队' : '已提交'} · 正在执行…`);
      await loadQueue();
    }
  } catch (e) {
    if (e?.data?.reason === 'busy' && e.data.job) {
      currentJob = e.data.job;
      startJobPoll();
      hint('sendHint', '这个会话上一条还在执行 · 已接上它的进度');
    } else if (e?.data?.reason === 'preset') {
      hint('sendHint', `这个 DSH 会话是 GUI 创建的（预设 ${e.data.preset}），headless 不能接管 · 换 Codex，或新建会话`, 'err');
    } else {
      hint('sendHint', '发送失败：' + friendly(e), 'err');
    }
  }
  finally { $('btnSend').disabled = false; }
}

/** 预览将要发送的完整消息（不投递） */
async function openPreview() {
  if (!selected) return hint('sendHint', '先选一个目标会话', 'err');
  if (!queueLen) return hint('sendHint', '队列是空的 · 先把标注加入队列', 'err');
  try {
    const d = await api('/compose', { method: 'POST', idempotent: true, body: JSON.stringify({ tool, thread: selected.id }) });
    previewMessage = d.message || '';
    $('previewText').textContent = previewMessage;
    $('previewModal').classList.remove('hidden');
  } catch (e) { hint('sendHint', '预览失败：' + friendly(e), 'err'); }
}

/** 轮询异步任务：显示进度，完成时把回复贴进来 */
function startJobPoll() {
  stopJobPoll();
  const tick = async () => {
    if (!currentJob) return stopJobPoll();
    try {
      const d = await api(`/job?id=${encodeURIComponent(currentJob.id)}`);
      const j = d.job;
      if (!j) return;
      currentJob = j;
      const sec = Math.round((Date.now() - j.startedAt) / 1000);
      if (j.status === 'running') {
        hint('sendHint', `${j.mode === 'queue' ? '已入队 · 等当前回合结束' : '正在执行'} · 已 ${sec}s`);
        return;
      }
      stopJobPoll();
      currentJob = null;
      await loadQueue(); await refreshSummary();
      if (j.status === 'done') {
        if (j.reply) {
          hint('sendHint', j.reply.slice(0, 160), 'ok');
        } else if (j.mode === 'queue') {
          hint('sendHint', `已预提交 ${j.count} 条 · Codex 队列里还有 ${j.pendingCount ?? '?'} 条，当前任务结束后自动发送`, 'ok');
        } else {
          hint('sendHint', `完成 · 用时 ${sec}s${j.pendingCount ? ` · Codex 队列里还有 ${j.pendingCount} 条` : ''}`, 'ok');
        }
        if (j.replyText) appendMessages([{ role: 'assistant', text: j.replyText, tools: [] }]);
        else pollReply(j.startedAt || Date.now());
      } else if (j.reason === 'preset') {
        hint('sendHint', `这个 DSH 会话是 GUI 创建的（预设 ${j.preset}），headless 不能接管 · 换 Codex，或新建会话`, 'err');
      } else {
        hint('sendHint', '发送失败：' + friendly(new Error(j.error || '未知错误')), 'err');
      }
    } catch { /* 网络抖动就下一拍再试 */ }
  };
  tick();
  jobTimer = setInterval(tick, 1500);
}

function stopJobPoll() {
  if (jobTimer) clearInterval(jobTimer);
  jobTimer = null;
}

/** 面板重开/切会话：把这个会话正在跑的任务接回来 */
async function resumeJobFor(thread) {
  if (!thread) return;
  try {
    const d = await api(`/job?thread=${encodeURIComponent(thread)}&tool=${tool}`);
    if (d.job && d.job.status === 'running') {
      currentJob = d.job;
      startJobPoll();
      const sec = Math.round((Date.now() - d.job.startedAt) / 1000);
      hint('sendHint', `这个会话有一条正在执行 · 已 ${sec}s`);
    }
  } catch {}
}

// ── 消息 ──
function chainNode(m) {
  if (!m.tools?.length) return null;
  const d = document.createElement('div');
  d.className = 'chain';
  d.innerHTML = m.tools.map((t) => `<div class="call">→ <b>${esc(t.name)}</b> ${esc(t.args || '')}</div>`).join('');
  return d;
}

function buildMsg(m) {
  const div = document.createElement('div');
  div.className = `msg ${m.role}`;
  div.innerHTML = `<div class="who">${m.role === 'assistant' ? esc(meta().label || tool) : '我'}</div>${esc(m.text)}`;
  const c = chainNode(m);
  if (c) div.appendChild(c);
  return div;
}

function appendMessages(list) {
  const box = $('messages');
  box.querySelector('.empty')?.remove();
  for (const m of list) box.appendChild(buildMsg(m));
  box.scrollTop = box.scrollHeight;
}

async function loadRecent() {
  if (!selected) return hint('sendHint', '先选一个目标会话', 'err');
  try {
    const d = await api(`/messages?tool=${tool}&thread=${encodeURIComponent(selected.id)}&limit=12`);
    $('messages').innerHTML = '';
    appendMessages(d.messages || []);
    if (!d.messages?.length) $('messages').innerHTML = '<div class="empty">没有历史消息</div>';
  } catch (e) { hint('sendHint', '读消息失败：' + friendly(e), 'err'); }
}

function pollReply(since) {
  clearInterval(pollTimer);
  const seen = new Map();
  const t0 = Date.now();
  const box = $('messages');
  box.querySelector('.empty')?.remove();
  box.querySelectorAll('.livecard').forEach((n) => n.remove());
  const card = document.createElement('div');
  card.className = 'livecard';
  box.appendChild(card);

  const render = (msgs, sec, done) => {
    const last = msgs[msgs.length - 1];
    const tools = msgs.reduce((n, m) => n + (m.tools?.length || 0), 0);
    const text = last?.text || '';
    const multi = msgs.length > 1;
    const long = text.length > 110;
    const canMore = done && (multi || long || tools > 0);

    const modeLabel = ({ queue: '排队', resume: '续跑', print: '续跑', headless: '续跑' })[lastSend.mode] || lastSend.mode || '-';
    const metaRows = [
      ['方式', modeLabel],
      ['模型', lastSend.model || '会话默认'],
      ['强度', lastSend.effort || '默认'],
      ['耗时', `${sec}s`],
      ['消息', `${msgs.length} 条`],
      ['工具', `${tools} 次`],
      ['投递', lastSend.count != null ? `${lastSend.count} 条标注` : '-'],
    ];

    card.innerHTML = `
      <div class="live ${done ? 'ok' : ''}">${done ? '✅' : '等待回复'} ${sec}s${
        tools ? ` · ${tools} 次调用` : ''}${multi ? ` · ${msgs.length} 条` : ''}</div>
      ${done && text ? `<div class="live-sum${long || multi ? ' clamp' : ''}">${esc(text)}</div>` : ''}
      <div class="live-meta hidden">
        ${metaRows.map(([k, v]) => `<span><i>${k}</i>${esc(v)}</span>`).join('')}
      </div>
      <div class="live-detail hidden"></div>
      ${canMore ? '<button class="link live-more">详情</button>' : ''}`;

    const more = card.querySelector('.live-more');
    const sum = card.querySelector('.live-sum');
    const meta = card.querySelector('.live-meta');
    const detail = card.querySelector('.live-detail');
    if (more) more.addEventListener('click', () => {
      const open = detail.classList.contains('hidden');
      meta.classList.toggle('hidden', !open);
      detail.classList.toggle('hidden', !open);
      if (open) {
        if (!detail.childElementCount) {
          if (multi) msgs.forEach((m) => detail.appendChild(buildMsg(m)));
          else { sum?.classList.remove('clamp'); const c = chainNode(last); if (c) detail.appendChild(c); }
        }
      } else {
        sum?.classList.add('clamp');
      }
      more.textContent = open ? '收起' : '详情';
    });
  };

  const tick = async () => {
    const sec = Math.round((Date.now() - t0) / 1000);
    if (sec > 300) { clearInterval(pollTimer); render([...seen.values()], sec, true); return; }
    render([...seen.values()], sec, false);
    try {
      const d = await api(`/reply?tool=${tool}&thread=${encodeURIComponent(selected.id)}&since=${since}`);
      let added = false;
      for (const m of d.messages || []) {
        if (m.role !== 'assistant') continue;
        const k = m.ts + '|' + m.text.slice(0, 24);
        if (seen.has(k)) continue;
        seen.set(k, m); added = true;
      }
      if (added) {
        render([...seen.values()], sec, true);
        box.scrollTop = box.scrollHeight;
        clearInterval(pollTimer);
      }
    } catch (e) {
      clearInterval(pollTimer);
      card.innerHTML = `<div class="live err">⚠ 读取回复失败 · ${esc(e.message)}</div>`;
    }
  };
  tick();
  pollTimer = setInterval(tick, 1500);
}

// ── 新建会话 ──
function openNew() {
  const q = [...$('queue').querySelectorAll('.qitem .c')].map((n) => '· ' + n.textContent);
  $('newMsg').value = q.length ? `请处理这些页面标注：\n${q.join('\n')}` : '';
  $('newCwd').value = (selected?.cwd || localStorage.getItem(K_CWD) || '').trim();
  $('newHint').classList.add('hidden');
  $('newModal').classList.remove('hidden');
  renderEfforts('newModel', 'newEffort');
  setTimeout(() => $('newMsg').focus(), 50);
}

async function runNew() {
  const cwd = $('newCwd').value.trim();
  const message = $('newMsg').value.trim();
  if (!message) return hint('newHint', '写点内容再发送', 'err');
  $('btnNewRun').disabled = true;
  hint('newHint', '创建中…（会跑完一整轮）');
  try {
    const d = await api('/new-session', { method: 'POST', body: JSON.stringify({
      tool, cwd, model: $('newModel').value || undefined,
      effort: $('newEffort').value || undefined, message }) });
    $('newModal').classList.add('hidden');
    if (d.threadId) {
      const proj = (cwd || '').split('/').filter(Boolean).pop() || '(new)';
      select({ id: d.threadId, title: '新会话', project: proj, cwd, mtime: Date.now() });
      await loadSessions();
    }
    $('messages').innerHTML = '';
    appendMessages([{ role: 'assistant', text: d.replyText || '(无输出)', tools: [] }]);
    hint('sendHint', d.threadId ? '新会话已创建' : '已执行（未拿到会话 ID）', 'ok');
  } catch (e) { hint('newHint', '创建失败：' + friendly(e), 'err'); }
  finally { $('btnNewRun').disabled = false; }
}

// ── Tab ──
function switchTab(name) {
  const fb = name === 'feedback';
  $('tabFeedback').classList.toggle('active', fb);
  $('tabSessions').classList.toggle('active', !fb);
  $('paneFeedback').classList.toggle('hidden', !fb);
  $('paneSessions').classList.toggle('hidden', fb);
  if (!fb) renderList();
}

// ── 绑定 ──
function bind() {
  $('btnRefresh').addEventListener('click', loadSessions);
  $('btnRetry').addEventListener('click', reconnect);
  $('btnSession').addEventListener('click', () => { switchTab('sessions'); $('search').focus(); });
  $('search').addEventListener('input', renderList);
  $('btnUseId').addEventListener('click', () => {
    const id = $('manualId').value.trim();
    if (id.length < 8) return hint('sendHint', '会话 ID 看起来不对', 'err');
    select({ id, title: id.slice(0, 10), project: '(手动)', mtime: Date.now() });
    $('manualId').value = '';
  });
  $('fabPick').addEventListener('click', startPick);
  $('tabFeedback').addEventListener('click', () => switchTab('feedback'));
  $('tabSessions').addEventListener('click', () => switchTab('sessions'));
  $('btnPick').addEventListener('click', startPick);
  $('btnShot').addEventListener('click', takeShot);
  $('btnPaste')?.addEventListener('click', pasteFromClipboard);
  $('btnPreviewQueue')?.addEventListener('click', openPreview);
  $('btnCopyQueue')?.addEventListener('click', copyComposed);
  $('btnPreviewClose')?.addEventListener('click', () => $('previewModal').classList.add('hidden'));
  $('btnPreviewCopy')?.addEventListener('click', async () => {
    const ok = await copyText(previewMessage);
    hint('sendHint', ok ? '已复制到剪贴板 · 去 Codex 里 ⌘V 即可' : '复制失败', ok ? 'ok' : 'err');
  });
  $('btnPreviewPaste')?.addEventListener('click', async () => {
    try {
      const d = await api('/paste', { method: 'POST', idempotent: true, body: JSON.stringify({ text: previewMessage }) });
      if (d.pasted) hint('sendHint', '已粘贴到终端并回车 · 去 Claude 窗口看', 'ok');
      else if (d.trusted === false && d.focused) hint('sendHint', '已复制并切到终端 · 给「信鸽」开辅助功能权限后可全自动：系统设置 → 隐私与安全性 → 辅助功能', 'err');
      else if (d.focused) hint('sendHint', '已复制并切到终端 · 按 ⌘V 回车即可', 'ok');
      else hint('sendHint', '已复制到剪贴板 · 去终端 ⌘V 回车', 'ok');
      $('previewModal').classList.add('hidden');
    } catch (e) { hint('sendHint', '投到终端失败：' + friendly(e), 'err'); }
  });
  $('btnPreviewSend')?.addEventListener('click', () => {
    $('previewModal').classList.add('hidden');
    sendAll();
  });
  $('previewModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'previewModal') $('previewModal').classList.add('hidden');
  });

  // 面板有焦点时 Esc 也能退出拾取（页面收不到键盘事件）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pickingActive) {
      e.preventDefault();
      stopPickRemote();
    }
  });

  // ⌘V 直接贴图
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type && i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    imageIntoEditor(item.getAsFile());
  });

  // 图片拖进面板
  document.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    const f = [...(e.dataTransfer?.files || [])].find((x) => (x.type || '').startsWith('image/'));
    if (!f) return;
    e.preventDefault();
    imageIntoEditor(f);
  });
  bindEditor();
  $('btnGrabLogs').addEventListener('click', () => grabConsole(false));
  $('btnClearCaps').addEventListener('click', () => { captures = []; renderCaps(); });
  $('capConsole').addEventListener('change', (e) => { chrome.storage.local.set({ capConsole: e.target.checked }); refreshConsoleCount(); });
  $('btnQueue').addEventListener('click', addToQueue);
  $('comment').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.isComposing) {
      e.preventDefault();
      addToQueue();
    }
  });
  $('btnSend').addEventListener('click', sendAll);
  $('btnLoadMsgs').addEventListener('click', loadRecent);
  $('btnClearQueue').addEventListener('click', async () => {
    if (!selected) return;
    await api('/queue/clear', { method: 'POST', idempotent: true, body: JSON.stringify({ thread: selected.id, tool }) });
    await loadQueue(); await refreshSummary();
  });
  $('mode').addEventListener('change', () => { syncOpts(); updateCapWarn(); });
  $('model').addEventListener('change', () => { renderEfforts('model', 'effort'); syncOpts(); });
  $('newModel').addEventListener('change', () => renderEfforts('newModel', 'newEffort'));
  $('btnNew').addEventListener('click', openNew);
  $('btnNewClose').addEventListener('click', () => $('newModal').classList.add('hidden'));
  $('btnNewRun').addEventListener('click', runNew);
  $('newModal').addEventListener('click', (e) => { if (e.target.id === 'newModal') $('newModal').classList.add('hidden'); });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'ELEMENT_PICKED') {
      setPicking(true);
      picked = msg.payload.items || [];
      renderPicked();
      hint('sendHint', picked.length ? `已选 ${picked.length} 个元素${picked.length > 1 ? '（可继续点，Enter 结束）' : ''}` : '已清空选择', 'ok');
    }
    if (msg?.type === 'PICK_FINISHED') {
      setPicking(false);
      hint('sendHint', `已选 ${msg.count} 个元素，写备注后回车入队`, 'ok');
      $('comment')?.focus();     // 选完直接把光标放到备注框，少一次点击
    }
    if (msg?.type === 'PICK_CANCELLED') {
      setPicking(false);
      hint('sendHint', '已退出拾取');
    }
  });
}

async function init() {
  bind();
  const bi = $('bridgeInfo');
  if (bi) bi.textContent = 'bridge · ' + bridge.replace(/^https?:\/\//, '');
  const st = await chrome.storage.local.get([K_TOOL, K_THREAD]);
  if (st[K_TOOL]) tool = st[K_TOOL];
  renderPicked();
  try { tools = (await api('/tools')).tools || []; }
  catch { hint('sendHint', '连不上 bridge，先运行 ./start.sh', 'err'); tools = [{ id: 'codex', label: 'Codex', available: true, models: [], sendModes: [] }]; }
  if (!tools.find((t) => t.id === tool)?.available) tool = tools.find((t) => t.available)?.id || 'codex';
  renderTabs(); renderOpts(); renderCaps();
  const pref = await chrome.storage.local.get(['capConsole']);
  if (pref.capConsole === false) $('capConsole').checked = false;
  refreshConsoleCount();
  setInterval(refreshConsoleCount, 3000);
  if (st[K_THREAD] && st[K_THREAD].tool === tool) { selected = st[K_THREAD]; updateSelectedUI(); }
  await loadSessions();
  await refreshSummary();
  await loadQueue();
  await restorePicks();
}

/** 面板关掉再打开：页面那边如果还留着已选元素，恢复清单 */
async function restorePicks() {
  try {
    const tab = await activeTab();
    if (!tab?.tabId) return;
    const r = await chrome.tabs.sendMessage(tab.tabId, { type: 'GET_PICKS' });
    if (r?.items?.length) {
      picked = r.items;
      pickTabId = tab.tabId;
      renderPicked();
      setPicking(!!r.picking);
      hint('sendHint', `已恢复 ${picked.length} 个已选元素`, 'ok');
    }
  } catch { /* 页面没注入脚本就算了 */ }
}

init();
