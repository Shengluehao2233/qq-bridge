// 管理员命令表 + /help、/status 渲染 + 日志尾巴读取的单测。
//
// 这些是**纯数据/纯文本**，不碰网络、不碰 QQ，所以能在这里全量断言：
//   · 命令表本身要自洽（无重名、别名不撞车、每条都有用法说明）；
//   · /help 必须把所有命令都列出来（漏一条用户就不知道有这功能）；
//   · /status 的四种典型输入（全新会话 / 有排队 / 暂停中 / 拿不到指标）都要正常；
//   · tailLines 的两种失败模式（文件不存在、行数被钳制）。
//
// 为什么值得写：命令分发在 bridge.js 里是 200 行的 if 链，改一个分支后面就断了。
// 命令表与渲染抽到 admin-commands.js 后，这里就是那道回归网。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ADMIN_COMMANDS, knownCommandNames, renderAdminHelp, renderStatus, tailLines, commandTierOf, normalizeAdmins, normalizeOwnerQQ } from '../src/admin-commands.js';

let pass = 0;
const failures = [];

function ok(condition, label) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ── 1. 命令表自洽 ────────────────────────────────────────────────────────────
section('1. 命令表');
ok(Array.isArray(ADMIN_COMMANDS) && ADMIN_COMMANDS.length > 0, `ADMIN_COMMANDS 非空（${ADMIN_COMMANDS.length} 条）`);

const canonicals = ADMIN_COMMANDS.map((c) => c.cmd);
ok(new Set(canonicals).size === canonicals.length, '主命令名无重复');

const badShape = ADMIN_COMMANDS.filter((c) => !/^\/\S+$/.test(c.cmd ?? '') || typeof c.usage !== 'string' || !c.usage || !Array.isArray(c.aliases ?? []));
ok(badShape.length === 0, `每条都有 /name、usage、aliases（不合格 ${badShape.length} 条）`);

const aliasDuplicates = ADMIN_COMMANDS.flatMap((c) => (c.aliases ?? []).filter((a) => canonicals.includes(a)));
ok(aliasDuplicates.length === 0, `别名不与主命令名相撞（${aliasDuplicates.join(',') || '无'}）`);

const allNames = knownCommandNames();
ok(new Set(allNames).size === allNames.length, `knownCommandNames() 无重复（${allNames.length} 个名字）`);

const lowerNames = allNames.map((n) => n.toLowerCase());
ok(new Set(lowerNames).size === lowerNames.length, '命令名大小写归一后仍不重复');

// ── 2. /help 全文 ───────────────────────────────────────────────────────────
section('2. renderAdminHelp()');
const help = renderAdminHelp();
ok(typeof help === 'string' && help.length > 200, `非空且有内容（${help.length} 字符）`);
ok(ADMIN_COMMANDS.every((c) => (c.aliases ?? []).every((a) => help.includes(a)) || help.includes(c.usage)), '每条命令的用法/别名都出现在文本里');
ok(help.includes('仅管理员可用'), '开头点明「仅管理员可用」');
ok(!help.includes('undefined'), '没有 undefined 泄漏');
ok(help.length < 1500, `长度可控（${help.length} < 1500，避免被 QQ 拆成多条）`);
ok(renderAdminHelp({ note: '自定义尾注' }).endsWith('自定义尾注'), 'note 选项覆盖默认尾注');

// ── 3. /status 渲染 ─────────────────────────────────────────────────────────
section('3. renderStatus()');
const full = renderStatus({
  version: '0.2.1', mode: 'reserved2', dshReady: true, sessionId: 'sess-abc12345',
  queueLen: 2, running: true, whitelistOk: true, role: '大肥鱼', speakMode: 'speak',
  paused: false, voice: true, mcpTools: 38, logKB: 128
}).split('\n');
ok(full.length === 4, `固定四行（实际 ${full.length}）`);
ok(full[0].includes('v0.2.1') && full[0].includes('reserved2') && full[0].includes('就绪'), '第一行：版本/模式/DSH');
ok(full[1].includes('sess-abc12345') && full[1].includes('排队 2') && full[1].includes('有回合在跑'), '第二行：会话/队列/在跑');
ok(full[2].includes('通过') && full[2].includes('大肥鱼') && full[2].includes('speak'), '第三行：白名单/角色/发言');
ok(full[3].includes('语音 开') && full[3].includes('38 个') && full[3].includes('128KB'), '第四行：语音/MCP/日志');

const fresh = renderStatus({ version: 'x', mode: 'chat', dshReady: false, sessionId: null, whitelistOk: false, logKB: null });
ok(fresh.includes('未创建') && fresh.includes('未连上') && fresh.includes('拦截') && fresh.includes('日志 无'), '全新会话/指标缺失时的降级文本');
ok(renderStatus({}).includes('版本 v?'), '空入参不抛错（未知字段用 ? 占位）');
ok(renderStatus({ paused: true, sessionId: 's' }).includes('AI 已暂停'), '暂停标记只在 paused=true 时出现');
ok(!renderStatus({ sessionId: 's' }).includes('AI 已暂停'), '未暂停时不出现暂停标记');

// ── 4. tailLines ───────────────────────────────────────────────────────────
section('4. tailLines()');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-admin-'));
const logFile = path.join(tmpDir, 'sample.log');
fs.writeFileSync(logFile, Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join('\n') + '\n', 'utf8');

const missing = tailLines(path.join(tmpDir, 'nope.log'), 10);
ok(missing.ok === false && /不存在/.test(missing.error ?? ''), '文件不存在时给出可读原因');

const tail5 = tailLines(logFile, 5);
ok(tail5.ok && tail5.lines.length === 5 && tail5.lines.at(-1) === 'line-50', '取最后 5 行且顺序正确');

const tailAll = tailLines(logFile, 999);
ok(tailAll.lines.length === 50, '请求行数超过文件时不报错，返回全部');

const tailDefault = tailLines(logFile, 0);
ok(tailDefault.lines.length === 30, '行数非法（0）时退回默认 30 行');

fs.rmSync(tmpDir, { recursive: true, force: true });

// ── 5. 权限分级（2026-10-31）────────────────────────────────────────────────
section('5. 权限分级');
ok(ADMIN_COMMANDS.every((c) => c.tier === 'owner' || c.tier === 'manager'), '每条命令都有合法 tier');
const managerCmds = ADMIN_COMMANDS.filter((c) => c.tier === 'manager').map((c) => c.cmd).sort();
ok(JSON.stringify(managerCmds) === JSON.stringify(['/help', '/pause', '/resume']), `普通管理只放行这三条（实际 ${managerCmds.join(' ')}）`);

ok(commandTierOf('/pause') === 'manager' && commandTierOf('/resume') === 'manager', 'commandTierOf 认出 /pause /resume');
ok(commandTierOf('/pause  ')/* 尾随空格 */ === 'manager', 'commandTierOf 容忍尾随空格');
ok(commandTierOf('/status') === 'owner', 'commandTierOf(/status) = owner');
ok(commandTierOf('/nonexistent') === null, '未知命令返回 null（普通管理静默的关键）');
ok(commandTierOf('') === null && commandTierOf(null) === null, '空输入不抛错');
ok(commandTierOf('随便聊聊') === null, '不以 / 开头的内容不算命令');

const managerHelp = renderAdminHelp({ role: 'manager' });
ok(/普通管理/.test(managerHelp), 'manager 版帮助有身份提示');
ok(/\/pause/.test(managerHelp) && /\/resume/.test(managerHelp), 'manager 版帮助包含 pause/resume');
ok(!/\/status/.test(managerHelp) && !/\/log/.test(managerHelp), 'manager 版帮助不泄露主管理命令');
const ownerHelp = renderAdminHelp({ role: 'owner' });
ok(/\/status/.test(ownerHelp) && /\/log/.test(ownerHelp), 'owner 版帮助包含全部命令');
ok(renderAdminHelp().split('\n').length === ownerHelp.split('\n').length, '不传 role 时等价于 owner（向后兼容旧调用）');

const norm1 = normalizeAdmins({}, 3149641864);
ok(JSON.stringify(norm1.owners) === '[3149641864]' && norm1.managers.length === 0, 'admins 为空时回落到 ownerQQ');
ok(norm1.audit === true, '默认开启审计');

const norm2 = normalizeAdmins({ owners: [1, 1, 'x', 2], managers: [2, 3], audit: false }, null);
ok(JSON.stringify(norm2.owners) === '[1,2]', 'owners 去重且丢弃非法项');
ok(JSON.stringify(norm2.managers) === '[3]', '同一 QQ 两边都有时按 owners 算（不重复进 managers）');
ok(norm2.audit === false, 'audit:false 生效');

const norm3 = normalizeAdmins({ owners: [], managers: [5] }, 7);
ok(JSON.stringify(norm3.owners) === '[7]', 'owners 显式为空数组时也回落到 ownerQQ');
const norm4 = normalizeAdmins({ owners: ['', null, 'abc', -1, 0] }, null);
ok(norm4.owners.length === 0, '全是脏数据时不崩、返回空名单（fail-closed 由调用方决定）');

ok(normalizeOwnerQQ(' 3149641864 ') === 3149641864, 'normalizeOwnerQQ 容忍空格');
ok(normalizeOwnerQQ(null) === null && normalizeOwnerQQ('') === null, '空值返回 null');
let threw = false;
try { normalizeOwnerQQ('abc'); } catch { threw = true; }
ok(threw, '非法 ownerQQ 抛错（配置写错要立刻暴露）');

const statusWithTier = renderStatus({ version: '1.0', mode: 'reserved2', dshReady: true, paused: true, pausedBy: { qq: 1, name: '小明' }, adminRole: 'owner' });
ok(/小明\/1/.test(statusWithTier), 'pausedBy 是对象时显示「名字/QQ」而不是 [object Object]');
ok(/你的身份 主管理/.test(statusWithTier), 'status 显示调用者身份');
const statusLegacy = renderStatus({ paused: true, pausedBy: '旧字符串' });
ok(/旧字符串/.test(statusLegacy), '兼容旧版 pausedBy 字符串');

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? '🎉 全部通过' : '❌ 有失败'}：${pass} 通过 / ${failures.length} 失败`);
if (failures.length > 0) {
  for (const f of failures) console.log(`   - ${f}`);
  process.exitCode = 1;
}
