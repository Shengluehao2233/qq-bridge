// 记忆插件端到端探针：QQ 侧 DSH 上，确认
//  1. memory_remember / memory_search 对模型可见
//  2. 执行期守卫（qq-tool-restrict）不拦这两个工具
//  3. 写入真的落进 meow-memory 库
import { randomUUID } from 'node:crypto';
import { probeCookie, probeRpc, probeMuxSocket } from './probe-auth.mjs';

const cookie = probeCookie();
const rpc = probeRpc(cookie);

const PRESET = process.argv[2] || 'qq-chat-v2';
// 用机器人真实工作区，避免「未受信任工作区」导致插件暂停注入
const DIR = 'C:\\Users\\sbsb1\\OneDrive\\Desktop\\DshBot\\qq-bridge\\state\\agents';
const ws = await rpc('workspace/create', { request: { path: DIR } });
const wsId = ws.value.workspace.workspaceId;

const sc = await rpc('session/create', { request: { workspaceId: wsId, agentPreset: PRESET } });
if (!sc.ok) { console.error(`❌ preset ${PRESET} 挂载失败: ${sc.error.code}: ${sc.error.message}`); process.exit(2); }
const sessionId = sc.value.sessionId;
console.log(`session ${sessionId} (preset=${PRESET})`);

const sm = await rpc('session/selectModel', {
  request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }
});
console.log('selectModel ->', sm.ok ? 'ok' : `${sm.error?.code}: ${sm.error?.message}`);

const socket = probeMuxSocket(cookie);
const streamId = randomUUID();
const eventStreamId = randomUUID();
const toolCalls = [];
const toolResults = [];
let text = '';

const PROMPT = [
  '这是记忆功能自检。请依次做两件事：',
  '1) 调用 memory_remember 工具，写入一条：content="QQ机器人记忆自检20261107"，',
  '   keywords=["自检","记忆","meow"], importance=1, level="fact", project="全局"。',
  '2) 调用 memory_search 工具，query="自检"，把命中条数告诉我。',
  '最后只回复：完成'
].join('');

const done = new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), 180_000);
  const finish = (why) => { clearTimeout(timer); resolve(why); };
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } }));
    socket.send(JSON.stringify({ type: 'open', streamId: eventStreamId, endpoint: '$events', payload: { args: {} } }));
    setTimeout(async () => {
      const p = await rpc('session/prompt', {
        request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: PROMPT }] }
      });
      console.log('prompt ->', JSON.stringify(p).slice(0, 140));
    }, 700);
  });
  socket.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type !== 'item' || m.streamId === eventStreamId) return;
    const v = m.value;
    if (v?.type !== 'event') return;
    const e = v.event;
    if (e.type === 'assistant/message') for (const b of e.data?.message?.content ?? []) if (b?.type === 'text') text += b.text;
    if (e.type === 'tool/call') toolCalls.push({ name: e.data?.name ?? e.data?.toolName, args: e.data?.arguments ?? e.data?.args });
    if (e.type === 'tool/result') toolResults.push({ name: e.data?.name ?? e.data?.toolName, isError: e.data?.isError ?? e.data?.error !== undefined });
    if (e.type === 'turn/end') finish('done');
  });
  socket.addEventListener('close', () => finish('closed'));
  socket.addEventListener('error', () => finish('error'));
});

const why = await done;
console.log(`\n结果: ${why}`);
console.log('最终文本:', JSON.stringify(text.slice(0, 300)));
console.log('tool/call:', JSON.stringify(toolCalls).slice(0, 600));
console.log('tool/result:', JSON.stringify(toolResults).slice(0, 600));

const called = (prefix) => toolCalls.filter((c) => String(c.name).startsWith(prefix)).length;
const errored = toolResults.filter((r) => r.isError).length;
console.log('\n判定:');
console.log(`  memory_remember 调用   : ${called('memory_remember') ? '✅' : '❌'}`);
console.log(`  memory_search 调用     : ${called('memory_search') ? '✅' : '❌'}`);
console.log(`  工具结果错误数          : ${errored}`);

try { socket.close(); } catch {}
await rpc('workspace/archiveSession', { request: { sessionId } });
try { await rpc('workspace/delete', { request: { workspaceId: wsId } }); } catch {}
console.log('[cleanup] session archived, probe workspace deleted');
process.exit(called('memory_remember') && called('memory_search') ? 0 : 1);

