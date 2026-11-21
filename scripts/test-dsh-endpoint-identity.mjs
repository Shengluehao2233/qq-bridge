#!/usr/bin/env node
/**
 * 端点自愈的身份校验测试（2026-11-22 事故的回归测试）。
 *
 * 事故：3082（CLI 版 DSH，DSH_HOME=~/.dsh-qq）被系统睡眠带走后，桥接的
 * 「DSH 端点自愈」扫本机端口，把连接改到了**桌面版 DSH**（随机端口 11533）。
 * 两边用同一套离线铸造 Cookie，所以 `settings/describe` 都能过 —— 只看「探活成功」
 * 根本挡不住：QQ 群消息会被桌面 profile 的 agent 处理（错误的人设/工具/记忆）。
 *
 * 这里用一个假 DSH（stub HTTP 服务）验证：探活除了 `ok: true`，还要求命中
 * `requireNamespace`（默认 qq-mode），并且兼容 DSH 返回值的两种形状。
 *
 * 用法：node scripts/test-dsh-endpoint-identity.mjs
 * 退出码：0 = 全部通过；1 = 有失败。
 */
import http from 'node:http';
import { probeDshBaseUrl } from '../src/dsh-endpoint.js';

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}（期望 ${expected}，实际 ${actual}）`);
  }
}

/** 起一个假 DSH：POST /api/settings/describe 返回给定 body。 */
async function startStub(body, { status = 200 } = {}) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(typeof body === 'function' ? body(raw) : body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

const okWith = (namespaces) => ({
  type: 'server-response',
  result: { ok: true, value: { namespaces } }
});

console.log('DSH 端点身份校验：');

// 1) 桌面版 DSH 的样子：内容合法，但没有 qq-mode 命名空间。
{
  const stub = await startStub(okWith([{ ns: 'agent-presets' }, { ns: 'llm-deepseek' }]));
  try {
    check('不要求命名空间时，探活通过', await probeDshBaseUrl(stub.base), true);
    check('要求 qq-mode 时，桌面版被拒绝', await probeDshBaseUrl(stub.base, { requireNamespace: 'qq-mode' }), false);
  } finally {
    await stub.close();
  }
}

// 2) QQ 侧 DSH 的样子：带 qq-mode。
{
  const stub = await startStub(okWith([{ ns: 'agent-presets' }, { ns: 'qq-mode' }]));
  try {
    check('带 qq-mode 时，探活通过', await probeDshBaseUrl(stub.base, { requireNamespace: 'qq-mode' }), true);
    check('要求不存在的命名空间时，仍被拒绝', await probeDshBaseUrl(stub.base, { requireNamespace: 'nope' }), false);
  } finally {
    await stub.close();
  }
}

// 3) 形状兼容：命名空间挂在 result 本体、字段名是 namespace。
{
  const stub = await startStub({
    type: 'server-response',
    result: { ok: true, namespaces: [{ namespace: 'qq-mode' }] }
  });
  try {
    check('兼容 result.namespaces + namespace 字段', await probeDshBaseUrl(stub.base, { requireNamespace: 'qq-mode' }), true);
  } finally {
    await stub.close();
  }
}

// 4) 不健康/不认账的响应一律拒绝。
{
  const stub = await startStub({ type: 'server-response', result: { ok: false, error: 'unauthorized' } });
  try {
    check('ok:false 被拒绝', await probeDshBaseUrl(stub.base), false);
  } finally {
    await stub.close();
  }
}

{
  const stub = await startStub({ type: 'server-response', result: { ok: true, value: { namespaces: [] } } }, { status: 401 });
  try {
    check('HTTP 401 被拒绝', await probeDshBaseUrl(stub.base), false);
  } finally {
    await stub.close();
  }
}

// 5) 完全没监听的端口：false 而不是抛异常。
check('端口没人监听时返回 false', await probeDshBaseUrl('http://127.0.0.1:1', { timeoutMs: 800 }), false);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
