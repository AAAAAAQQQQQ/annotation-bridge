/**
 * 元素拾取的端到端测试（独立面板窗口模式）。
 *
 *   验证：
 *   1. 面板窗口自己是 active tab 时，「选元素」仍然作用在网页上（不是面板）
 *   2. 已选列表渲染出来（编号 / 选择器 / 文本 / 定位 / ✕）
 *   3. 面板里点 ✕ 之后，页面侧 content script 的 picked 同步删掉
 *
 * 跑法：node test/pick-probe.mjs
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
const DEBUG_PORT = 9785;
const BRIDGE_PORT = Number(process.env.TEST_BRIDGE_PORT || 47396);
const PROFILE = '/tmp/annotation-bridge-pick-profile';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const extId = (() => {
  const h = crypto.createHash('sha256').update(EXT).digest('hex').slice(0, 32);
  return [...h].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
})();
const health = async () => {
  try { return await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`, { signal: AbortSignal.timeout(1000) })).json(); }
  catch { return null; }
};

// bridge + 测试页
try { await fetch(`http://127.0.0.1:${BRIDGE_PORT}/shutdown`, { method: 'POST' }); } catch {}
await sleep(300);
const bridge = spawn(process.execPath, [path.join(ROOT, 'bridge.mjs')], {
  cwd: ROOT, env: { ...process.env, BRIDGE_PORT: String(BRIDGE_PORT), DRY_RUN: '1' }, stdio: 'ignore',
});
const serve = spawn(process.execPath, [path.join(ROOT, 'test/serve.mjs')], { stdio: 'ignore' });
for (let i = 0; i < 20; i++) { await sleep(250); if (await health()) break; }

// Chrome
fs.rmSync(PROFILE, { recursive: true, force: true });
const hostDir = path.join(PROFILE, 'NativeMessagingHosts');
fs.mkdirSync(hostDir, { recursive: true });
fs.writeFileSync(path.join(hostDir, 'com.gjr.annotation_bridge.json'), JSON.stringify({
  name: 'com.gjr.annotation_bridge', description: 'pick test',
  path: path.join(ROOT, 'host', 'run.sh'), type: 'stdio',
  allowed_origins: [`chrome-extension://${extId}/`],
}, null, 2));

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  `--user-data-dir=${PROFILE}`, `--load-extension=${EXT}`,
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  `--remote-debugging-port=${DEBUG_PORT}`, '--window-size=460,1000', 'about:blank',
], { stdio: 'ignore', env: { ...process.env, BRIDGE_PORT: String(BRIDGE_PORT) } });

let ver;
for (let i = 0; i < 50; i++) {
  try { const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch {}
  await sleep(300);
}
if (!ver) { console.log('❌ Chrome 没起来'); chrome.kill(); bridge.kill(); serve.kill(); process.exit(1); }

const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const mid = ++id; pend.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const ev = async (sid, expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
  return r.result?.result?.value ?? r.result?.exceptionDetails?.text;
};
await send('Target.setDiscoverTargets', { discover: true });

let sw;
for (let i = 0; i < 40 && !sw; i++) {
  const t = await send('Target.getTargets');
  sw = (t.result?.targetInfos || []).find((x) => x.type === 'service_worker' && x.url.includes('background.js'));
  if (!sw) await sleep(400);
}
if (!sw) { console.log('❌ 扩展没加载'); chrome.kill(); bridge.kill(); serve.kill(); process.exit(1); }
const { result: { sessionId: swSid } } = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
await send('Runtime.enable', {}, swSid);

// 等扩展连上宿主，然后让它弹面板窗口
let online = false;
for (let i = 0; i < 40; i++) { const h = await health(); if (h?.extension) { online = true; break; } await sleep(250); }
console.log(online ? '✅ 扩展在线' : '❌ 扩展没连上宿主');
await fetch(`http://127.0.0.1:${BRIDGE_PORT}/open-panel`, { method: 'POST' }).catch(() => {});
let panel = null;
for (let i = 0; i < 40 && !panel; i++) {
  await sleep(250);
  const t = await send('Target.getTargets');
  panel = (t.result?.targetInfos || []).find((x) => x.url.includes('sidepanel.html'));
}
if (!panel) { console.log('❌ 面板没弹出'); chrome.kill(); bridge.kill(); serve.kill(); process.exit(1); }
console.log('✅ 面板窗口:', panel.url);
const { result: { sessionId: pSid } } = await send('Target.attachToTarget', { targetId: panel.targetId, flatten: true });
await send('Runtime.enable', {}, pSid);
await send('Page.enable', {}, pSid);
await send('Emulation.setDeviceMetricsOverride', { width: 440, height: 940, deviceScaleFactor: 2, mobile: false }, pSid);

// 打开测试页
const pageTabId = await ev(swSid, `chrome.tabs.create({url:'http://127.0.0.1:8899/'}).then(t=>t.id)`);
await sleep(1800);
const tg = await send('Target.getTargets');
const pageTarget = (tg.result.targetInfos || []).find((x) => x.url.includes('127.0.0.1:8899'));
if (!pageTarget) { console.log('❌ 测试页没打开'); chrome.kill(); bridge.kill(); serve.kill(); process.exit(1); }
const { result: { sessionId: tSid } } = await send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
await send('Runtime.enable', {}, tSid);
await send('Emulation.setDeviceMetricsOverride', { width: 460, height: 1000, deviceScaleFactor: 1, mobile: false }, tSid);

// 面板里点「选元素」
await sleep(1200);
const tabSeen = await ev(pSid, `chrome.runtime.sendMessage({type:'GET_ACTIVE_TAB'}).then(t=>JSON.stringify(t))`);
console.log('面板看到的 active tab:', tabSeen);
await ev(pSid, `document.getElementById('fabPick').click()`);
await sleep(800);

// 在页面上点两张卡片
for (const y of [232, 330]) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y }, tSid);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y, button: 'left', clickCount: 1 }, tSid);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 200, y, button: 'left', clickCount: 1 }, tSid);
  await sleep(700);
}
await sleep(600);

// 悬停在已选元素上：只应该有实线编号框，不该再冒出预览框
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 232 }, tSid);
await sleep(500);
const overlays = await ev(tSid, `JSON.stringify([...document.querySelectorAll('div')].filter(d => d.style && d.style.position === 'fixed' && d.style.zIndex === '2147483647').map(d => ({
  text: (d.textContent || '').slice(0, 24),
  display: getComputedStyle(d).display,
  borderStyle: getComputedStyle(d).borderTopStyle,
  borderColor: getComputedStyle(d).borderTopColor,
})))`);
console.log('悬停已选元素时的覆盖层:', overlays);

const listState = await ev(pSid, `JSON.stringify({
  hint: document.getElementById('sendHint')?.textContent || '',
  visible: !document.getElementById('pickedBox')?.classList.contains('hidden'),
  rows: document.querySelectorAll('#pickedBox .pick-row').length,
  first: document.querySelector('#pickedBox .pick-sel')?.textContent || '',
  text: document.querySelector('#pickedBox .pick-txt')?.textContent || '',
  locate: document.querySelectorAll('#pickedBox .pick-locate').length,
})`);
console.log('已选列表:', listState);

// 点第一行的 ✕，看页面侧是否同步删掉
const before = await ev(swSid, `chrome.tabs.sendMessage(${pageTabId},{type:'GET_PICKS'}).then(r=>JSON.stringify((r.items||[]).map(x=>x.selector)))`);
await ev(pSid, `document.querySelector('#pickedBox .x').click()`);
await sleep(800);
const afterPanel = await ev(pSid, `document.querySelectorAll('#pickedBox .pick-row').length`);
const afterPage = await ev(swSid, `chrome.tabs.sendMessage(${pageTabId},{type:'GET_PICKS'}).then(r=>JSON.stringify((r.items||[]).map(x=>x.selector)))`);
console.log('删除前页面 picks:', before);
console.log('删除后面板行数:', afterPanel, '页面 picks:', afterPage);

// 再选一次，确认删掉的不回来
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 130 }, tSid);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 130, button: 'left', clickCount: 1 }, tSid);
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 200, y: 130, button: 'left', clickCount: 1 }, tSid);
await sleep(800);
const finalState = await ev(pSid, `JSON.stringify({rows: document.querySelectorAll('#pickedBox .pick-row').length, hint: document.getElementById('sendHint')?.textContent})`);
console.log('再选一个之后:', finalState);
// 点页面空白：不应被当成一次选择
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 380, y: 700 }, tSid);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 380, y: 700, button: 'left', clickCount: 1 }, tSid);
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 380, y: 700, button: 'left', clickCount: 1 }, tSid);
await sleep(600);
const afterBlank = await ev(pSid, `document.querySelectorAll('#pickedBox .pick-row').length`);
console.log('点空白之后行数（应保持不变）:', afterBlank);
const shot = await send('Page.captureScreenshot', { format: 'png' }, pSid);
fs.writeFileSync(path.join(ROOT, 'test/out-pick.png'), Buffer.from(shot.result.data, 'base64'));
const pageShot = await send('Page.captureScreenshot', { format: 'png' }, tSid);
fs.writeFileSync(path.join(ROOT, 'test/out-pick-page.png'), Buffer.from(pageShot.result.data, 'base64'));
console.log('截图: test/out-pick.png, test/out-pick-page.png');

chrome.kill(); bridge.kill(); serve.kill();
await fetch(`http://127.0.0.1:${BRIDGE_PORT}/shutdown`, { method: 'POST' }).catch(() => {});
process.exit(0);
