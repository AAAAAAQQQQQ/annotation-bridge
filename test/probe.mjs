/**
 * 端到端测试：加载扩展 → 打开面板 → 拾取元素 → 入队 → 发送
 * 跑之前先起 bridge（建议 DRY_RUN=1，避免真的往会话里投递）：
 *   DRY_RUN=1 node bridge.mjs &
 *   node test/serve.mjs &          # 测试页 http://127.0.0.1:8899
 *   node test/probe.mjs
 */
// 真实测试：把扩展加载进 Chrome for Testing，验证
//  1) 扩展能否加载  2) 侧边栏页面能否打开并连上 bridge  3) 元素拾取能否走通
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const EXT = ROOT + 'extension';
// 需要 Chrome for Testing 或 Chromium：原版 Google Chrome 会忽略 --load-extension
const CHROME = process.env.CHROME_BIN
  || process.env.HOME + '/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const PORT = 9777;
const PROFILE = '/tmp/annotation-bridge-test-profile';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(PROFILE, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  `--user-data-dir=${PROFILE}`,
  `--load-extension=${EXT}`,
  `--disable-features=DisableLoadExtensionCommandLineSwitch`,
  `--remote-debugging-port=${PORT}`,
  '--window-size=460,1000',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

let ver;
for (let i = 0; i < 50; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch {}
  await sleep(300);
}
if (!ver) { console.log('❌ Chrome 没起来'); console.log(chromeErr.slice(-500)); chrome.kill(); process.exit(1); }
console.log('Chrome:', ver.Browser);

const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const mid = ++id; pend.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
});

await send('Target.setDiscoverTargets', { discover: true });

// ── 1. 找扩展的 service worker ─────────────────────
let swTarget = null;
for (let i = 0; i < 40 && !swTarget; i++) {
  const t = await send('Target.getTargets');
  swTarget = (t.result?.targetInfos || []).find(
    (x) => x.type === 'service_worker' && /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(x.url));
  if (!swTarget) await sleep(400);
}
if (!swTarget) {
  console.log('❌ 没找到扩展的 service worker —— 扩展没加载');
  const t = await send('Target.getTargets');
  console.log('   现有 target:', (t.result?.targetInfos || []).map(x => `${x.type}:${x.url.slice(0, 60)}`));
  chrome.kill(); process.exit(1);
}
const extId = swTarget.url.split('/')[2];
console.log('✅ 扩展已加载  id =', extId);

// 连到 service worker
const { result: { sessionId: swSid } } = await send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
await send('Runtime.enable', {}, swSid);
const evalIn = async (sid, expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
  return r.result?.result?.value ?? r.result?.exceptionDetails?.text;
};
console.log('   runtime.id =', await evalIn(swSid, 'chrome.runtime.id'));

// ── 2. 打开侧边栏页面（用扩展自己的 tabs API，绕开 CDP 导航限制）──
await evalIn(swSid, `chrome.tabs.create({url: chrome.runtime.getURL('sidepanel.html')}).then(t=>t.id)`);
await sleep(2500);
const tg = await send('Target.getTargets');
const panel = (tg.result.targetInfos || []).find((x) => x.url.includes('/sidepanel.html'));
if (!panel) { console.log('❌ 侧边栏页面没打开'); chrome.kill(); process.exit(1); }
console.log('✅ 侧边栏页面已打开');
const { result: { sessionId: pSid } } = await send('Target.attachToTarget', { targetId: panel.targetId, flatten: true });
await send('Runtime.enable', {}, pSid);
await send('Page.enable', {}, pSid);
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 1400, deviceScaleFactor: 2, mobile: false }, pSid);
await sleep(2000);

const state = await evalIn(pSid, `JSON.stringify({
  status: document.getElementById('statusText')?.textContent,
  sessions: document.querySelectorAll('#sessionList .pop-item').length,
  first: document.querySelector('#sessionList .pop-item b')?.textContent?.slice(0,40) || '',
  queue: document.getElementById('queueCount')?.textContent,
  errors: window.__errs || []
})`);
console.log('   面板状态:', state);

// ── 3. 元素拾取全链路 ──────────────────────────────
await evalIn(swSid, `chrome.tabs.query({url:'http://127.0.0.1:8899/*'}).then(ts => ts.length)`);
const testTabId = await evalIn(swSid, `chrome.tabs.create({url:'http://127.0.0.1:8899/'}).then(t=>t.id)`);
console.log('   测试页 tab =', testTabId);
await sleep(2000);

const tg2 = await send('Target.getTargets');
const testPage = (tg2.result.targetInfos || []).find((x) => x.url.includes('127.0.0.1:8899'));
if (!testPage) { console.log('❌ 测试页没打开'); chrome.kill(); process.exit(1); }
const { result: { sessionId: tSid } } = await send('Target.attachToTarget', { targetId: testPage.targetId, flatten: true });
await send('Runtime.enable', {}, tSid);

// content script 是否注入
const hasPicker = await evalIn(tSid, 'String(!!window.__annotationBridgeLoaded)');
console.log('   content.js 已注入:', hasPicker);

// 从 service worker 触发拾取模式
const pickRes = await evalIn(swSid, `chrome.tabs.sendMessage(${testTabId}, {type:'START_PICK'}).then(r=>JSON.stringify(r)).catch(e=>'ERR:'+e.message)`);
console.log('   进入拾取模式:', pickRes);

// 在第三张卡片上模拟一次真实点击
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 232 }, tSid);
await sleep(300);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 232, button: 'left', clickCount: 1 }, tSid);
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 200, y: 232, button: 'left', clickCount: 1 }, tSid);
await sleep(1200);

const picked = await evalIn(pSid, `JSON.stringify({
  selector: document.querySelector('#pickedSel')?.textContent || '',
  text: document.querySelector('#pickedTxt')?.textContent || '',
  hint: document.getElementById('sendHint')?.textContent || ''
})`);
console.log('   拾取结果回传面板:', picked);

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, pSid);
fs.writeFileSync(ROOT + 'test/out-panel.png', Buffer.from(shot.result.data, 'base64'));
console.log('   截图: test/out-panel.png');


// ── 4. 选会话 → 写备注 → 入队 → 发送（bridge 为 DRY_RUN）──
await evalIn(pSid, `document.getElementById('btnSession').click()`);
await sleep(400);
await evalIn(pSid, `document.querySelector('#sessionList .pop-item')?.click()`);
await sleep(600);
const selState = await evalIn(pSid, `JSON.stringify({sel: document.getElementById('selTitle')?.textContent||'', sub: document.getElementById('selSub')?.textContent||''})`);
console.log('   选中会话:', selState);

await evalIn(pSid, `(() => { const t=document.getElementById('comment'); t.value='这个卡片间距太挤'; t.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
await evalIn(pSid, `document.getElementById('btnQueue').click()`);
await sleep(1200);
const q = await evalIn(pSid, `JSON.stringify({count: document.getElementById('queueCount')?.textContent, items: document.querySelectorAll('#queue .qitem').length, hint: document.getElementById('sendHint')?.textContent})`);
console.log('   入队后:', q);

// 切「续跑」→ 选模型 → 看强度下拉是否跟着变
await evalIn(pSid, `(() => { const m=document.getElementById('mode'); m.value='resume'; m.dispatchEvent(new Event('change',{bubbles:true})); return m.value; })()`);
await sleep(300);
const models = await evalIn(pSid, `JSON.stringify({n: document.getElementById('model').options.length, first: document.getElementById('model').options[1]?.value, disabled: document.getElementById('model').disabled})`);
console.log('   模型下拉:', models);
await evalIn(pSid, `(() => { const s=document.getElementById('model'); s.selectedIndex=2; s.dispatchEvent(new Event('change',{bubbles:true})); return s.value; })()`);
await sleep(300);
const efforts = await evalIn(pSid, `JSON.stringify({model: document.getElementById('model').value, efforts: [...document.getElementById('effort').options].map(o=>o.value), disabled: document.getElementById('effort').disabled})`);
console.log('   强度下拉:', efforts);
await evalIn(pSid, `(() => { const e=document.getElementById('effort'); e.selectedIndex=Math.min(3,e.options.length-1); e.dispatchEvent(new Event('change',{bubbles:true})); return e.value; })()`);

await evalIn(pSid, `document.getElementById('btnSend').click()`);
await sleep(2000);
const sent = await evalIn(pSid, `JSON.stringify({hint: document.getElementById('sendHint')?.textContent, cls: document.getElementById('sendHint')?.className, queue: document.getElementById('queueCount')?.textContent, msgs: document.querySelectorAll('#messages .msg').length})`);
console.log('   发送后:', sent);

const shot2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, pSid);
fs.writeFileSync(ROOT + 'test/out-full.png', Buffer.from(shot2.result.data, 'base64'));
console.log('   截图: test/out-full.png');

chrome.kill();
process.exit(0);
