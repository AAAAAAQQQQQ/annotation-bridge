const $ = (id) => document.getElementById(id);
const K_TOOL = 'toolV3', K_THREAD = 'threadV3', K_CWD = 'cwdV3';

let bridge = 'http://127.0.0.1:47391';
let captures = [];   // 待随下一条标注一起发送的截图/控制台
let tools = [], tool = 'codex', sessions = [], selected = null, picked = null, pollTimer = null;

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const meta = () => tools.find((t) => t.id === tool) || {};

async function api(path, opts = {}) {
  const res = await fetch(bridge + path, { headers: { 'content-type': 'application/json' }, ...opts });
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}
function setStatus(ok, t) { $('status').classList.toggle('ok', !!ok); $('statusText').textContent = t; }
function hint(el, t, kind = '') { const n = $(el); n.className = 'hint ' + kind; n.textContent = t; n.classList.toggle('hidden', !t); }
function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return '刚刚'; if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60); return h < 24 ? `${h} 小时前` : `${Math.floor(h / 24)} 天前`;
}

// ── 工具页签 ──
function renderTabs() {
  $('toolTabs').innerHTML = tools.map((t) => `
    <div class="tool ${t.id === tool ? 'active' : ''} ${t.available ? '' : 'off'}" data-id="${t.id}"
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
  if (!selected) {
    $('selTitle').textContent = '未选择会话';
    $('selSub').textContent = '点这里选一个正在用的会话';
    return;
  }
  $('selTitle').textContent = selected.title || String(selected.id).slice(0, 8);
  $('selSub').textContent = `${selected.project || ''} · ${String(selected.id).slice(0, 8)}`;
}

function renderList() {
  const q = ($('search').value || '').trim().toLowerCase();
  const list = !q ? sessions : sessions.filter((s) => [s.title, s.project, s.id, s.cwd].join(' ').toLowerCase().includes(q));
  const box = $('sessionList');
  if (!list.length) { box.innerHTML = `<div class="pop-empty">${sessions.length ? '没有匹配' : '还没有会话'}</div>`; return; }
  box.innerHTML = list.map((s) => `
    <div class="pop-item ${selected?.id === s.id ? 'active' : ''}" data-id="${s.id}">
      <b>${esc(s.title || String(s.id).slice(0, 8))}</b>
      <small>${esc(s.project || '')} · ${String(s.id).slice(0, 8)} · ${ago(s.mtime)}</small>
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
  $('sessionPop').classList.add('hidden');
  $('messages').innerHTML = '<div class="empty">发送后这里会显示回复</div>';
  loadQueue();
}

async function loadSessions() {
  try {
    const d = await api(`/sessions?tool=${tool}&limit=60`);
    sessions = d.sessions || [];
    renderList();
    setStatus(true, `${sessions.length} 个会话`);
  } catch (e) {
    setStatus(false, '连接失败');
    $('sessionList').innerHTML = '<div class="pop-empty">连不上 bridge<br/>先运行 ./start.sh</div>';
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
  fill('model', [{ value: '', label: '默认' }, ...(m.models || []).map((x) => ({ value: x.id, label: x.label || x.id }))]);
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
const activeTab = () => new Promise((r) => chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' }, r));
async function ensureContent(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { type: 'PING' }); return true; }
  catch { try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); return true; } catch { return false; } }
}
async function startPick() {
  const tab = await activeTab();
  if (!tab?.tabId) return hint('sendHint', '没有可用的标签页', 'err');
  if (!(await ensureContent(tab.tabId))) return hint('sendHint', '这个页面不允许注入脚本', 'err');
  await chrome.tabs.sendMessage(tab.tabId, { type: 'START_PICK' });
  hint('sendHint', '已进入拾取模式：回页面点一个元素，Esc 取消');
}
function renderPicked() {
  if (!picked) { $('pickedBox').classList.add('hidden'); return; }
  $('pickedBox').classList.remove('hidden');
  $('pickedSel').textContent = picked.selector;
  $('pickedTxt').textContent = [picked.tag, picked.text?.slice(0, 80)].filter(Boolean).join(' · ');
}

// ── 采集附件 ──
function renderCaps() {
  const box = $('capsChips');
  if (!captures.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = captures.map((c, i) => `
    <span class="chip">${c.kind === 'screenshot' ? '📷 截图' : '🖥 控制台 ' + c.count + ' 条'}<span class="x" data-i="${i}">✕</span></span>`).join('');
  box.querySelectorAll('.x').forEach((el) => el.addEventListener('click', () => {
    captures.splice(Number(el.dataset.i), 1); renderCaps();
  }));
}

async function grabConsole(silent) {
  const tab = await activeTab();
  if (!tab?.tabId) return;
  if (!(await ensureContent(tab.tabId))) return;
  try {
    const r = await chrome.tabs.sendMessage(tab.tabId, { type: 'GET_LOGS' });
    $('consoleCount').textContent = `${r?.total ?? 0} 条`;
    if (!silent) {
      if (!r?.total) return hint('sendHint', '这个页面还没有捕获到日志', '');
      const d = await api('/capture', { method: 'POST', body: JSON.stringify({ kind: 'console', logs: r.logs }) });
      captures.push({ kind: 'console', count: d.count, path: d.path, preview: d.preview });
      renderCaps();
      hint('sendHint', `已附上 ${d.count} 条控制台日志`, 'ok');
    }
  } catch (e) { if (!silent) hint('sendHint', '抓取失败：' + e.message, 'err'); }
}

async function takeShot() {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    const d = await api('/capture', { method: 'POST', body: JSON.stringify({ kind: 'screenshot', dataUrl }) });
    captures.push({ kind: 'screenshot', path: d.path });
    renderCaps();
    hint('sendHint', '已截图，会随下一条标注一起发', 'ok');
  } catch (e) { hint('sendHint', '截图失败：' + e.message, 'err'); }
}

// ── 队列 ──
async function loadQueue() {
  if (!selected) { $('queueCount').textContent = '0'; $('queue').innerHTML = '<div class="empty">还没选会话</div>'; return; }
  try {
    const d = await api(`/queue?thread=${encodeURIComponent(selected.id)}`);
    const q = d.queue || [];
    $('queueCount').textContent = String(q.length);
    $('queue').innerHTML = q.length ? q.map((it) => `
      <div class="qitem"><span class="x" data-del="1">✕</span>
        <div class="c">${esc(it.comment)}</div>
        <div class="s">${esc(it.selector || '(无选择器)')}</div></div>`).join('')
      : '<div class="empty">队列是空的</div>';
    $('queue').querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', async () => {
      await api('/queue/clear', { method: 'POST', body: JSON.stringify({ thread: selected.id }) });
      await loadQueue();
    }));
  } catch (e) { hint('sendHint', '读队列失败：' + e.message, 'err'); }
}

async function addToQueue() {
  if (!selected) return hint('sendHint', '先选一个目标会话', 'err');
  const comment = $('comment').value.trim();
  if (!comment) return hint('sendHint', '先写一句备注', 'err');
  if (!picked) return hint('sendHint', '先在页面上选一个元素', 'err');
  try {
    if ($('capConsole').checked) await grabConsole(true);
    await api('/queue', { method: 'POST', body: JSON.stringify({
      tool, thread: selected.id, comment, selector: picked.selector,
      text: picked.text, url: picked.url, severity: $('severity').value,
      captures: captures.slice() }) });
    captures = []; renderCaps();
    $('comment').value = ''; $('comment').focus();
    hint('sendHint', '已加入队列', 'ok');
    await loadQueue();
  } catch (e) { hint('sendHint', '入队失败：' + e.message, 'err'); }
}

async function sendAll() {
  if (!selected) return hint('sendHint', '先选一个目标会话', 'err');
  $('btnSend').disabled = true;
  hint('sendHint', '发送中…');
  const startedAt = Date.now();
  try {
    const d = await api('/send', { method: 'POST', body: JSON.stringify({
      tool, thread: selected.id, mode: $('mode').value,
      model: $('model').value || undefined, effort: $('effort').value || undefined }) });
    if (d.dryRun) hint('sendHint', `DRY_RUN：已生成 ${d.count} 条，未真正投递`, 'ok');
    else hint('sendHint', `已投递 ${d.count} 条 · ${d.mode}${d.effort ? ' · ' + d.effort : ''}`, 'ok');
    await loadQueue();
    if (d.replyText) { appendMessages([{ role: 'assistant', text: d.replyText, tools: [] }]); hint('sendHint', '已返回结果', 'ok'); }
    else pollReply(startedAt);
  } catch (e) { hint('sendHint', '发送失败：' + e.message, 'err'); }
  finally { $('btnSend').disabled = false; }
}

// ── 消息 ──
function appendMessages(list) {
  const box = $('messages');
  box.querySelector('.empty')?.remove();
  for (const m of list) {
    const div = document.createElement('div');
    div.className = `msg ${m.role}`;
    const chain = m.tools?.length
      ? `<div class="chain">${m.tools.map((t) => `<div class="call">→ <b>${esc(t.name)}</b> ${esc(t.args || '')}</div>`).join('')}</div>` : '';
    div.innerHTML = `<div class="who">${m.role === 'assistant' ? esc(meta().label || tool) : '我'}</div>${esc(m.text)}${chain}`;
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}

async function loadRecent() {
  if (!selected) return hint('sendHint', '先选一个目标会话', 'err');
  try {
    const d = await api(`/messages?tool=${tool}&thread=${encodeURIComponent(selected.id)}&limit=12`);
    $('messages').innerHTML = '';
    appendMessages(d.messages || []);
    if (!d.messages?.length) $('messages').innerHTML = '<div class="empty">没有历史消息</div>';
  } catch (e) { hint('sendHint', '读消息失败：' + e.message, 'err'); }
}

function pollReply(since) {
  clearInterval(pollTimer);
  let ticks = 0; const seen = new Set();
  pollTimer = setInterval(async () => {
    if (++ticks > 90) { clearInterval(pollTimer); return hint('sendHint', '停止等待（3 分钟）'); }
    try {
      const d = await api(`/reply?tool=${tool}&thread=${encodeURIComponent(selected.id)}&since=${since}`);
      const fresh = (d.messages || []).filter((m) => m.role === 'assistant' && !seen.has(m.ts + m.text.slice(0, 16)));
      if (fresh.length) { fresh.forEach((m) => seen.add(m.ts + m.text.slice(0, 16))); appendMessages(fresh); hint('sendHint', '收到回复', 'ok'); clearInterval(pollTimer); }
    } catch {}
  }, 2000);
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
  } catch (e) { hint('newHint', '创建失败：' + e.message, 'err'); }
  finally { $('btnNewRun').disabled = false; }
}

// ── 绑定 ──
function bind() {
  $('btnRefresh').addEventListener('click', loadSessions);
  $('btnSession').addEventListener('click', () => {
    const pop = $('sessionPop');
    pop.classList.toggle('hidden');
    if (!pop.classList.contains('hidden')) { renderList(); $('search').focus(); }
  });
  $('search').addEventListener('input', renderList);
  $('btnUseId').addEventListener('click', () => {
    const id = $('manualId').value.trim();
    if (id.length < 8) return hint('sendHint', '会话 ID 看起来不对', 'err');
    select({ id, title: id.slice(0, 10), project: '(手动)', mtime: Date.now() });
    $('manualId').value = '';
  });
  $('btnPick').addEventListener('click', startPick);
  $('btnShot').addEventListener('click', takeShot);
  $('btnGrabLogs').addEventListener('click', () => grabConsole(false));
  $('btnClearCaps').addEventListener('click', () => { captures = []; renderCaps(); $('consoleCount').textContent = '0 条'; });
  $('capConsole').addEventListener('change', (e) => chrome.storage.local.set({ capConsole: e.target.checked }));
  $('btnQueue').addEventListener('click', addToQueue);
  $('btnSend').addEventListener('click', sendAll);
  $('btnLoadMsgs').addEventListener('click', loadRecent);
  $('btnClearQueue').addEventListener('click', async () => {
    if (!selected) return;
    await api('/queue/clear', { method: 'POST', body: JSON.stringify({ thread: selected.id }) });
    await loadQueue();
  });
  $('mode').addEventListener('change', syncOpts);
  $('model').addEventListener('change', () => { renderEfforts('model', 'effort'); syncOpts(); });
  $('newModel').addEventListener('change', () => renderEfforts('newModel', 'newEffort'));
  $('btnNew').addEventListener('click', openNew);
  $('btnNewClose').addEventListener('click', () => $('newModal').classList.add('hidden'));
  $('btnNewRun').addEventListener('click', runNew);
  $('newModal').addEventListener('click', (e) => { if (e.target.id === 'newModal') $('newModal').classList.add('hidden'); });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'ELEMENT_PICKED') { picked = msg.payload; renderPicked(); hint('sendHint', '已选中元素，写备注吧', 'ok'); }
    if (msg?.type === 'PICK_CANCELLED') hint('sendHint', '已取消拾取');
  });
}

async function init() {
  bind();
  $('bridgeInfo').textContent = 'bridge · ' + bridge.replace(/^https?:\/\//, '');
  const st = await chrome.storage.local.get([K_TOOL, K_THREAD]);
  if (st[K_TOOL]) tool = st[K_TOOL];
  renderPicked();
  try { tools = (await api('/tools')).tools || []; }
  catch { hint('sendHint', '连不上 bridge，先运行 ./start.sh', 'err'); tools = [{ id: 'codex', label: 'Codex', available: true, models: [], sendModes: [] }]; }
  if (!tools.find((t) => t.id === tool)?.available) tool = tools.find((t) => t.available)?.id || 'codex';
  renderTabs(); renderOpts(); renderCaps();
  const pref = await chrome.storage.local.get(['capConsole']);
  if (pref.capConsole === false) $('capConsole').checked = false;
  grabConsole(true);
  if (st[K_THREAD] && st[K_THREAD].tool === tool) { selected = st[K_THREAD]; updateSelectedUI(); }
  await loadSessions();
  await loadQueue();
}

init();
