#!/usr/bin/env node
/**
 * Chrome Native Messaging host。
 * Chrome 用 stdio + 4 字节长度前缀的 JSON 跟它通信。
 * 它把请求转发给本地 bridge（HTTP），bridge 没起就自己拉起来。
 * 扩展 → 原生消息 → 本进程 → 127.0.0.1:47391，全程不经过浏览器网络层，LNA 管不到。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.BRIDGE_PORT || 47391);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.env.NODE_BIN || process.execPath;
const LOG = path.join(os.homedir(), 'Library', 'Logs', 'annotation-bridge-native.log');

function log(msg) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([len, body]));
}

async function healthy() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch { return false; }
}

let starting = null;
async function ensureBridge() {
  if (await healthy()) return true;
  if (!starting) {
    starting = (async () => {
      log('bridge 未运行，尝试拉起');
      const out = fs.openSync(LOG, 'a');
      // Chrome 从 Dock 启动时 PATH 很干净，补上常见安装位置，
      // 不然 bridge 里 codex / zstd 会找不到。
      const env = {
        ...process.env,
        PATH: [...new Set([...(process.env.PATH || '').split(':').filter(Boolean),
          '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':'),
      };
      const child = spawn(NODE, [path.join(ROOT, 'bridge.mjs')], {
        cwd: ROOT, detached: true, stdio: ['ignore', out, out], env,
      });
      child.unref();
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (await healthy()) { log(`bridge 已启动 pid=${child.pid} port=${PORT}`); return true; }
      }
      log('bridge 启动失败');
      return false;
    })();
  }
  const ok = await starting;
  starting = null;
  return ok;
}

async function forward({ method = 'GET', path: p, body }) {
  const t0 = Date.now();
  const ok = await ensureBridge();
  if (!ok) throw new Error('本地服务启动失败，请看 ~/Library/Logs/annotation-bridge-native.log');
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  log(`${method} ${p} → ${res.status} (${Date.now() - t0}ms)`);
  return { status: res.status, data };
}

log(`host 启动 pid=${process.pid} node=${NODE}`);

// ── stdio 协议 ──
let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = buf.subarray(4, 4 + len).toString('utf8');
    buf = buf.subarray(4 + len);
    let req; try { req = JSON.parse(msg); } catch { continue; }
    (async () => {
      try {
        const r = await forward(req);
        send({ id: req.id, ok: r.status < 400, ...r });
      } catch (e) {
        log('forward 失败: ' + e.message);
        send({ id: req.id, ok: false, status: 0, data: { error: String(e.message || e) } });
      }
    })();
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', (e) => log('uncaught: ' + e.message));

// ── 命令通道 ──
// 桌面 app 点「打开面板」→ bridge 排队 OPEN_PANEL → 这里取到后推给扩展。
// 注意：这里不 ensureBridge，避免用户刚点「停止服务」又立刻被拉起来。
let polling = false;
async function pollCommands() {
  if (polling) return;
  polling = true;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/command`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) {
      const d = await r.json();
      if (d.command) {
        log(`推送命令 ${d.command.type}`);
        send({ type: 'COMMAND', command: d.command.type });
      }
    }
  } catch { /* bridge 没起就安静跳过 */ }
  finally { polling = false; }
}
setInterval(pollCommands, 1000).unref();
