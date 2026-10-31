// qq-tool-restrict 守卫的回归（2026-10-18 新增；2026-10-31 改为「整批 restrict」后重写）。
//
// 背景：一份重启后**新建**的 QQ 会话，请求头里 `dev_*` 仍然是 18 个
// （docs/audits/AUDIT_2026-10-18_MEDIA_AND_WATERMARK.md §3 P3）。
// 失败发生在 `ctx.tools.restrict()` 调用期、被 per-name try/catch 静默吞掉 →
// 现网完全不可观测（DSH 的 stderr 不落文件）。
//
// 2026-10-31 起实现改了策略，本文件同步改成验证新契约：
//   1. 先整批 restrict 一次；被「unknown global tool」拒绝时，从报错里的
//      known-globals 清单解析出真实存在的名字，再整批 restrict 交集（2 次调用搞定）；
//   2. 真的藏不掉时**不静默**：写诊断文件 + 3 秒后重试；
//   3. 全部成功时不写诊断文件（不制造噪声）；
//   4. 同一个 tools 服务重复 apply 只注册一次（现网装载两次），不同 ctx 照常注册；
//   5. 执行期 guard 白名单照旧：mcp__* 放行、dev_* 与本地工具拒绝。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');

let failures = 0;
let tests = 0;
async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// 每次都重新 import 一份干净模块（诊断文件路径来自 env，必须在 import 前设好）
async function loadPlugin(diagFile) {
  process.env.QQ_TOOL_RESTRICT_LOG = diagFile;
  const url = pathToFileURL(PLUGIN).href + `?t=${Math.random().toString(36).slice(2)}`;
  const mod = await import(url);
  delete process.env.QQ_TOOL_RESTRICT_LOG;
  return mod;
}

/**
 * 桩 ctx：restrict 现在可能一次收到一整批名字，所以按 deny 数组记账。
 * @param {(names: string[]) => Error|undefined} restrictImpl 返回 Error 表示抛错
 */
function makeCtx({ restrictImpl = () => undefined } = {}) {
  const calls = { restrict: [], batches: [], guard: null, hidden: new Set() };
  const ctx = {
    tools: {
      restrict(filter) {
        const names = Array.isArray(filter?.deny) ? filter.deny : [];
        calls.restrict.push(...names);
        calls.batches.push(names);
        const result = restrictImpl(names);
        if (result instanceof Error) throw result;
        for (const name of names) calls.hidden.add(name);
        return () => {};
      },
      guard(fn) { calls.guard = fn; }
    }
  };
  return { ctx, calls };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tool-restrict-'));

await test('报错里带 known-globals 时走整批交集：只 restrict 真实存在的名字（2 次调用）', async () => {
  const diag = path.join(tmpDir, 'diag-known.log');
  const mod = await loadPlugin(diag);
  const known = ['list_mcp_resources', 'read_mcp_resource', 'working_directory'];
  const { ctx, calls } = makeCtx({
    restrictImpl: (names) => {
      const unknown = names.filter((n) => !known.includes(n));
      if (!unknown.length) return undefined;
      return new Error(`tools.restrict() names unknown global tool "${unknown[0]}"; known global tools: ${known.join(', ')}`);
    }
  });
  mod.apply(ctx);
  // 第一次整批（全部名字）被拒，第二次是交集（3 个名字）成功
  assert.deepEqual([...calls.hidden].sort(), [...known].sort(), `应只藏掉真实存在的 3 个，实际 ${[...calls.hidden]}`);
  assert.equal(calls.batches.length, 2, '应该只调用两次：整批被拒 + 交集成功');
  assert.deepEqual([...calls.batches[1]].sort(), [...known].sort(), '第二次只 restrict 交集');
  assert.equal(fs.existsSync(diag), false, '没有真正失败时不该写诊断文件');
});

await test('报错里没有 known-globals 时退回逐个尝试，并写诊断文件 + 3 秒后重试', async () => {
  const diag = path.join(tmpDir, 'diag-always-fail.log');
  const mod = await loadPlugin(diag);
  const { ctx } = makeCtx({ restrictImpl: () => new Error('tools.restrict() names unknown global tool "x"') });
  mod.apply(ctx);
  const first = fs.readFileSync(diag, 'utf8');
  assert.match(first, /restrict ok=0 absent=0 failed=\d+/, `诊断文件应记录失败计数：${first}`);
  assert.match(first, /unknown global tool/, '诊断文件必须带 DSH 的原始报错');
  await new Promise((resolve) => setTimeout(resolve, 3400));
  const after = fs.readFileSync(diag, 'utf8');
  assert.match(after, /延迟重试 ok=0/, `重试结果也要落盘：${after}`);
});

await test('时序问题能被 3 秒后的重试补藏（工具晚注册）', async () => {
  const diag = path.join(tmpDir, 'diag-late.log');
  const mod = await loadPlugin(diag);
  const total = mod.RESTRICTED_TOOL_NAMES.length;
  let ready = false;
  const { ctx, calls } = makeCtx({
    restrictImpl: () => (ready ? undefined : new Error('unknown global tool'))
  });
  mod.apply(ctx);
  assert.equal(calls.hidden.size, 0, '第一轮应当一个都没藏掉');
  ready = true;
  await new Promise((resolve) => setTimeout(resolve, 3400));
  assert.equal(calls.hidden.size, total, `重试后应全部藏掉，实际 ${calls.hidden.size}/${total}`);
  const log = fs.readFileSync(diag, 'utf8');
  assert.match(log, new RegExp(`延迟重试 ok=${total}`), `重试结果应写入诊断：${log}`);
});

await test('restrict 一次成功时不写诊断文件（不制造噪声）', async () => {
  const diag = path.join(tmpDir, 'diag-ok.log');
  const mod = await loadPlugin(diag);
  const { ctx, calls } = makeCtx();
  mod.apply(ctx);
  assert.equal(calls.hidden.size, mod.RESTRICTED_TOOL_NAMES.length);
  assert.equal(fs.existsSync(diag), false, '全部成功时不该产生诊断文件');
});

await test('每个 preset 各自的 ctx 都要注册（不能跨 ctx 去重）', async () => {
  const diag = path.join(tmpDir, 'diag-dup.log');
  const mod = await loadPlugin(diag);
  const first = makeCtx();
  mod.apply(first.ctx);
  assert.equal(typeof first.calls.guard, 'function', '第一个 ctx 必须注册 guard');
  assert.equal(first.calls.restrict.length, mod.RESTRICTED_TOOL_NAMES.length, '第一个 ctx 必须 restrict');
  // 现网是两个 preset 行各自一个 ctx：第二个也必须完整注册（跳过一个 = 那个 preset 裸奔）
  const second = makeCtx();
  mod.apply(second.ctx);
  assert.equal(typeof second.calls.guard, 'function', '第二个 ctx 必须注册 guard');
  assert.equal(second.calls.restrict.length, mod.RESTRICTED_TOOL_NAMES.length, '第二个 ctx 必须 restrict');
});

await test('执行期 guard 照旧：QQ MCP 放行、dev_* 与本地工具拒绝', async () => {
  const diag = path.join(tmpDir, 'diag-guard.log');
  const mod = await loadPlugin(diag);
  const { ctx, calls } = makeCtx();
  mod.apply(ctx);
  assert.equal(typeof calls.guard, 'function', '必须注册执行期 guard');
  const guard = calls.guard;
  for (const name of ['mcp__snowluma__qq_send_message', 'mcp__snowluma-host__snowluma_status', 'mcp__web-search-safe__web_search', 'ask_user_question', 'todo_write']) {
    assert.equal(guard({ name }), undefined, `${name} 应放行`);
  }
  for (const name of ['dev_inject_plugin', 'dev_plugin_status', 'pwsh', 'read', 'write', 'dsh_snapshot', 'skill']) {
    assert.match(String(guard({ name })), /不在 QQ 桥接白名单内/, `${name} 必须拒绝`);
  }
  assert.match(String(guard({ name: '' })), /工具名无效/);
  assert.match(String(guard({})), /工具名无效/);
});

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
