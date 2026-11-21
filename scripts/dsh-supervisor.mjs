#!/usr/bin/env node
/**
 * DSH / 桥接 守护进程（自愈）。
 *
 * 为什么需要它：
 *   2026-11-22 凌晨，机器睡眠恢复后 DSH 3082（`DSH_HOME=~/.dsh-qq`）没回来，
 *   桥接的「端点自愈」于是把连接改到了**桌面版 DSH**（随机端口），QQ 消息被
 *   错误的 agent 处理。那次之后端点自愈默认关闭 —— 这是对的，但代价是
 *   3082 挂掉以后机器人就一直不回话，只能等人手动重启。
 *   这个脚本补上另一半：不换实例，只把**该在的那个**拉起来。
 *
 * 做什么：
 *   - 每 15 秒检查一次 DSH 3082（HTTP GET /，401/200/302 都算活着）；
 *   - 连续 2 次探测失败才动手（避免睡眠瞬间的误判）；
 *   - 用与手工启动完全相同的命令拉起：node <dsh bin> --profile web --no-open
 *     --port 3082，env 里带 DSH_HOME；
 *   - 同时看住桥接 3100（可选），挂了就按同样方式拉起；
 *   - 每个目标独立退避（30s → 60s → 120s → 300s 封顶）与每小时次数上限，
 *     防止「起不来 → 疯狂重试」把日志和 CPU 打满；
 *   - 单实例：state/supervisor.lock 里有活着的 pid 就拒绝启动。
 *
 * 不做：
 *   - 不启动、不重启 SnowLuma（它 hook 着 QQ 客户端，重启要先确认 QQ 状态，
 *     不适合无人值守地做）；它挂了会在日志里明确写出来，让人处理。
 *   - 不改任何配置，不做端口发现。
 *
 * 用法：
 *   node scripts/dsh-supervisor.mjs            # 前台（Ctrl+C 退出）
 *   node scripts/dsh-supervisor.mjs --once     # 只检查一次，打印状态后退出（排障用）
 *   start-supervisor.cmd                       # 后台静默启动（推荐）
 *
 * 环境变量（都有默认值，一般不用设）：
 *   DSH_HOME      默认 %USERPROFILE%\.dsh-qq
 *   DSH_BIN       默认 %USERPROFILE%\DshNew\node_modules\@deepseek-ai\dsh\lib\bin.js
 *   DSH_PORT      默认 3082
 *   DSH_PROFILE   默认 web
 *   BRIDGE_PORT   默认 3100
 *   SUPERVISOR_BRIDGE=0   关掉桥接监控（只守 DSH）
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE_DIR = path.join(ROOT, 'state');
const LOG_PATH = path.join(STATE_DIR, 'supervisor.log');
const LOCK_PATH = path.join(STATE_DIR, 'supervisor.lock');
// 守护拉起的实例用独立日志名：人工启动写 dsh-3082.out/.err，混在同一个 append 文件里
// 会把上一次失败的报错误认成这一次的（2026-11-22 排查时就被误导过一次）。
const DSH_LOG_OUT = path.join(ROOT, '..', 'dsh-qq-logs', 'dsh-3082.out');
const DSH_LOG_ERR = path.join(ROOT, '..', 'dsh-qq-logs', 'dsh-3082.err');
const BRIDGE_LOG_OUT = path.join(ROOT, '..', 'dsh-qq-logs', 'bridge-supervised.out');
const BRIDGE_LOG_ERR = path.join(ROOT, '..', 'dsh-qq-logs', 'bridge-supervised.err');

const HOME = os.homedir();
const CFG = {
  // 故意不读 DSH_HOME：外层环境里可能是桌面版的 ~/.dsh，被继承进来就会去启动
  // 一个「协议端还是 QQ 侧」都说不清的实例（2026-11-22 实测：拉起了 DSH_HOME=~\.dsh
  // 的实例，3082 端口当然不对）。要改就显式设 SUPERVISOR_DSH_HOME。
  dshHome: process.env.SUPERVISOR_DSH_HOME || path.join(HOME, '.dsh-qq'),
  dshBin: process.env.DSH_BIN || path.join(HOME, 'DshNew', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  dshPort: Number(process.env.DSH_PORT || 3082),
  // 同样不能继承 DSH_PROFILE：从桌面版会话里启动时它是 "desktop"，
  // 传给 CLI 就变成 `--profile desktop` → DSH 直接报
  // error: profile "desktop" is managed exclusively by the Electron application
  dshProfile: process.env.SUPERVISOR_DSH_PROFILE || 'web',
  bridgePort: Number(process.env.BRIDGE_PORT || 3100),
  watchBridge: process.env.SUPERVISOR_BRIDGE !== '0',
  intervalMs: Number(process.env.SUPERVISOR_INTERVAL_MS || 15_000),
  failThreshold: Number(process.env.SUPERVISOR_FAIL_THRESHOLD || 2),
  backoffMs: [30_000, 60_000, 120_000, 300_000],
  maxRestartsPerHour: Number(process.env.SUPERVISOR_MAX_RESTARTS || 12),
  unreadableDir: path.join(ROOT, '..', 'dsh-qq-logs')
};

const STARTED_AT = Date.now();

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(message) {
  const line = `${stamp()} [supervisor] ${message}`;
  console.log(line);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `${line}\n`, 'utf8');
  } catch {
    // 日志写不进去也不能让守护进程挂掉（这正是它要处理的那类故障）。
  }
}

/** HTTP 探活：连接被拒 = 死；401/200/302 = 活。 */
function probeHttp(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: 4000 },
      (res) => {
        res.resume();
        resolve({ alive: true, status: res.statusCode });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ alive: false, reason: 'timeout' }); });
    req.on('error', (error) => resolve({ alive: false, reason: error?.code ?? String(error) }));
    req.end();
  });
}

/** 单实例锁：活着就拒绝；死了（或不存在）就接管。 */
function acquireLock() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const raw = fs.readFileSync(LOCK_PATH, 'utf8').trim();
    const pid = Number(raw);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        return { ok: false, pid };
      } catch {
        // 进程不在了 → 接管
      }
    }
  } catch {
    // 没有锁文件 → 正常启动
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid), 'utf8');
  return { ok: true, pid: process.pid };
}

function releaseLock() {
  try {
    const pid = Number(fs.readFileSync(LOCK_PATH, 'utf8').trim());
    if (pid === process.pid) fs.rmSync(LOCK_PATH, { force: true });
  } catch {
    // 没锁就算了
  }
}

/**
 * 子进程环境：**剥掉所有 DSH_* 变量**。
 *
 * 从桌面版 DSH 的会话里启动守护进程时，环境里带着 DSH_PROFILE=desktop、
 * DSH_HOME=~\.dsh、DSH_INSTALL_DIR=<Electron asar>、DSH_NODE_EXECUTABLE=<Electron exe>、
 * DSH_WEB_URL=http://127.0.0.1:<桌面版端口> —— 这些是给**当前会话**用的上下文，
 * 继承下去会让 CLI 认为自己是桌面 profile（实测报
 * "error: profile "desktop" is managed exclusively by the Electron application"），
 * 桥接还会把 DSH_WEB_URL 当成端点候选（那正是要避免的跨实例跳转）。
 */
function childEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase().startsWith('DSH_')) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

function ensureLogDir() {
  try { fs.mkdirSync(CFG.unreadableDir, { recursive: true }); } catch {}
}

/** 拉起 DSH 3082（与手工启动参数完全一致）。 */
function startDsh() {
  ensureLogDir();
  const out = fs.openSync(DSH_LOG_OUT, 'a');
  const err = fs.openSync(DSH_LOG_ERR, 'a');
  // 桥接的令牌自动发现只扫 dsh-3082.out，所以日志要共享；每拉起一次写一行分隔符，
  // 否则混在 append 文件里无法判断某条报错是哪一次启动的。
  try {
    fs.appendFileSync(DSH_LOG_OUT, `\n=== supervisor 拉起 ${new Date().toISOString()} profile=${CFG.dshProfile} home=${CFG.dshHome} ===\n`);
    fs.appendFileSync(DSH_LOG_ERR, `\n=== supervisor 拉起 ${new Date().toISOString()} ===\n`);
  } catch {}
  // <root>/node_modules/@deepseek-ai/dsh/lib/bin.js → <root>
  const installRoot = process.env.SUPERVISOR_DSH_CWD || path.resolve(path.dirname(CFG.dshBin), '../../../../');
  try {
    const child = spawn(process.execPath, [CFG.dshBin, '--profile', CFG.dshProfile, '--no-open', '--port', String(CFG.dshPort)], {
      cwd: installRoot,
      env: childEnv({ DSH_HOME: CFG.dshHome }),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, err]
    });
    child.unref();
    log(`已拉起 DSH ${CFG.dshPort}（pid ${child.pid}，DSH_HOME=${CFG.dshHome}）`);
    return child.pid;
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
}

/** 拉起桥接（后台，日志分开写，避免与手工启动的日志混在一起）。 */
function startBridge() {
  ensureLogDir();
  const out = fs.openSync(BRIDGE_LOG_OUT, 'a');
  const err = fs.openSync(BRIDGE_LOG_ERR, 'a');
  try {
    const child = spawn(process.execPath, ['src/bridge.js'], {
      cwd: ROOT,
      env: childEnv(),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, err]
    });
    child.unref();
    log(`已拉起桥接 ${CFG.bridgePort}（pid ${child.pid}）`);
    return child.pid;
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
}

function makeTarget(name, port, spawnFn) {
  return {
    name,
    port,
    spawnFn,
    failures: 0,
    restarts: [],
    nextAttemptAt: 0,
    // 刚拉起时给它 45s 启动时间（DSH 从 spawn 到监听端口大约 10-20s）。
    // 没有这个宽限，连续失败计数会在启动中继续累加，于是重复拉起（实测过一次）。
    graceUntil: 0,
    wasAlive: null
  };
}

const targets = [
  makeTarget('DSH', CFG.dshPort, startDsh),
  ...(CFG.watchBridge ? [makeTarget('桥接', CFG.bridgePort, startBridge)] : [])
];

function restartBudgetOk(target) {
  const cutoff = Date.now() - 60 * 60 * 1000;
  target.restarts = target.restarts.filter((t) => t > cutoff);
  return target.restarts.length < CFG.maxRestartsPerHour;
}

async function tick({ once = false } = {}) {
  for (const target of targets) {
    const result = await probeHttp(target.port);
    if (result.alive) {
      if (target.wasAlive === false) {
        log(`${target.name} ${target.port} 已恢复（HTTP ${result.status}）`);
      } else if (target.wasAlive === null) {
        log(`${target.name} ${target.port} 在线（HTTP ${result.status}）`);
      }
      target.wasAlive = true;
      target.failures = 0;
      target.nextAttemptAt = 0;
      continue;
    }

    target.failures += 1;
    if (target.wasAlive !== false) {
      log(`${target.name} ${target.port} 探测失败（${result.reason}）`);
    }
    target.wasAlive = false;

    if (target.failures < CFG.failThreshold) continue;
    if (Date.now() < target.graceUntil) continue;
    if (once) {
      log(`${target.name} ${target.port} 不可用，需要重启（--once 模式不执行）`);
      continue;
    }
    if (Date.now() < target.nextAttemptAt) continue;
    if (!restartBudgetOk(target)) {
      log(`${target.name} ${target.port} 近一小时内已重启 ${target.restarts.length} 次，暂停自愈直到窗口滑出（先看日志找原因）`);
      target.nextAttemptAt = Date.now() + 300_000;
      continue;
    }

    const backoff = CFG.backoffMs[Math.min(target.restarts.length, CFG.backoffMs.length - 1)];
    target.restarts.push(Date.now());
    target.nextAttemptAt = Date.now() + backoff;
    try {
      target.spawnFn();
      target.graceUntil = Date.now() + 45_000;
    } catch (error) {
      log(`${target.name} 拉起失败：${error?.message ?? error}`);
    }
  }
}

async function main() {
  const once = process.argv.includes('--once');
  const argvIncludesUnknown = process.argv.slice(2).filter((a) => a !== '--once');
  if (argvIncludesUnknown.length > 0) {
    console.error(`未知参数：${argvIncludesUnknown.join(' ')}（只支持 --once）`);
    process.exitCode = 2;
    return;
  }

  if (!once) {
    const lock = acquireLock();
    if (!lock.ok) {
      console.error(`已有守护进程在跑（pid ${lock.pid}）；如确认它已挂，删掉 ${LOCK_PATH} 再启动`);
      process.exitCode = 1;
      return;
    }
  }

  if (!fs.existsSync(CFG.dshBin)) {
    log(`⚠️ 找不到 DSH 入口：${CFG.dshBin}（设 DSH_BIN 指向真实的 bin.js）`);
  }

  log(once
    ? '单次检查'
    : `启动守护：DSH ${CFG.dshPort} · 桥接 ${CFG.watchBridge ? CFG.bridgePort : '不监控'} · 每 ${Math.round(CFG.intervalMs / 1000)}s 一次 · 连续 ${CFG.failThreshold} 次失败才动手`);

  const cleanup = () => {
    log('收到退出信号，停止守护');
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  await tick({ once });
  if (once) return;

  // 注意：这里**不能** timer.unref()。unref 掉的定时器不持有事件循环，而下面的
  // 永久 pending Promise 也保不住进程 —— 结果就是「跑完第一轮就静默退出」：
  // 2026-11-22 第一次实测就是这样，3082 死了 80 秒都没有任何日志。
  setInterval(() => {
    void tick().catch((error) => log(`巡检异常：${error?.stack ?? error}`));
  }, CFG.intervalMs);
  await new Promise(() => {});
}

main().catch((error) => {
  log(`守护进程异常退出：${error?.stack ?? error}`);
  releaseLock();
  process.exitCode = 1;
});
