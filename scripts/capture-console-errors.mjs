// 用 CDP 抓控制台页面加载时的 JS 异常 / console.error / 网络请求失败。
// 用法：先手动启动带 --remote-debugging-port=9333 的 Edge，
//       node scripts/capture-console-errors.mjs "<要打开的URL>" [等待毫秒]
const targetUrl = process.argv[2];
const waitMs = Number(process.argv[3] || 9000);
const DEBUG_PORT = Number(process.env.CDP_PORT || 9333);

if (!targetUrl) {
  console.error('用法: node scripts/capture-console-errors.mjs <url> [waitMs]');
  process.exit(2);
}

async function findPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('找不到可调试的页面目标（Edge 没起来？端口不对？）');
}

const page = await findPageTarget();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const events = [];

function send(method, params = {}) {
  const msgId = ++id;
  ws.send(JSON.stringify({ id: msgId, method, params }));
  return new Promise((resolve) => pending.set(msgId, resolve));
}

ws.addEventListener('message', (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
  if (!msg.method) return;
  const p = msg.params ?? {};
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = p.exceptionDetails ?? {};
    events.push(`❌ JS 异常: ${d.exception?.description ?? d.text} @${d.url ?? ''}:${d.lineNumber ?? '?'}`);
  } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(p.type)) {
    events.push(`${p.type === 'error' ? '🟥' : '🟧'} console.${p.type}: ${(p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
  } else if (msg.method === 'Log.entryAdded') {
    const e = p.entry ?? {};
    if (['error', 'warning'].includes(e.level)) events.push(`🌐 [${e.source}] ${e.level}: ${e.text} ${e.url ?? ''}`);
  } else if (msg.method === 'Runtime.responseReceived' || msg.method === 'Network.responseReceived') {
    if (p.response && p.response.status >= 400) {
      events.push(`📡 HTTP ${p.response.status} ${p.response.url}`);
    }
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await send('Page.enable');
await send('Page.navigate', { url: targetUrl });
await new Promise((r) => setTimeout(r, waitMs));

// 取几个关键元素的实际文本，看界面到底停在什么状态
const probe = await send('Runtime.evaluate', {
  expression: `(() => {
    const t = (sel) => (document.querySelector(sel)?.textContent ?? '(无此元素)').trim().slice(0, 200);
    return JSON.stringify({
      statusText: t('#statusText'),
      authBar: getComputedStyle(document.getElementById('authBar')).display,
      authBarMsg: t('#authBarMsg'),
      sessionList: t('#sessionList'),
      pendingList: t('#pendingList'),
      activity: t('#activity'),
      modeRow: t('#modeRow')
    }, null, 2);
  })()`,
  returnByValue: true
});

console.log('=== 页面状态 ===');
console.log(probe?.result?.value ?? '(取不到)');
console.log('\n=== 报错 / 警告 ===');
console.log(events.length ? events.join('\n') : '（没有捕获到任何报错）');
ws.close();
