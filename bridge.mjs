#!/usr/bin/env node
/**
 * annotation-bridge v0.2 —— 把网页标注投递到 Codex / Claude / DSH 会话
 * 只用 Node 内置模块；DSH 的 zstd 会话调用系统 zstd 命令。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const PORT = Number(process.env.BRIDGE_PORT || 47391);
const DRY_RUN = process.env.DRY_RUN === '1';
const HOME = os.homedir();
const VERSION = '0.2.0';

// Chrome / Finder 拉起的进程 PATH 往往只有 /usr/bin:/bin，补上常见安装位置，
// 否则 codex / node / zstd 全都“找不到”，面板里工具会变灰。
const EXTRA_PATH = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
process.env.PATH = [...new Set([...(process.env.PATH || '').split(':').filter(Boolean), ...EXTRA_PATH])].join(':');

const BIN = {
  codex: process.env.CODEX_BIN || 'codex',
  claude: process.env.CLAUDE_BIN || 'claude',
  dsh: process.env.DSH_BIN || '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
};
const DIRS = {
  codex: path.join(HOME, '.codex', 'sessions'),
  claude: path.join(HOME, '.claude', 'projects'),
  dsh: path.join(HOME, '.dsh', 'sessions'),
};
const STATE = path.join(HOME, '.annotation-bridge');
const QUEUE_FILE = path.join(STATE, 'queue.json');
const CAP_DIR = path.join(STATE, 'captures');
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(CAP_DIR, { recursive: true });

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));
const uid = () => Math.random().toString(36).slice(2, 10);
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const which = (bin) => {
  if (bin.includes('/')) return exists(bin) ? bin : null;
  try { return execFileSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim() || null; } catch { return null; }
};
function headText(f, n = 262144) {
  let fd; try {
    fd = fs.openSync(f, 'r'); const b = Buffer.alloc(n);
    const r = fs.readSync(fd, b, 0, n, 0); return b.subarray(0, r).toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
function tailText(f, n = 262144) {
  let fd; try {
    const size = fs.statSync(f).size, start = Math.max(0, size - n);
    fd = fs.openSync(f, 'r'); const b = Buffer.alloc(size - start);
    fs.readSync(fd, b, 0, b.length, start); return b.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
const parseLines = (t) => t.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const fmt = (ms) => new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

// ── Codex ─────────────────────────────────────────────
const codex = {
  id: 'codex', label: 'Codex',
  models: ['gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-luna'],
  sendModes: [{ id: 'queue', label: '预提交·等当前任务结束' }, { id: 'resume', label: '立刻执行·续跑' }],

  files(limit = 600) {
    const out = [];
    let years = []; try { years = fs.readdirSync(DIRS.codex).sort().reverse(); } catch { return out; }
    outer: for (const y of years) {
      for (const m of fs.readdirSync(path.join(DIRS.codex, y)).sort().reverse()) {
        for (const d of fs.readdirSync(path.join(DIRS.codex, y, m)).sort().reverse()) {
          const dir = path.join(DIRS.codex, y, m, d);
          for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('rollout-')).sort().reverse()) {
            const full = path.join(dir, f);
            let st; try { st = fs.statSync(full); } catch { continue; }
            out.push({ file: full, mtime: st.mtimeMs, size: st.size, name: f });
            if (out.length >= limit) break outer;
          }
        }
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  },

  meta(s) {
    let meta = null, title = '';
    for (const d of parseLines(headText(s.file))) {
      const p = d.payload || {};
      if (d.type === 'session_meta' && !meta) meta = p;
      if (!title && d.type === 'response_item' && p.type === 'message' && p.role === 'user') {
        const t = (p.content || []).map((c) => c.text || '').join(' ').trim();
        if (t && !/^(#|\s*<|\s*\[)/.test(t) && !/AGENTS\.md instructions|skills_instructions/i.test(t)) {
          title = t.replace(/\s+/g, ' ').slice(0, 90);
        }
      }
      if (meta && title) break;
    }
    const id = meta?.session_id || meta?.id
      || (s.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/) || [])[1] || '';
    const cwd = meta?.cwd || '';
    const named = codexNames().get(id);   // 用户在 Codex 里起的名字优先
    return {
      tool: 'codex', id, cwd, project: cwd ? path.basename(cwd) : '(unknown)',
      title: named || title || `(${fmt(s.mtime)})`,
      name: named || '', firstMessage: title || '',
      mtime: s.mtime, size: s.size, file: s.file,
    };
  },

  sessions(limit) {
    const seen = new Set(), out = [];
    for (const s of this.files()) {
      const m = this.meta(s);
      if (!m.id || seen.has(m.id)) continue;
      seen.add(m.id); out.push(m);
      if (out.length >= limit) break;
    }
    return out;
  },

  messages(file, limit = 30) {
    const msgs = [], toolBuf = [];
    for (const d of parseLines(tailText(file, 524288))) {
      const p = d.payload || {};
      if (d.type === 'response_item' && p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
        const text = (p.content || []).map((c) => c.text || '').join('').trim();
        if (!text) continue;
        const ts = (p.internal_chat_message_metadata_passthrough?.create_time || 0) * 1000 || Date.parse(d.timestamp || '') || 0;
        msgs.push({ role: p.role, text, ts, phase: p.phase || '', tools: toolBuf.splice(0) });
      }
      if (d.type === 'response_item' && (p.type === 'custom_tool_call' || p.type === 'function_call')) {
        let a = p.input || p.arguments || '';
        if (typeof a === 'object') a = JSON.stringify(a);
        toolBuf.push({ name: p.name || p.tool_name || 'tool', args: String(a).slice(0, 160) });
      }
    }
    const seen = new Set(), uniq = [];
    for (const m of msgs) {
      const k = m.role + m.ts + m.text.slice(0, 40);
      if (seen.has(k)) continue; seen.add(k); uniq.push(m);
    }
    return uniq.slice(-limit);
  },

  /** 新建会话并跑第一轮，返回 threadId 与回复 */
  async createSession({ cwd, model, effort, message }) {
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd || process.cwd()];
    if (model) args.push('-m', model);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    args.push('-');
    const r = await execFileP(BIN.codex, args, { timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, input: message });
    let threadId = '', text = '';
    for (const line of (r.stdout || '').split('\n')) {
      if (!line.trim()) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (d.type === 'thread.started' && d.thread_id) threadId = d.thread_id;
      if (d.type === 'item.completed' && d.item?.type === 'agent_message') text += (d.item.text || '');
    }
    return { threadId, replyText: text.trim(), model: model || '默认', effort: effort || '' };
  },

  async send({ thread, mode, model, effort, message, session, images }) {
    if (mode === 'resume') {
      const args = ['exec', 'resume', thread, '--skip-git-repo-check'];
      if (model) args.push('-m', model);
      if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
      for (const img of images || []) args.push('-i', img);   // 让模型直接看到截图
      args.push('-');
      const cwd = session?.cwd && exists(session.cwd) ? session.cwd : process.cwd();
      const r = await execFileP(BIN.codex, args, {
        timeout: 15 * 60 * 1000, maxBuffer: 32 * 1024 * 1024, input: message, cwd,
      });
      return { mode, model: model || '会话当前模型', effort: effort || '', replyText: (r.stdout || '').trim() };
    }
    // 不带 --resume：那一步会尝试把会话拉起来，可能卡几十秒；纯排队更快也更诚实
    const r = await execFileP(BIN.codex, ['queue', '--thread', thread, '--message', message],
      { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    // Codex 的队列只在回合正常结束时消费；看一眼还有几条在等，别让用户以为已送达
    await new Promise((res) => setTimeout(res, 400));
    return {
      mode: 'queue', model: '会话当前模型', effort: '',
      pendingCount: codexQueueCount(thread),
      stdout: (r.stdout || '').trim(),
    };
  },
};

// ── DSH ───────────────────────────────────────────────
const dsh = {
  id: 'dsh', label: 'DeepSeek Harness', models: [],
  sendModes: [{ id: 'headless', label: '续跑·默认模型' }],

  files(limit = 300) {
    const out = [];
    let roots = []; try { roots = fs.readdirSync(DIRS.dsh, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
    for (const r of roots) {
      const base = path.join(DIRS.dsh, r);
      let ss = []; try { ss = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('session-')).map((d) => d.name); } catch { continue; }
      for (const s of ss) {
        const dir = path.join(base, s);
        const file = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v4.jsonl'].map((f) => path.join(dir, f)).find(exists);
        if (!file) continue;
        let st; try { st = fs.statSync(file); } catch { continue; }
        out.push({ file, mtime: st.mtimeMs, size: st.size, id: s, root: r });
        if (out.length >= limit) break;
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  },

  raw(file) {
    if (file.endsWith('.zstd')) {
      try { return execFileSync('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' }); } catch { return ''; }
    }
    try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
  },

  meta(f) {
    let title = '', cwd = '', preset = '';
    for (const d of parseLines(this.raw(f.file))) {
      if (d.type === 'session') {
        if (d.cwd) cwd = d.cwd;
        if (d.agentPreset) preset = d.agentPreset;
      }
      if (d.type === 'agent-preset/selected' && d.data?.agentPreset) preset = d.data.agentPreset;
      if (!title && d.type === 'agent/inbox/spliced') {
        for (const it of d.data?.inserted || []) {
          if (it.role !== 'user') continue;
          const t = (it.content || []).map((c) => c.text || '').join(' ').trim();
          if (t) { title = t.replace(/\s+/g, ' ').slice(0, 90); break; }
        }
      }
      if (title && cwd) break;
    }
    const proj = cwd ? path.basename(cwd) : f.root.replace(/^--|--$/g, '').split('-').slice(-2).join('/');
    return { tool: 'dsh', id: f.id, cwd, project: proj || '(unknown)', title: title || `(${fmt(f.mtime)})`, mtime: f.mtime, size: f.size, file: f.file, preset };
  },

  sessions(limit) { return this.files().slice(0, limit).map((f) => this.meta(f)); },

  messages(file, limit = 30) {
    const msgs = [], toolBuf = [];
    for (const d of parseLines(this.raw(file))) {
      const data = d.data || {};
      if (d.type === 'agent/inbox/spliced') {
        for (const it of data.inserted || []) {
          if (it.role !== 'user') continue;
          const text = (it.content || []).map((c) => c.text || '').join('').trim();
          if (text) msgs.push({ role: 'user', text, ts: d.time || 0, tools: toolBuf.splice(0) });
        }
      }
      if (d.type === 'assistant/message') {
        const text = (data.content || []).map((c) => c.text || '').join('').trim() || (typeof data.text === 'string' ? data.text : '');
        if (text) msgs.push({ role: 'assistant', text, ts: d.time || 0, tools: toolBuf.splice(0) });
      }
      if (d.type === 'tool/call') {
        toolBuf.push({ name: data.name || 'tool', args: JSON.stringify(data.args || {}).slice(0, 160) });
      }
    }
    return msgs.slice(-limit);
  },

  async createSession({ cwd, message }) {
    const env = { ...process.env }; delete env.all_proxy; delete env.ALL_PROXY;
    const r = await execFileP(BIN.dsh, ['--profile', 'headless', '--json', message],
      { timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, env, cwd: cwd || process.cwd() });
    let threadId = '', text = '';
    for (const line of (r.stdout || '').split('\n')) {
      if (!line.trim()) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (d.type === 'session' && d.sessionId) threadId = d.sessionId;
      if (d.type === 'final' && typeof d.text === 'string') text = d.text;
    }
    return { threadId, replyText: text || (r.stdout || '').trim(), model: 'profile 默认' };
  },

  async send({ thread, message, session }) {
    // DSH 的一次性 runner 只能接管「没有 agent preset」的会话。
    // 网页/桌面里建的会话都带 preset（standard/cordis/...），headless 会直接拒绝。
    if (session?.preset) {
      const err = new Error(`这个 DSH 会话是在 GUI 里创建的（agent preset「${session.preset}」），headless 一次性 Runner 不能接管。\n` +
        `可以改用 Codex 投递，或者在 DSH 里新建一个会话再标注。`);
      err.code = 'DSH_PRESET';
      err.preset = session.preset;
      throw err;
    }
    const env = { ...process.env };
    delete env.all_proxy; delete env.ALL_PROXY;
    // headless 要求 cwd 和会话记录的一致，否则 assertAdoptable 直接拒绝
    const cwd = session?.cwd && exists(session.cwd) ? session.cwd : process.cwd();
    const r = await execFileP(BIN.dsh, ['--profile', 'headless', '--session-id', thread, message],
      { timeout: 15 * 60 * 1000, maxBuffer: 32 * 1024 * 1024, env, cwd });
    return { mode: 'headless', model: 'profile 默认', replyText: (r.stdout || '').trim() };
  },
};

// ── Claude ────────────────────────────────────────────
const claude = {
  id: 'claude', label: 'Claude Code',
  models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'],
  sendModes: [{ id: 'print', label: '续跑·换模型' }],

  files(limit = 300) {
    const out = [];
    let projs = []; try { projs = fs.readdirSync(DIRS.claude, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
    for (const p of projs) {
      const dir = path.join(DIRS.claude, p);
      let fs2 = []; try { fs2 = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of fs2) {
        const full = path.join(dir, f);
        let st; try { st = fs.statSync(full); } catch { continue; }
        out.push({ file: full, mtime: st.mtimeMs, size: st.size, id: f.replace(/\.jsonl$/, ''), dir: p });
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  },

  meta(f) {
    let title = '', cwd = '';
    for (const d of parseLines(headText(f.file, 65536))) {
      if (d.cwd && !cwd) cwd = d.cwd;
      if (!title && d.type === 'user' && d.message?.content) {
        const c = d.message.content;
        const t = Array.isArray(c) ? c.map((x) => x.text || '').join(' ') : String(c);
        if (t?.trim()) title = t.replace(/\s+/g, ' ').slice(0, 90);
      }
      if (title && cwd) break;
    }
    return { tool: 'claude', id: f.id, cwd, project: cwd ? path.basename(cwd) : f.dir, title: title || `(${fmt(f.mtime)})`, mtime: f.mtime, size: f.size, file: f.file };
  },

  sessions(limit) { return this.files().slice(0, limit).map((f) => this.meta(f)); },

  messages(file, limit = 30) {
    const msgs = [], toolBuf = [];
    for (const d of parseLines(tailText(file, 524288))) {
      const m = d.message;
      if (!m) continue;
      const content = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
      const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
      for (const c of content) if (c.type === 'tool_use') toolBuf.push({ name: c.name, args: JSON.stringify(c.input || {}).slice(0, 160) });
      if (text) msgs.push({ role: m.role, text, ts: Date.parse(d.timestamp || '') || 0, tools: toolBuf.splice(0) });
    }
    return msgs.slice(-limit);
  },

  async createSession({ cwd, model, message }) {
    const args = ['-p', message, '--output-format', 'json'];
    if (model) args.push('--model', model);
    const r = await execFileP(BIN.claude, args, { timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, cwd: cwd || process.cwd() });
    let threadId = '', text = (r.stdout || '').trim();
    try { const d = JSON.parse(text); threadId = d.session_id || ''; text = d.result || text; } catch {}
    return { threadId, replyText: text, model: model || '默认' };
  },

  async send({ thread, model, message }) {
    const args = ['--resume', thread, '-p', message];
    if (model) args.push('--model', model);
    const r = await execFileP(BIN.claude, args, { timeout: 15 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
    return { mode: 'print', model: model || '会话当前模型', replyText: (r.stdout || '').trim() };
  },
};

/** Codex 队列里这个会话还有几条没被消费（读它的 sqlite，只为给个诚实的提示） */
function codexQueueCount(thread) {
  try {
    const db = path.join(HOME, '.codex', 'queue_1.sqlite');
    if (!exists(db)) return null;
    const safe = String(thread).replace(/[^0-9a-fA-F-]/g, '');
    const out = execFileSync('/usr/bin/sqlite3', [db, `select count(*) from queued_items where thread_id='${safe}';`],
      { encoding: 'utf8', timeout: 2000 });
    return Number(out.trim()) || 0;
  } catch { return null; }
}

const TOOLS = { codex, claude, dsh };

// ── Codex 会话名（~/.codex/session_index.jsonl: {id, thread_name, updated_at}）──
const INDEX_FILE = path.join(HOME, '.codex', 'session_index.jsonl');
let nameIndex = { at: 0, map: new Map() };
function codexNames() {
  if (Date.now() - nameIndex.at < 5000 && nameIndex.map.size) return nameIndex.map;
  const map = new Map();
  try {
    for (const line of fs.readFileSync(INDEX_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const d = JSON.parse(line); if (d.id && d.thread_name) map.set(d.id, d.thread_name); } catch {}
    }
  } catch {}
  nameIndex = { at: Date.now(), map };
  return map;
}

// ── Codex 模型目录（动态，带每个模型支持的推理强度）──
let modelCatalog = { at: 0, models: [] };
function codexModels() {
  if (Date.now() - modelCatalog.at < 10 * 60 * 1000 && modelCatalog.models.length) return modelCatalog.models;
  try {
    const out = execFileSync(BIN.codex, ['debug', 'models'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const raw = JSON.parse(out);
    const models = (raw.models || [])
      .filter((m) => (m.visibility || 'list') === 'list')
      .map((m) => ({
        id: m.slug,
        label: m.display_name || m.slug,
        defaultLevel: m.default_reasoning_level || '',
        levels: (m.supported_reasoning_levels || []).map((l) => l.effort),
      }));
    modelCatalog = { at: Date.now(), models };
  } catch {
    modelCatalog = { at: Date.now(), models: [] };
  }
  return modelCatalog.models;
}

// ── 缓存与能力表 ──────────────────────────────────────
const cache = new Map();
function sessionsCached(tool, limit = 60) {
  const c = cache.get(tool);
  if (c && Date.now() - c.at < 5000 && c.list.length >= limit) return c.list.slice(0, limit);
  const list = TOOLS[tool]?.sessions(200) || [];
  cache.set(tool, { at: Date.now(), list });
  return list.slice(0, limit);
}
function toolsInfo() {
  return Object.values(TOOLS).map((t) => {
    const bin = which(BIN[t.id]);
    return {
      id: t.id, label: t.label, available: !!bin, binary: bin || BIN[t.id],
      models: t.id === 'codex' ? codexModels() : t.models.map((m) => ({ id: m, label: m, levels: [] })),
      efforts: t.id === 'codex' ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] : [],
      sendModes: t.sendModes,
      note: t.id === 'dsh' ? 'headless 无 model 参数，模型由 profile 决定'
        : t.id === 'claude' && !bin ? '未安装 claude CLI，只能读取历史' : '',
    };
  });
}

// ── 队列 ──────────────────────────────────────────────
const loadQueue = () => readJson(QUEUE_FILE, []);
const saveQueue = (q) => writeJson(QUEUE_FILE, q);

function composeMessage(items) {
  const url = items[0]?.url || '';
  const anyEl = items.some((it) => ((it.elements && it.elements.length) ? it.elements : [{ selector: it.selector, text: it.text }])
    .some((e) => e.selector || e.text));
  const out = [`【网页标注 · ${items.length} 条】${url ? ' 来源：' + url : ''}`, '',
    anyEl ? '我在页面上标了下面几处，请按选择器定位代码后逐条修改：' : '我没有指定具体元素，下面是整体备注，请结合页面判断该改哪里：', ''];
  items.forEach((it, i) => {
    const els = (it.elements && it.elements.length) ? it.elements : [{ selector: it.selector, text: it.text }];
    const hasEl = els.some((e) => e.selector || e.text);
    if (!hasEl) {
      out.push(`${i + 1}. （整页备注 · 没有指定具体元素）`);
    } else if (els.length === 1) {
      out.push(`${i + 1}. \`${els[0].selector || '(未取到选择器)'}\``);
      if (els[0].text) out.push(`   元素文本：${els[0].text.slice(0, 120)}`);
    } else {
      out.push(`${i + 1}. 涉及 ${els.length} 个元素：`);
      els.forEach((e, j) => {
        out.push(`   ${j + 1}) \`${e.selector || '(无)'}\`${e.text ? ` — ${e.text.slice(0, 60)}` : ''}`);
      });
    }
    if (it.severity) out.push(`   严重度：${it.severity}`);
    out.push(`   备注：${it.comment}`);
    for (const c of it.captures || []) {
      if (c.kind === 'screenshot') out.push(`   截图：${c.path}`);
      if (c.kind === 'console') {
        const bits = [`日志 ${c.count} 条`];
        if (c.netCount) bits.push(`请求 ${c.netCount}`);
        if (c.perfCount) bits.push(`资源耗时 ${c.perfCount} 条`);
        out.push(`   ${bits.join(' · ')}（${c.path}）`);
      }
    }
    out.push('');
  });
  const allCaps = items.flatMap((it) => it.captures || []);
  const consoles = allCaps.filter((c) => c.kind === 'console');
  if (consoles.length) {
    const lines = consoles[0].preview || [];
    out.push('## 页面日志 / 网络（错误与慢请求）');
    out.push(...lines.map((l) => `- ${l}`));
    out.push('');
  }
  if (allCaps.some((c) => c.kind === 'screenshot')) {
    out.push('截图文件可以直接打开看，路径在对应条目下面。');
    out.push('');
  }
  out.push('改完逐条说明改了什么。');
  return out.join('\n');
}

// ── 异步发送任务 ──────────────────────────────────────
// 发送可能跑几分钟（exec resume），不能把 HTTP 请求和面板按钮一起挂住：
// POST /send 立刻返回 job，面板轮询 GET /job 拿进度和结果。
const jobs = new Map();
let jobSeq = 0;
const sendingThreads = new Set();

function publicJob(j) {
  return {
    id: j.id, tool: j.tool, thread: j.thread, mode: j.mode, status: j.status,
    startedAt: j.startedAt, finishedAt: j.finishedAt, count: j.count,
    replyText: j.replyText || '', error: j.error || '',
    pendingCount: j.pendingCount, reason: j.reason, preset: j.preset,
  };
}
function createJob({ tool, thread, mode, count, startedAt, message }) {
  const id = `job-${++jobSeq}-${Date.now().toString(36)}`;
  const job = { id, tool, thread, mode, count, startedAt, status: 'running', message };
  jobs.set(id, job);
  return job;
}
function runJob(job, ctx) {
  sendingThreads.add(ctx.lockKey);
  job.done = (async () => {
    try {
      const r = await ctx.T.send({
        thread: ctx.thread, mode: ctx.mode, model: ctx.model,
        effort: ctx.effort, message: ctx.message, session: ctx.session, images: ctx.images,
      });
      saveQueue(loadQueue().filter((x) => !ctx.mine.some((m) => m.id === x.id)));
      job.status = 'done';
      job.finishedAt = Date.now();
      job.result = r;
      job.replyText = r.replyText || '';
      job.pendingCount = r.pendingCount;
    } catch (e) {
      job.status = 'error';
      job.finishedAt = Date.now();
      job.error = String(e?.stderr || e?.message || e).slice(0, 1200);
      if (e?.code === 'DSH_PRESET') { job.reason = 'preset'; job.preset = e.preset; }
    } finally {
      sendingThreads.delete(ctx.lockKey);
      setTimeout(() => jobs.delete(job.id), 30 * 60 * 1000).unref?.();
    }
  })();
}

// ── 扩展控制通道 ──────────────────────────────────────
// 桌面 app 点「打开面板」时往这里排一条命令；原生宿主每秒来取一次，
// 取到后用 stdout 推给扩展 service worker，由它开一个独立窗口。
let hostSeenAt = 0;          // 最近一次宿主来取命令的时间（≈ 扩展在线）
let commands = [];
const hostsOnline = () => Date.now() - hostSeenAt < 5000;

// ── HTTP ──────────────────────────────────────────────
const json = (res, code, obj) => {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 4e6) req.destroy(); });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;
  if (req.method === 'OPTIONS') return json(res, 204, {});
  try {
    if (p === '/health') return json(res, 200, { ok: true, port: PORT, dryRun: DRY_RUN, pid: process.pid, uptime: Math.round(process.uptime()), version: VERSION, extension: hostsOnline() });

    // 宿主每秒来取一次命令；同时充当「扩展在线」心跳
    if (p === '/command' && req.method === 'GET') {
      hostSeenAt = Date.now();
      const now = Date.now();
      commands = commands.filter((c) => now - c.at < 30000);   // 过期命令不补发，免得一开面板就弹一堆
      return json(res, 200, { command: commands.shift() || null });
    }

    // 桌面 app / 脚本：让 Chrome 里的扩展弹一个独立面板窗口
    if (p === '/open-panel' && req.method === 'POST') {
      commands.push({ type: 'OPEN_PANEL', at: Date.now() });
      if (commands.length > 8) commands = commands.slice(-8);
      return json(res, 200, { ok: true, extension: hostsOnline() });
    }

    // 供桌面 app / 脚本干净地停掉服务（仅本机可访问）
    if (p === '/shutdown' && req.method === 'POST') {
      json(res, 200, { ok: true, stopping: true, pid: process.pid });
      setTimeout(() => process.exit(0), 120);
      return;
    }
    if (p === '/tools') return json(res, 200, { tools: toolsInfo(), dryRun: DRY_RUN });

    if (p === '/sessions') {
      const tool = u.searchParams.get('tool') || 'codex';
      if (!TOOLS[tool]) return json(res, 400, { error: 'unknown tool' });
      const limit = Math.min(Number(u.searchParams.get('limit') || 60), 200);
      const t0 = Date.now();
      return json(res, 200, { tool, sessions: sessionsCached(tool, limit), ms: Date.now() - t0 });
    }

    if (p === '/messages') {
      const tool = u.searchParams.get('tool') || 'codex';
      const thread = u.searchParams.get('thread');
      const limit = Math.min(Number(u.searchParams.get('limit') || 20), 100);
      const s = sessionsCached(tool, 200).find((x) => x.id === thread);
      if (!s) return json(res, 404, { error: 'session not found' });
      return json(res, 200, { thread, messages: TOOLS[tool].messages(s.file, limit) });
    }

    if (p === '/new-session' && req.method === 'POST') {
      const b = await readBody(req);
      const tool = b.tool || 'codex';
      const T = TOOLS[tool];
      if (!T?.createSession) return json(res, 400, { error: 'unsupported tool' });
      if (!b.message?.trim()) return json(res, 400, { error: 'message required' });
      if (DRY_RUN) return json(res, 200, { ok: true, dryRun: true, wouldRun: `new ${tool} session in ${b.cwd || '.'}` });
      try {
        const r = await T.createSession({ cwd: b.cwd, model: b.model, effort: b.effort, message: b.message });
        cache.delete(tool);
        return json(res, 200, { ok: true, tool, ...r });
      } catch (e) {
        return json(res, 502, { ok: false, error: String(e?.stderr || e?.message || e).slice(0, 1500) });
      }
    }

    if (p === '/capture/data') {
      const id = String(u.searchParams.get('id') || '').replace(/[^a-z0-9]/gi, '');
      const pngFile = path.join(CAP_DIR, `${id}.png`);
      const jsonFile = path.join(CAP_DIR, `${id}.json`);
      if (exists(pngFile)) return json(res, 200, { kind: 'screenshot', dataUrl: `data:image/png;base64,${fs.readFileSync(pngFile).toString('base64')}` });
      if (exists(jsonFile)) return json(res, 200, { kind: 'console', text: fs.readFileSync(jsonFile, 'utf8') });
      return json(res, 404, { error: 'capture not found' });
    }

    if (p === '/capture/file') {
      const id = String(u.searchParams.get('id') || '').replace(/[^a-z0-9]/gi, '');
      if (!id) return json(res, 400, { error: 'id required' });
      for (const ext of ['png', 'json']) {
        const f = path.join(CAP_DIR, `${id}.${ext}`);
        if (exists(f)) {
          const buf = fs.readFileSync(f);
          res.writeHead(200, {
            'content-type': ext === 'png' ? 'image/png' : 'application/json; charset=utf-8',
            'access-control-allow-origin': '*', 'cache-control': 'max-age=300',
          });
          return res.end(buf);
        }
      }
      return json(res, 404, { error: 'capture not found' });
    }

    if (p === '/capture' && req.method === 'POST') {
      const b = await readBody(req);
      const id = uid();
      const ts = Date.now();
      if (b.kind === 'screenshot' && b.dataUrl) {
        const b64 = String(b.dataUrl).replace(/^data:image\/\w+;base64,/, '');
        const file = path.join(CAP_DIR, `${id}.png`);
        fs.writeFileSync(file, Buffer.from(b64, 'base64'));
        return json(res, 200, { id, kind: 'screenshot', path: file, url: `/capture/file?id=${id}`, ts });
      }
      if (b.kind === 'console') {
        const logs = Array.isArray(b.logs) ? b.logs.slice(-80) : [];
        const net = Array.isArray(b.net) ? b.net.slice(-50) : [];
        // performance API 拿到的「页面已经发过的请求」：注入前发生的也有，用来定位慢接口
        const perf = b.perf && typeof b.perf === 'object' ? {
          resources: Array.isArray(b.perf.resources) ? b.perf.resources.slice(0, 60) : [],
          total: Number(b.perf.total) || 0,
          nav: b.perf.nav || null,
        } : null;
        const file = path.join(CAP_DIR, `${id}.json`);
        fs.writeFileSync(file, JSON.stringify({ logs, net, perf }, null, 2));

        const resources = perf?.resources || [];
        const slow = resources.filter((r) => (r.ms || 0) >= 300).slice(0, 8);
        const preview = [
          ...(perf?.nav ? [`[页面] TTFB ${perf.nav.ttfb}ms · DCL ${perf.nav.dcl}ms · load ${perf.nav.load}ms`] : []),
          ...slow.map((r) => `[慢 ${r.ms}ms] ${r.type || 'request'} ${String(r.url).slice(0, 140)}${r.status ? ` (${r.status})` : ''}`),
          ...logs.filter((l) => l.level === 'error' || l.level === 'warn')
            .slice(-6).map((l) => `[${l.level}] ${String(l.text).slice(0, 160)}`),
          ...net.filter((n) => !n.ok)
            .slice(-6).map((n) => `[网络 ${n.status || 'ERR'}] ${n.method} ${n.url}${n.ms ? ` (${n.ms}ms)` : ''}`),
        ].slice(0, 24);

        return json(res, 200, {
          id, kind: 'console', path: file, url: `/capture/file?id=${id}`,
          count: logs.length, netCount: net.length,
          perfCount: resources.length, perfTotal: perf?.total || 0,
          preview, ts,
        });
      }
      return json(res, 400, { error: 'unknown capture kind' });
    }

    if (p === '/queue' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.thread) return json(res, 400, { error: 'thread required' });
      if (!b.comment?.trim()) return json(res, 400, { error: 'comment required' });
      const q = loadQueue();
      const item = {
        id: uid(), tool: b.tool || 'codex', thread: b.thread, comment: String(b.comment).trim(),
        selector: b.selector || '', text: b.text || '', url: b.url || '',
        severity: b.severity || 'important', createdAt: Date.now(),
        captures: Array.isArray(b.captures) ? b.captures : [],
        elements: Array.isArray(b.elements) ? b.elements : [],
      };
      q.push(item); saveQueue(q);
      return json(res, 200, { item, count: q.length });
    }

    // 只生成消息、不投递：给不能 headless 接管的会话（DSH GUI）复制用
    if (p === '/compose' && req.method === 'POST') {
      const b = await readBody(req);
      const tool = b.tool || 'codex';
      if (!b.thread) return json(res, 400, { error: 'thread required' });
      let mine = loadQueue().filter((x) => x.thread === b.thread && (x.tool || 'codex') === tool);
      if (b.ids?.length) mine = mine.filter((x) => b.ids.includes(x.id));
      if (!mine.length) return json(res, 400, { error: '这个会话的队列是空的' });
      return json(res, 200, { ok: true, count: mine.length, message: composeMessage(mine) });
    }

    if (p === '/queue' && req.method === 'GET') {
      const thread = u.searchParams.get('thread');
      const tool = u.searchParams.get('tool');
      if (!thread) return json(res, 400, { error: 'thread required（队列按会话隔离）' });
      const q = loadQueue().filter((x) => x.thread === thread && (!tool || (x.tool || 'codex') === tool));
      return json(res, 200, { queue: q });
    }

    // 每个会话的待发条数，供会话列表打角标
    if (p === '/queue/summary' && req.method === 'GET') {
      const out = {};
      for (const it of loadQueue()) {
        const k = `${it.tool || 'codex'}|${it.thread}`;
        out[k] = (out[k] || 0) + 1;
      }
      return json(res, 200, { counts: out });
    }

    // 只删一条
    if (p === '/queue/remove' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.id) return json(res, 400, { error: 'id required' });
      const q = loadQueue();
      const rest = q.filter((x) => x.id !== b.id);
      saveQueue(rest);
      return json(res, 200, { removed: q.length - rest.length, left: rest.length });
    }

    if (p === '/queue/clear' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.thread) return json(res, 400, { error: 'thread required（不支持清空全部）' });
      const q = loadQueue();
      const rest = q.filter((x) => !(x.thread === b.thread && (!b.tool || (x.tool || 'codex') === b.tool)));
      saveQueue(rest);
      return json(res, 200, { removed: q.length - rest.length });
    }

    if (p === '/send' && req.method === 'POST') {
      const b = await readBody(req);
      const tool = b.tool || 'codex';
      const T = TOOLS[tool];
      if (!T) return json(res, 400, { error: 'unknown tool' });
      if (!b.thread) return json(res, 400, { error: 'thread required' });

      const q = loadQueue();
      let mine = q.filter((x) => x.thread === b.thread && (x.tool || 'codex') === tool);
      if (b.ids?.length) mine = mine.filter((x) => b.ids.includes(x.id));
      const running = [...jobs.values()].find((j) => j.thread === b.thread && j.tool === tool && j.status === 'running');
      if (!mine.length) {
        if (running) return json(res, 200, { ok: true, job: publicJob(running), count: running.count });
        return json(res, 400, { error: '这个会话的队列是空的（队列按会话隔离）' });
      }
      if (running) {
        return json(res, 409, { ok: false, reason: 'busy', error: '上一条还在执行（同一个会话一次只能跑一个）', job: publicJob(running) });
      }

      const session = sessionsCached(tool, 200).find((x) => x.id === b.thread) || {};
      const images = mine
        .flatMap((it) => it.captures || [])
        .filter((c) => c.kind === 'screenshot' && c.path && typeof c.path === 'string')
        .map((c) => c.path)
        .filter((p) => exists(p))
        .slice(0, 6);
      const message = composeMessage(mine);
      const startedAt = Date.now();

      if (DRY_RUN) {
        const willRun = tool === 'codex'
          ? ['exec', 'resume', '<thread>', ...(b.model ? ['-m', b.model] : []),
             ...(b.effort ? ['-c', `model_reasoning_effort="${b.effort}"`] : []),
             ...images.flatMap((p) => ['-i', p]), '-']
          : ['queue', '--thread', '<thread>', '--message', '<text>'];
        return json(res, 200, { ok: true, dryRun: true, tool, mode: b.mode, model: b.model, effort: b.effort, count: mine.length, startedAt, message, images, willRun });
      }

      const job = createJob({ tool, thread: b.thread, mode: b.mode || 'resume', count: mine.length, startedAt, message });
      runJob(job, {
        T, thread: b.thread, mode: b.mode, model: b.model, effort: b.effort,
        message, session, images, mine, lockKey: `${tool}|${b.thread}`,
      });

      if (b.wait) {
        await job.done;
        if (job.status === 'done') return json(res, 200, { ok: true, tool, count: job.count, startedAt, message, ...job.result });
        return json(res, job.reason === 'preset' ? 409 : 502, {
          ok: false, tool, count: job.count, startedAt, message,
          error: job.error,
          ...(job.reason ? { reason: job.reason } : {}),
          ...(job.preset ? { preset: job.preset } : {}),
        });
      }
      return json(res, 200, { ok: true, job: publicJob(job), count: job.count, message });
    }

    if (p === '/job' && req.method === 'GET') {
      const id = u.searchParams.get('id');
      const thread = u.searchParams.get('thread');
      if (id) {
        const j = jobs.get(id);
        return j ? json(res, 200, { job: publicJob(j) }) : json(res, 404, { error: 'job not found' });
      }
      if (thread) {
        const list = [...jobs.values()]
          .filter((j) => j.thread === thread && (!u.searchParams.get('tool') || j.tool === u.searchParams.get('tool')))
          .sort((a, b2) => b2.startedAt - a.startedAt);
        return json(res, 200, { job: list[0] ? publicJob(list[0]) : null });
      }
      return json(res, 400, { error: 'id or thread required' });
    }

    if (p === '/reply') {
      const tool = u.searchParams.get('tool') || 'codex';
      const thread = u.searchParams.get('thread');
      const since = Number(u.searchParams.get('since') || 0);
      const s = sessionsCached(tool, 200).find((x) => x.id === thread);
      if (!s) return json(res, 404, { error: 'session not found' });
      const fresh = TOOLS[tool].messages(s.file, 60).filter((m) => m.ts > since);
      return json(res, 200, { thread, since, messages: fresh, hasAssistant: fresh.some((m) => m.role === 'assistant') });
    }

    return json(res, 404, { error: 'not found', path: p });
  } catch (e) {
    return json(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[annotation-bridge] http://127.0.0.1:${PORT}  dryRun=${DRY_RUN}`);
  for (const t of toolsInfo()) console.log(`  ${t.available ? '✓' : '✗'} ${t.label}  ${t.binary}`);
});
