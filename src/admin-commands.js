// 管理员命令表 + 帮助渲染 + 日志尾巴读取。
//
// 为什么单独放一个文件：命令清单以前散在 bridge.js 的 if 链里，
//   · 加一条命令要改三处（分发、帮助、文档），迟早漏；
//   · 无法单测「命令名/别名是否重复」「帮助里是不是漏了某条」。
// 现在清单是数据，`/help` 由它渲染，`scripts/test-admin-commands.mjs` 直接校验它。

import fs from 'node:fs';

/**
 * 命令清单（顺序即 /help 里的展示顺序）。
 *
 * @typedef {object} AdminCommand
 * @property {string} cmd      主命令（含斜杠）
 * @property {string[]} aliases 别名（含斜杠）
 * @property {string} usage    用法示例
 * @property {string} desc     一句话说明
 * @property {'会话'|'运行'|'消息'|'语音'|'排障'} group 分组
 */
export const ADMIN_COMMANDS = [
  { cmd: '/help', aliases: ['/?', '/命令'], usage: '/help', desc: '列出所有管理命令', group: '会话' },
  { cmd: '/status', aliases: [], usage: '/status', desc: '运行状态：模式、DSH、会话、队列、语音、日志', group: '会话' },
  { cmd: '/reset', aliases: ['/new'], usage: '/reset', desc: '重置当前会话（下次消息开新上下文）', group: '会话' },
  { cmd: '/role', aliases: [], usage: '/role [名字|off]', desc: '切换/清除角色（roles/<名字>.md）', group: '会话' },
  { cmd: '/silent', aliases: ['/quiet'], usage: '/silent', desc: '静默：群友消息不再回复，仅管理员可对话', group: '消息' },
  { cmd: '/active', aliases: ['/speak'], usage: '/active', desc: '退出静默模式', group: '消息' },
  { cmd: '/pause', aliases: [], usage: '/pause', desc: '暂停 AI 主动发言（消息仍入库，不唤醒）', group: '消息' },
  { cmd: '/resume', aliases: [], usage: '/resume', desc: '恢复 AI 主动发言', group: '消息' },
  { cmd: '/recall', aliases: ['/undo'], usage: '/recall [序号|message_id]', desc: '撤回机器人自己发过的消息', group: '消息' },
  { cmd: '/语音', aliases: ['/voice'], usage: '/语音', desc: '语音：开/关、换音色/语种、念指定文字', group: '语音' },
  { cmd: '/log', aliases: ['/logs'], usage: '/log [行数]', desc: '查看最近日志（默认 30 行，最多 200）', group: '排障' },
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
 * 渲染 /help。
 * @param {{ title?: string, note?: string }} [options]
 */
export function renderAdminHelp(options = {}) {
  const groups = new Map();
  for (const c of ADMIN_COMMANDS) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push(c);
  }
  const lines = [options.title ?? '管理命令（仅管理员可用）：', ''];
  for (const [group, items] of groups) {
    lines.push(`【${group}】`);
    for (const c of items) {
      const alias = (c.aliases ?? []).length ? `（别名 ${(c.aliases ?? []).join(' ')}）` : '';
      lines.push(`· ${c.usage} — ${c.desc}${alias}`);
    }
    lines.push('');
  }
  lines.push(options.note ?? '其余 / 开头的消息原样转给 DSH（例如 /model）。群友发这些命令不会得到任何回复。');
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
 * 渲染 `/status` 的四行摘要。
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
 *   voice?: boolean, mcpTools?: number|null, logKB?: number|null
 * }} info
 * @returns {string}
 */
export function renderStatus(info = {}) {
  const v = info.version ?? '?';
  const mode = info.mode ?? '?';
  const dsh = info.dshReady ? '就绪' : '未连上';
  const sid = info.sessionId ? `${info.sessionId}（排队 ${info.queueLen ?? 0}${info.running ? '，有回合在跑' : ''}）` : '未创建';
  return [
    `版本 v${v} · 模式 ${mode} · DSH ${dsh}`,
    `本会话 ${sid}`,
    `白名单 ${info.whitelistOk ? '通过' : '拦截'} · 角色 ${info.role ?? '无'} · 发言 ${info.speakMode ?? '?'}${info.paused ? ' · AI 已暂停' : ''}`,
    `语音 ${info.voice ? '开' : '关'} · MCP 工具 ${info.mcpTools ?? '?'} 个 · 日志 ${info.logKB == null ? '无' : `${info.logKB}KB`}`
  ].join('\n');
}
