// 管理员命令表 + 帮助渲染 + 日志尾巴读取。
//
// 为什么单独放一个文件：命令清单以前散在 bridge.js 的 if 链里，
//   · 加一条命令要改三处（分发、帮助、文档），迟早漏；
//   · 无法单测「命令名/别名是否重复」「帮助里是不是漏了某条」。
// 现在清单是数据，`/help` 由它渲染，`scripts/test-admin-commands.mjs` 直接校验它。
//
// 2026-10-31 起：每条命令带 `tier`，这是**权限真值**。分发鉴权、`/help` 过滤、
// 测试矩阵三处都读它，避免"帮助里说能用、实际被拒"这类漂移。

import fs from 'node:fs';

/**
 * QQ 号规范化：只接受正整数（字符串形式也接受）。
 * 非法值直接 throw —— 调用方在加载配置时要能一眼看到"手滑写错"，而不是静默变成 null。
 * @param {any} value
 * @returns {number|null}
 */
export function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

/**
 * 管理员分级（2026-10-31）：
 *   owners   —— 主管理，可多个；能用全部命令、能进控制台、能改名单
 *   managers —— 普通管理，可多个；**只能用 /pause /resume**，其它一切等同普通群友
 *
 * 归一化规则：
 *   · owners 为空时回落到旧的 ownerQQ（老配置、老控制台链接继续可用）；
 *   · 同一个 QQ 同时出现在两边时按 owners 算（权限取高，绝不降级）；
 *   · 单条脏数据只跳过自己，不让整个配置加载失败——否则一条手滑的 ID 就能让机器人起不来。
 *
 * @param {any} raw config.json 的 admins 段
 * @param {number|null} fallbackOwner 旧字段 ownerQQ
 * @returns {{owners:number[], managers:number[], audit:boolean}}
 */
export function normalizeAdmins(raw, fallbackOwner) {
  const parse = (list) => {
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
      try {
        const n = normalizeOwnerQQ(item);
        if (n) out.push(n);
      } catch {
        // 非法项直接忽略（例如带了空格/引号/群号）
      }
    }
    return out;
  };
  const owners = parse(raw?.owners);
  const managers = parse(raw?.managers);
  if (!owners.length && fallbackOwner) owners.push(fallbackOwner);
  const seen = new Set();
  const unique = (list) => list.filter((qq) => (seen.has(qq) ? false : (seen.add(qq), true)));
  return {
    owners: unique(owners),
    managers: unique(managers),
    audit: raw?.audit !== false
  };
}

/**
 * 命令清单（顺序即 /help 里的展示顺序）。
 *
 * @typedef {object} AdminCommand
 * @property {string} cmd      主命令（含斜杠）
 * @property {string[]} aliases 别名（含斜杠）
 * @property {string} usage    用法示例
 * @property {string} desc     一句话说明
 * @property {'会话'|'运行'|'消息'|'语音'|'排障'} group 分组
 * @property {'owner'|'manager'} tier 谁能用：owner=主管理；manager=主管理+普通管理
 */
export const ADMIN_COMMANDS = [
  { cmd: '/help', aliases: ['/?', '/命令'], usage: '/help', desc: '列出你能用的管理命令', group: '会话', tier: 'manager' },
  { cmd: '/status', aliases: [], usage: '/status', desc: '运行状态：模式、DSH、会话、队列、语音、日志', group: '会话', tier: 'owner' },
  { cmd: '/reset', aliases: ['/new'], usage: '/reset', desc: '重置当前会话（下次消息开新上下文）', group: '会话', tier: 'owner' },
  { cmd: '/role', aliases: [], usage: '/role [名字|off]', desc: '切换/清除角色（roles/<名字>.md）', group: '会话', tier: 'owner' },
  { cmd: '/silent', aliases: ['/quiet'], usage: '/silent', desc: '静默：群友消息不再回复，仅管理员可对话', group: '消息', tier: 'owner' },
  { cmd: '/active', aliases: ['/speak'], usage: '/active', desc: '退出静默模式', group: '消息', tier: 'owner' },
  { cmd: '/pause', aliases: [], usage: '/pause', desc: '暂停 AI 主动发言（消息仍入库，不唤醒）', group: '消息', tier: 'manager' },
  { cmd: '/resume', aliases: [], usage: '/resume', desc: '恢复 AI 主动发言', group: '消息', tier: 'manager' },
  { cmd: '/recall', aliases: ['/undo'], usage: '/recall [序号|message_id]', desc: '撤回机器人自己发过的消息', group: '消息', tier: 'owner' },
  { cmd: '/语音', aliases: ['/voice'], usage: '/语音', desc: '语音：开/关、换音色/语种、念指定文字', group: '语音', tier: 'owner' },
  { cmd: '/log', aliases: ['/logs'], usage: '/log [行数]', desc: '查看最近日志（默认 30 行，最多 200）', group: '排障', tier: 'owner' },
];

/** 所有命令名与别名（含斜杠），用于识别「这是不是我们的命令」。 */
export function knownCommandNames() {
  const names = [];
  for (const c of ADMIN_COMMANDS) {
    names.push(c.cmd);
    for (const a of c.aliases ?? []) names.push(a);
  }
  return names;
}

/**
 * 这条消息（`/xxx ...`）对应哪个命令的 tier。
 *
 * 只认第一个词；未知的 `/xxx` 返回 null —— 调用方按 owner 处理
 * （现状是"原样转给 DSH"，普通管理不该能触发）。
 *
 * @param {string} text 去掉 @ 前缀后的纯文本
 * @returns {'owner'|'manager'|null}
 */
export function commandTierOf(text) {
  const first = String(text ?? '').trim().split(/\s+/)[0] ?? '';
  if (!first.startsWith('/')) return null;
  const key = first.toLowerCase();
  for (const c of ADMIN_COMMANDS) {
    if (key === c.cmd.toLowerCase()) return c.tier ?? 'owner';
    for (const a of c.aliases ?? []) {
      if (key === a.toLowerCase()) return c.tier ?? 'owner';
    }
  }
  return null;
}

/**
 * 渲染 /help。
 *
 * @param {{ title?: string, note?: string, role?: 'owner'|'manager' }} [options]
 *   role=manager 时只列普通管理能用的命令（少泄露管理面）。
 */
export function renderAdminHelp(options = {}) {
  const role = options.role === 'manager' ? 'manager' : 'owner';
  const visible = ADMIN_COMMANDS.filter((c) => role === 'owner' || (c.tier ?? 'owner') === 'manager');
  const groups = new Map();
  for (const c of visible) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push(c);
  }
  const title = options.title ?? (role === 'manager' ? '你可以用的命令（普通管理）：' : '管理命令（仅管理员可用）：');
  const lines = [title, ''];
  for (const [group, items] of groups) {
    lines.push(`【${group}】`);
    for (const c of items) {
      const alias = (c.aliases ?? []).length ? `（别名 ${(c.aliases ?? []).join(' ')}）` : '';
      lines.push(`· ${c.usage} — ${c.desc}${alias}`);
    }
    lines.push('');
  }
  lines.push(options.note ?? (
    role === 'manager'
      ? '你可以暂停/恢复 AI 主动发言；其它管理命令仅主管理可用。'
      : '其余 / 开头的消息原样转给 DSH（例如 /model）。群友发这些命令不会得到任何回复。'
  ));
  return lines.join('\n').trimEnd();
}

/**
 * 读文件末尾若干行。日志是 2000 行封顶的小文件（约 200KB），整读一遍最省事，
 * 也避免「按字节 seek 到中间某行」的边界问题。
 *
 * @param {string} file
 * @param {number} count 行数（调用方负责钳制上限）
 * @returns {{ ok: boolean, lines?: string[], error?: string }}
 */
export function tailLines(file, count) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, error: error?.code === 'ENOENT' ? '日志文件还不存在（可能刚启动过）' : String(error?.message ?? error) };
  }
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const n = Math.max(1, Number(count) || 30);
  return { ok: true, lines: lines.slice(-n) };
}

/**
 * 渲染 `/status` 的摘要。
 *
 * 为什么抽成纯函数：这段文本以前直接拼在 handleIncoming 里，改一个字段就得重启桥接、
 * 还得在群里发一条命令才能看到结果，完全无法单测。抽出来后 `scripts/test-admin-commands.mjs`
 * 可以对着固定输入断言行内容，桥接侧只负责**采集**字段。
 *
 * 顺序按「排障时最先想知道什么」：版本/模式/DSH → 本会话与队列 → 权限与角色 → 资源与开关。
 *
 * @param {{
 *   version?: string, mode?: string, dshReady?: boolean,
 *   sessionId?: string|null, queueLen?: number, running?: boolean,
 *   whitelistOk?: boolean, role?: string|null, speakMode?: string|null, paused?: boolean,
 *   pausedBy?: string|null,
 *   voice?: boolean, mcpTools?: number|null, logKB?: number|null
 * }} info
 * @returns {string}
 */
export function renderStatus(info = {}) {
  const v = info.version ?? '?';
  const mode = info.mode ?? '?';
  const dsh = info.dshReady ? '就绪' : '未连上';
  const sid = info.sessionId ? `${info.sessionId}（排队 ${info.queueLen ?? 0}${info.running ? '，有回合在跑' : ''}）` : '未创建';
  // pausedBy 现在是 { qq, name, at, role } 对象（分级后要知道"谁停的"）；
  // 兼容旧版纯字符串（历史状态文件里可能是字符串），别让 /status 直接打 [object Object]。
  const by = info.pausedBy;
  const byText = by ? (typeof by === 'string' ? by : `${by.name ?? '?'}/${by.qq ?? '?'}`) : null;
  const pausedText = info.paused ? ` · AI 已暂停${byText ? `（${byText}）` : ''}` : '';
  const tierText = { owner: '主管理', manager: '普通管理', user: '群友' }[info.adminRole] ?? null;
  return [
    `版本 v${v} · 模式 ${mode} · DSH ${dsh}`,
    `本会话 ${sid}`,
    `白名单 ${info.whitelistOk ? '通过' : '拦截'} · 角色 ${info.role ?? '无'} · 发言 ${info.speakMode ?? '?'}${pausedText}`,
    `语音 ${info.voice ? '开' : '关'} · MCP 工具 ${info.mcpTools ?? '?'} 个 · 日志 ${info.logKB == null ? '无' : `${info.logKB}KB`}${tierText ? ` · 你的身份 ${tierText}` : ''}`
  ].join('\n');
}
