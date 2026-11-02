/**
 * 原生消息通道端到端测试（不依赖端口转发，不依赖 LNA 开关）。
 *
 *   node test/native-probe.mjs          # 无头 Chrome
 *   HEADED=1 node test/native-probe.mjs # 有头 Chrome（想亲眼看到窗口时）
 *
 * 做的事：
 *   1. 用一个独立端口（默认 47392）和全新 profile 启动 Chrome for Testing
 *   2. 在扩展 service worker 里直接 connectNative → GET /health
 *   3. 宿主发现 bridge 没起 → 自己把 bridge 拉起来 → /health 通
 *   4. 打开 sidepanel.html，确认面板走原生通道拿到会话列表
 *
 * 关键细节：Chrome 的用户级宿主目录是 <user-data-dir>/NativeMessagingHosts，
 * 所以用 --user-data-dir 的测试必须把清单写进 profile，而不是只装在家目录。
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
const DEBUG_PORT = 9781;
const BRIDGE_PORT = Number(process.env.TEST_BRIDGE_PORT || 47392);
const PROFILE = '/tmp/annotation-bridge-native-profile';
const LOG = path.join(os.homedir(), 'Library/Logs/annotation-bridge-native.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headed = process.env.HEADED === '1';

const logSize = () => { try { return fs.statSync(LOG).size; } catch { return 0; } };
const logSince = (off) => { try { return fs.readFileSync(LOG, 'utf8').slice(off); } catch { return ''; } };
const health = async () => {
  try { return await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`, { signal: AbortSignal.timeout(1000) })).json(); }
  catch { return null; }
};

/** 未打包扩展 ID = sha256(绝对路径) 前 16 字节，nibble → a-p */
function unpackedExtensionId(absPath) {
  const h = crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 32);
  return [...h].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

// ── 0. 独立端口：先确认没在跑 ─────────────────────────
let up = await health();
if (up) {
  await fetch(`http://127.0.0.1:${BRIDGE_PORT}/shutdown`, { method: 'POST' }).catch(() => {});
  await sleep(400);
  up = await health();
}
console.log(up ? `⚠️ ${BRIDGE_PORT} 端口已有 bridge（可能是用户的），测试会复用` : `✅ ${BRIDGE_PORT} 端口干净，等宿主来拉起`);
const logOff = logSize();

// ── 1. 全新 Chrome（清单写进 profile）───────────────
fs.rmSync(PROFILE, { recursive: true, force: true });
const hostDir = path.join(PROFILE, 'NativeMessagingHosts');
fs.mkdirSync(hostDir, { recursive: true });
const extId = unpackedExtensionId(EXT);
fs.writeFileSync(path.join(hostDir, 'com.gjr.annotation_bridge.json'), JSON.stringify({
  name: 'com.gjr.annotation_bridge',
  description: 'annotation-bridge native host (test profile)',
  path: path.join(ROOT, 'host', 'run.sh'),
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extId}/`],
}, null, 2));

const chrome = spawn(CHROME, [
  ...(headed ? [] : ['--headless=new']),
  '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  `--user-data-dir=${PROFILE}`,
  `--load-extension=${EXT}`,
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--window-size=460,1000',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BRIDGE_PORT: String(BRIDGE_PORT) } });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

let ver;
for (let i = 0; i < 50; i++) {
  try { const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch {}
  await sleep(300);
}
if (!ver) {
  console.log('❌ Chrome 没起来'); console.log(chromeErr.slice(-800));
  chrome.kill(); process.exit(1);
}
console.log('Chrome:', ver.Browser, headed ? '(headed)' : '(headless)');

const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const mid = ++id; pend.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const pageErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || 'exception');
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') pageErrors.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
});
const evalIn = async (sid, expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
  return r.result?.result?.value ?? r.result?.exceptionDetails?.text;
};

await send('Target.setDiscoverTargets', { discover: true });

let sw;
for (let i = 0; i < 40 && !sw; i++) {
  const t = await send('Target.getTargets');
  sw = (t.result?.targetInfos || []).find(
    (x) => x.type === 'service_worker' && /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(x.url));
  if (!sw) await sleep(400);
}
if (!sw) { console.log('❌ 扩展没加载'); console.log(chromeErr.slice(-500)); chrome.kill(); process.exit(1); }
const loadedId = sw.url.split('/')[2];
console.log(`${loadedId === extId ? '✅' : '❌'} 扩展已加载  id = ${loadedId}`);
const { result: { sessionId: swSid } } = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
await send('Runtime.enable', {}, swSid);

// ── 2. 直接走 connectNative ─────────────────────────
const nativeRes = await evalIn(swSid, `new Promise((resolve) => {
  let port;
  try { port = chrome.runtime.connectNative('com.gjr.annotation_bridge'); }
  catch (e) { return resolve(JSON.stringify({ ok: false, stage: 'connect', err: String(e && e.message || e) })); }
  let done = false;
  const finish = (v) => { if (!done) { done = true; resolve(JSON.stringify(v)); } };
  port.onMessage.addListener((m) => finish({ ok: true, stage: 'message', msg: m }));
  port.onDisconnect.addListener(() => finish({ ok: false, stage: 'disconnect', err: chrome.runtime.lastError && chrome.runtime.lastError.message || 'disconnected' }));
  port.postMessage({ id: 1, method: 'GET', path: '/health' });
  setTimeout(() => finish({ ok: false, stage: 'timeout', err: '10s 没回' }), 10000);
})`);
console.log('原生通道 connectNative →', nativeRes);
const nativeOk = String(nativeRes).includes('"ok":true');

// ── 3. 面板 ─────────────────────────────────────────
await evalIn(swSid, `chrome.tabs.create({url: chrome.runtime.getURL('sidepanel.html')}).then(t=>t.id)`);
await sleep(2500);
const tg = await send('Target.getTargets');
const panel = (tg.result.targetInfos || []).find((x) => x.url.includes('/sidepanel.html'));
if (!panel) { console.log('❌ 面板没打开'); chrome.kill(); process.exit(1); }
const { result: { sessionId: pSid } } = await send('Target.attachToTarget', { targetId: panel.targetId, flatten: true });
await send('Runtime.enable', {}, pSid);
await send('Page.enable', {}, pSid);
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 1400, deviceScaleFactor: 2, mobile: false }, pSid);
// bridge 冷启动要 2~3 秒，轮询等面板把会话渲染出来
let state = '';
for (let i = 0; i < 20; i++) {
  await sleep(750);
  state = await evalIn(pSid, `JSON.stringify({
  status: document.getElementById('statusText')?.textContent,
  offline: !document.getElementById('offline')?.classList.contains('hidden'),
  offlineMsg: document.getElementById('offlineMsg')?.textContent,
  sessions: document.querySelectorAll('#sessionList .pop-item').length,
  queue: document.getElementById('queueCount')?.textContent,
  tools: [...document.querySelectorAll('#toolTabs .tool')].map(e => e.textContent.trim())
})`);
  const st = JSON.parse(state || '{}');
  if (st.sessions > 0 || (st.tools || []).length > 0) break;
}
console.log('面板状态:', state);
console.log('面板错误:', pageErrors.length ? pageErrors.slice(0, 5) : '(无)');
console.log('面板诊断:', await evalIn(pSid, `JSON.stringify({
  init: typeof init, toolTabs: document.querySelectorAll('#toolTabs .tool').length,
  runtimeId: (() => { try { return chrome.runtime.id } catch (e) { return 'ERR:' + e.message } })()
})`));
const shot = await send('Page.captureScreenshot', { format: 'png' }, pSid);
fs.writeFileSync(path.join(ROOT, 'test/out-native.png'), Buffer.from(shot.result.data, 'base64'));
console.log('截图: test/out-native.png');

// ── 4. 宿主日志 ─────────────────────────────────────
const all = (() => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } })();
const fresh = all.slice(logOff).trim();
const tail = all.split('\n').slice(-60).join('\n');
console.log('\n── 宿主日志（本次新增）──');
console.log(fresh || '(空 —— 说明没走原生通道！)');

const h = await health();
console.log('\nbridge /health:', h ? JSON.stringify(h) : '(没起来)');

chrome.kill();
const panelState = JSON.parse(state || '{}');
const checks = {
  '扩展 ID 匹配': loadedId === extId,
  '原生通道有回包': nativeOk,
  '宿主启动并转发了请求': /host 启动/.test(tail) && /GET \/health/.test(tail),
  '宿主自动拉起 bridge': !up && !!h?.ok && tail.includes(`bridge 已启动 pid=${h.pid}`),
  'bridge 存活': !!h?.ok,
  '面板拿到会话/工具': (panelState.sessions || 0) > 0 || (panelState.tools || []).length > 0,
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? '✅' : '❌'} ${k}`);
const pass = Object.values(checks).every(Boolean);
console.log(pass ? '\n✅ PASS：宿主被拉起 → bridge 被拉起 → 原生通道可用' : '\n❌ FAIL：原生通道没走通（看上面日志）');

if (!up) await fetch(`http://127.0.0.1:${BRIDGE_PORT}/shutdown`, { method: 'POST' }).catch(() => {});
process.exit(pass ? 0 : 1);
