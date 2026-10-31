// 控制台令牌注册表的单测（src/admin-tokens.js）。
//
// 为什么值得单独测：这里写错就是「控制台对所有人开门」或「谁都进不去」。
// 重点覆盖两类东西：
//   · 存储：只存 sha256、读脏数据要跳过而不是整表报废、写盘要能扛住 Windows 占用；
//   · 生命周期：签发 → 能认出；吊销 → 立刻认不出；按 QQ 吊销不影响别人。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hashAdminToken,
  readAdminTokenRegistry,
  writeAdminTokenRegistry,
  issueAdminToken,
  revokeAdminTokens,
  describeAdminTokens,
  normalizeTokenQQ
} from '../src/admin-tokens.js';

let pass = 0;
const failures = [];
function ok(condition, label) {
  if (condition) { pass += 1; console.log(`  ✓ ${label}`); }
  else { failures.push(label); console.log(`  ✗ ${label}`); }
}
function section(title) { console.log(`\n${title}`); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-admtok-'));
const file = path.join(dir, 'admin-tokens.json');

// ── 1. 哈希 ────────────────────────────────────────────────────────────────
section('1. 哈希');
ok(hashAdminToken('abc') === hashAdminToken('abc'), '同输入同哈希');
ok(hashAdminToken('abc') !== hashAdminToken('abd'), '不同输入不同哈希');
ok(/^[0-9a-f]{64}$/.test(hashAdminToken('x')), '输出是 64 位十六进制');
ok(hashAdminToken(undefined) === hashAdminToken(''), 'undefined 当空串处理，不抛错');

// ── 2. 读：缺失 / 损坏 / 脏条目 ─────────────────────────────────────────────
section('2. 读取的容错');
ok(Object.keys(readAdminTokenRegistry(path.join(dir, 'nope.json'))).length === 0, '文件不存在 → 空表');

fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
ok(Object.keys(readAdminTokenRegistry(file)).length === 0, 'JSON 损坏 → 空表（不抛错）');

fs.writeFileSync(file, JSON.stringify({ version: 2 }), 'utf8');
ok(Object.keys(readAdminTokenRegistry(file)).length === 0, '没有 tokens 字段 → 空表');

const goodHash = hashAdminToken('good-token-1234567890');
const badHashNotHex = 'zzzz';
const shortHash = 'a'.repeat(63);
fs.writeFileSync(file, JSON.stringify({
  tokens: {
    [goodHash]: { qq: 3149641864, name: '主人', role: 'owner', createdAt: 1, lastUsedAt: 2 },
    [badHashNotHex]: { qq: 1 },
    [shortHash]: { qq: 2 },
    [hashAdminToken('no-qq')]: { name: '没QQ' },
    [hashAdminToken('bad-qq')]: { qq: 'abc' },
    [hashAdminToken('null-rec')]: null
  }
}), 'utf8');
const loaded = readAdminTokenRegistry(file);
ok(Object.keys(loaded).length === 1, `只保留合法条目（实际 ${Object.keys(loaded).length} 条）`);
ok(loaded[goodHash]?.qq === 3149641864 && loaded[goodHash]?.name === '主人', '合法条目字段完整');

// ── 3. 写 / 读回环 ─────────────────────────────────────────────────────────
section('3. 写盘回环');
const tokens = {};
writeAdminTokenRegistry(file, tokens);
ok(fs.existsSync(file), '写盘后文件存在');
ok(JSON.parse(fs.readFileSync(file, 'utf8')).tokens !== undefined, '写出的结构含 tokens');
ok(!fs.existsSync(`${file}.tmp`), '不残留 .tmp 文件');

// ── 4. 签发 / 识别 / 吊销 ──────────────────────────────────────────────────
section('4. 签发与吊销');
const issued = issueAdminToken(tokens, { qq: 3149641864, name: '主人' });
ok(/^[0-9a-f]{48}$/.test(issued.token), '新令牌是 48 位十六进制（24 字节）');
ok(tokens[hashAdminToken(issued.token)]?.qq === 3149641864, '哈希能查回记录');
writeAdminTokenRegistry(file, tokens);
const afterIssue = readAdminTokenRegistry(file);
ok(afterIssue[hashAdminToken(issued.token)]?.role === 'owner', '重启（重新读盘）后仍认得');

const second = issueAdminToken(tokens, { qq: 3581863221, name: '另一个' });
ok(second.token !== issued.token, '两次签发令牌不同');
ok(Object.keys(tokens).length === 2, '两个 QQ 两条互不覆盖');

const removed = revokeAdminTokens(tokens, 3149641864);
ok(removed === 1, '按 QQ 吊销只删自己的那条');
ok(tokens[hashAdminToken(second.token)] !== undefined, '别人的令牌不受影响');
ok(revokeAdminTokens(tokens, 999999) === 0, '吊销不存在的 QQ 返回 0');

const removedAll = (() => {
  issueAdminToken(tokens, { qq: 777, name: 'a' });
  issueAdminToken(tokens, { qq: 777, name: 'b' });
  return revokeAdminTokens(tokens, 777);
})();
ok(removedAll === 2, '同一 QQ 多个令牌一次全吊销');

// ── 5. 摘要与规范化 ────────────────────────────────────────────────────────
section('5. 摘要与规范化');
const described = describeAdminTokens(tokens);
ok(Array.isArray(described) && described.length === Object.keys(tokens).length, '摘要条数与注册表一致');
ok(described.every((d) => typeof d.hash8 === 'string' && d.hash8.length === 8), '摘要把哈希截成 8 位');
ok(described.every((d) => !('token' in d) && !('hash' in d)), '摘要绝不包含明文或完整哈希');
ok(normalizeTokenQQ(' 123 ') === 123, 'normalizeTokenQQ 容忍空格');
ok(normalizeTokenQQ('abc') === null && normalizeTokenQQ(0) === null, '非法 QQ 返回 null');

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${failures.length === 0 ? '🎉 全部通过' : '❌ 有失败'}：${pass} 通过 / ${failures.length} 失败`);
if (failures.length > 0) {
  for (const f of failures) console.log(`   - ${f}`);
  process.exitCode = 1;
}
