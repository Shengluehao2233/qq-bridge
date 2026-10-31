#!/usr/bin/env node
// 一键健康检查：把「哪里坏了」从手工排查变成五条断言。
//
// 为什么需要它：
//   这套系统的失败形态很多，而且**多数都不报错**——
//     · SnowLuma 进程活着但 QQ 没登录 → OneBot HTTP 直接 403/超时；
//     · 桥接没起 → 群里完全没反应，控制台也打不开；
//     · DSH 没起 → 桥接日志刷「DSH 不可用」，消息只入队；
//     · **MCP 工具表是旧的** → 模型看不到新加的工具（改完代码只重启桥接就会这样）。
//   最后一条最坑：所有服务都是绿的，只有行为不对。
//
// 用法：
//   node scripts/health-check.mjs            # 人读格式，红一项即 exit 1
//   node scripts/health-check.mjs --json     # 给脚本/监控用
//   node scripts/health-check.mjs --fix      # 桥接没起时尝试拉起（其余只报告，不自动重启 DSH）
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(ROOT, 'state');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const wantFix = args.includes('--fix');

function readJsonSafe(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const cfg = readJsonSafe(path.join(ROOT, 'config.json'), {}) || {};
const onebot = {
  http: String(cfg.snowluma?.httpUrl ?? 'http://127.0.0.1:3000'),
  ws: String(cfg.snowluma?.wsUrl ?? 'ws://127.0.0.1:3001'),
  token: String(cfg.snowluma?.accessToken ?? '')
};
const bridgePort = Number(cfg.consolePort) || 3100;
const dshPort = (() => {
  const raw = String(cfg.dsh?.baseUrl ?? '');
  const m = /:(\d+)/.exec(raw);
  return m ? Number(m[1]) : 3082;
})();
const consoleToken = (() => {
  if (cfg.consoleToken) return String(cfg.consoleToken);
  try { return fs.readFileSync(path.join(STATE_DIR, 'console-token'), 'utf8').trim(); } catch { return ''; }
})();

const results = [];
function report(name, level, detail, fix) {
  results.push({ name, level, detail, fix });
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 6000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { res, body };
}

function tcpCheck(port, host = '127.0.0.1', timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => { try { socket.destroy(); } catch {} resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function dshProcessStartMs() {
  // 拿 3082 的监听进程启动时间。只用平台自带工具，不引新依赖。
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
    const line = out.split(/\r?\n/).find((l) => l.includes(`:${dshPort}`) && /LISTENING/i.test(l));
    if (!line) return null;
    const pid = Number(line.trim().split(/\s+/).pop());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const ps = execFileSync('powershell', ['-NoProfile', '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().ToString('o')`],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const ms = Date.parse(ps.trim());
    return { pid, startMs: Number.isFinite(ms) ? ms : null };
  } catch {
    return null;
  }
}

async function checkOneBot() {
  // 1) HTTP API + 账号登录态。注意 get_login_info 只回 user_id/nickname，
  //    别指望它带 status.good（那是 get_status 的字段，取错了不会报错）。
  try {
    const headers = onebot.token ? { authorization: `Bearer ${onebot.token}` } : {};
    const { res, body } = await fetchWithTimeout(`${onebot.http}/get_login_info`, { headers });
    if (!res.ok) {
      report('SnowLuma OneBot HTTP', 'fail', `HTTP ${res.status}（token 可能不对，或 OneBot 没起）`, '启动 SnowLuma，或核对 config.json 的 snowluma.accessToken');
      return;
    }
    if (body?.retcode !== 0) {
      report('SnowLuma OneBot HTTP', 'fail', `retcode=${body?.retcode} ${body?.message ?? body?.wording ?? ''}`.trim(), '检查 SnowLuma 是否已登录 QQ');
      return;
    }
    const uid = body?.data?.user_id;
    const nick = body?.data?.nickname;
    report('SnowLuma OneBot HTTP', 'ok', `${onebot.http} · 账号 ${uid}「${nick}」`);
  } catch (error) {
    report('SnowLuma OneBot HTTP', 'fail', `${onebot.http} 不可达（${error?.code ?? error?.message ?? error}）`, '启动 SnowLuma（C:\\SnowLuma）');
  }
}

async function checkOneBotWs() {
  const port = (() => {
    try { return Number(new URL(onebot.ws).port) || 0; } catch { return 0; }
  })();
  if (!port) { report('OneBot WebSocket', 'warn', `wsUrl 解析不出端口：${onebot.ws}`); return; }
  const ok = await tcpCheck(port);
  if (ok) report('OneBot WebSocket', 'ok', `127.0.0.1:${port} 可连`);
  else report('OneBot WebSocket', 'fail', `127.0.0.1:${port} 连不上`, 'SnowLuma 的 WS 服务没起来；看 C:\\SnowLuma\\logs');
}

async function checkBridge() {
  const url = `http://127.0.0.1:${bridgePort}/api/status`;
  const headers = consoleToken ? { 'x-console-token': consoleToken } : {};
  try {
    const { res, body } = await fetchWithTimeout(url, { headers });
    if (res.status === 401) {
      report('桥接（qq-bridge）', 'fail', 'HTTP 401：控制台令牌不对', `核对 state/console-token（或 config.json 的 consoleToken）`);
      return null;
    }
    if (!res.ok) {
      report('桥接（qq-bridge）', 'fail', `HTTP ${res.status}`, `看 qq-bridge 日志`);
      return null;
    }
    const mode = body?.mode ?? '?';
    const ready = body?.dshReady === true;
    const owner = body?.ownerQQ ?? '?';
    if (!ready) {
      report('桥接（qq-bridge）', 'fail', `端口通但 dshReady=false（mode=${mode}）`, `DSH ${dshPort} 没起来或桥接还没连上，先起 DSH`);
    } else {
      report('桥接（qq-bridge）', 'ok', `:${bridgePort} · mode=${mode} · dshReady=true · ownerQQ=${owner}`);
    }
    return body;
  } catch (error) {
    report('桥接（qq-bridge）', 'fail', `127.0.0.1:${bridgePort} 不可达（${error?.code ?? error?.message ?? error}）`, '启动 qq-bridge（start.bat 或 start-all.cmd）');
    return null;
  }
}

async function checkDsh() {
  try {
    const res = await fetch(`http://127.0.0.1:${dshPort}/`, { redirect: 'manual', signal: AbortSignal.timeout(6000) });
    if ([200, 302, 401, 403].includes(res.status)) {
      report('DSH 实例', 'ok', `127.0.0.1:${dshPort} 在（HTTP ${res.status}${res.status === 401 ? '，需要令牌才能进页面' : ''}）`);
    } else {
      report('DSH 实例', 'fail', `127.0.0.1:${dshPort} 返回 HTTP ${res.status}`, '看 ~/.dsh-qq/logs 最新日志');
    }
  } catch (error) {
    report('DSH 实例', 'fail', `127.0.0.1:${dshPort} 不可达（${error?.code ?? error?.message ?? error}）`, '启动 start-dsh-qq.cmd');
  }
}

function checkMcpTools() {
  const snapshot = readJsonSafe(path.join(STATE_DIR, 'mcp-tools.json'), null);
  if (!snapshot) {
    report('MCP 工具表', 'warn', '还没有 state/mcp-tools.json（说明 MCP 进程从未用新版本启动过）', '重启 DSH 让 MCP 重新拉起');
    return;
  }
  const started = Date.parse(snapshot.startedAt ?? '');
  const info = dshProcessStartMs();
  const detail = `${snapshot.count} 个工具 · 快照 ${snapshot.startedAt}`;
  if (!Number.isFinite(started)) { report('MCP 工具表', 'warn', `${detail}（时间解析失败）`); return; }
  if (!info?.startMs) {
    // 拿不到 DSH 启动时间就只能给「新鲜度」这条弱信号：超过 12 小时提示一下。
    const ageH = (Date.now() - started) / 3600_000;
    report('MCP 工具表', ageH > 12 ? 'warn' : 'ok', `${detail}（拿不到 DSH 进程启动时间，按年龄判断 ${ageH.toFixed(1)}h）`);
    return;
  }
  if (started < info.startMs - 2000) {
    report('MCP 工具表', 'fail', `${detail} · 比 DSH 进程（pid ${info.pid}）还旧 → 工具表是上一代`, '重启 DSH 3082：MCP 工具表只在 DSH 启动时加载');
  } else {
    report('MCP 工具表', 'ok', `${detail} · 比 DSH（pid ${info.pid}）新，工具表是当前的`);
  }
}

function startBridgeDetached() {
  const logFile = path.join(ROOT, 'state', 'bridge.log');
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'bridge.js')], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
    windowsHide: true
  });
  child.unref();
  return child.pid;
}

async function main() {
  await checkOneBot();
  await checkOneBotWs();
  let bridge = await checkBridge();
  if (!bridge && wantFix) {
    try {
      const pid = startBridgeDetached();
      report('自动修复', 'warn', `已尝试拉起桥接（pid ${pid}），等 8 秒复检`);
      await new Promise((r) => setTimeout(r, 8000));
      bridge = await checkBridge();
    } catch (error) {
      report('自动修复', 'fail', `拉起桥接失败：${error?.message ?? error}`, '手动运行 start.bat');
    }
  }
  await checkDsh();
  checkMcpTools();

  if (asJson) {
    const fails = results.filter((r) => r.level === 'fail');
    process.stdout.write(`${JSON.stringify({ ok: fails.length === 0, results }, null, 2)}\n`);
    process.exitCode = fails.length ? 1 : 0;
    return;
  }

  const icon = { ok: '✅', warn: '⚠️ ', fail: '❌' };
  console.log('');
  for (const r of results) {
    console.log(`${icon[r.level]} ${r.name}：${r.detail}`);
    if (r.level !== 'ok' && r.fix) console.log(`   └─ 处理：${r.fix}`);
  }
  const fails = results.filter((r) => r.level === 'fail').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  console.log('');
  console.log(fails === 0
    ? (warns === 0 ? '全部正常。' : `可用，但有 ${warns} 项提示。`)
    : `${fails} 项异常，需要处理。`);
  process.exitCode = fails ? 1 : 0;
}

main().catch((error) => {
  console.error(`健康检查自身出错：${error?.stack ?? error}`);
  process.exitCode = 2;
});
