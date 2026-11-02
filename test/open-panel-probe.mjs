/**
 * 「桌面 app 唤起面板」端到端测试。
 *
 *   桌面 app → POST /open-panel → bridge 排队命令
 *   → 原生宿主每秒取一次 → stdout 推给扩展 service worker
 *   → chrome.windows.create(popup) 弹出独立面板窗口
 *
 * 跑法：node test/open-panel-probe.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const EXT = path.join(ROOT, 'extension');
const CHROME = process.env.CHROME_BIN
  || path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const DEBUG_PORT = 9783;
const BRIDGE_PORT = Number(process.env.TEST_BRIDGE_PORT || 47393);
const PROFILE = '/tmp/annotation-bridge-openprofile';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const extId = (() => {
  const h = crypto.createHash('sha256').update(EXT).digest('hex').slice(0, 32);
  return [...h].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
})();
const health = async () => {
  try { return await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`, { signal: AbortSignal.timeout(1000) })).json(); }
  catch { return null; }
};

// ── 1. 起 bridge（新代码）────────────────────────────
try { await fetch(`http://127.0.0.1:${BRIDGE_PORT}/shutdown`, { method: 'POST' }); } catch {}
await sleep(300);
const bridge = spawn(process.execPath, [path.join(ROOT, 'bridge.mjs')], {
  cwd: ROOT, env: { ...process.env, BRIDGE_PORT: String(BRIDGE_PORT) }, stdio: 'ignore',
});
let h = null;
for (let i = 0; i < 20 && !h?.ok; i++) { await sleep(250); h = await health(); }
if (!h?.ok) { console.log('❌ bridge 没起来'); bridge.kill(); process.exit(1); }
console.log('✅ bridge:', JSON.stringify(h));

// ── 2. Chrome + 清单 ────────────────────────────────
fs.rmSync(PROFILE, { recursive: true, force: true });
const hostDir = path.join(PROFILE, 'NativeMessagingHosts');
fs.mkdirSync(hostDir, { recursive: true });
fs.writeFileSync(path.join(hostDir, 'com.gjr.annotation_bridge.json'), JSON.stringify({
  name: 'com.gjr.annotation_bridge',
  description: 'annotation-bridge native host (open-panel test)',
  path: path.join(ROOT, 'host', 'run.sh'),
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extId}/`],
}, null, 2));

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  `--user-data-dir=${PROFILE}`,
  `--load-extension=${EXT}`,
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--window-size=460,1000',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, BRIDGE_PORT: String(BRIDGE_PORT) } });

let ver;
for (let i = 0; i < 50; i++) {
  try { const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch {}
  await sleep(300);
}
if (!ver) { console.log('❌ Chrome 没起来'); chrome.kill(); bridge.kill(); process.exit(1); }

const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const mid = ++id; pend.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
});

// ── 3. 等宿主连上（扩展在线）─────────────────────────
let online = false;
for (let i = 0; i < 40; i++) {
  const hh = await health();
  if (hh?.extension) { online = true; break; }
  await sleep(250);
}
console.log(online ? '✅ 扩展已连上宿主（/health.extension = true）' : '❌ 扩展没连上宿主');
if (!online) {
  const t = await send('Target.getTargets');
  console.log('targets:', (t.result?.targetInfos || []).map(x => `${x.type}:${x.url.slice(0, 70)}`));
}

// ── 4. 唤起面板 ─────────────────────────────────────
const openRes = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/open-panel`, { method: 'POST' }).then(r => r.json()).catch(e => ({ error: String(e) }));
console.log('POST /open-panel →', JSON.stringify(openRes));

let panelTarget = null;
for (let i = 0; i < 40 && !panelTarget; i++) {
  await sleep(250);
  const tg = await send('Target.getTargets');
  panelTarget = (tg.result?.targetInfos || []).find((x) => x.url.includes('sidepanel.html') && x.type === 'page');
}
console.log(panelTarget ? '✅ 面板窗口已弹出' : '❌ 面板没弹出来');
if (panelTarget) {
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: panelTarget.targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 440, height: 940, deviceScaleFactor: 2, mobile: false }, sessionId);
  await sleep(3000);
  const st = await send('Runtime.evaluate', {
    expression: `JSON.stringify({standalone: document.body.classList.contains('standalone'), status: document.getElementById('statusText')?.textContent, sessions: document.querySelectorAll('#sessionList .pop-item').length, tools: document.querySelectorAll('#toolTabs .tool').length})`,
    returnByValue: true,
  }, sessionId);
  console.log('面板:', st.result?.result?.value);
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(ROOT, 'test/out-standalone.png'), Buffer.from(shot.result.data, 'base64'));
  console.log('截图: test/out-standalone.png');
}

chrome.kill();
bridge.kill();
const pass = online && !!panelTarget;
console.log(pass ? '\n✅ PASS：桌面 app 能唤起面板窗口' : '\n❌ FAIL');
process.exit(pass ? 0 : 1);
