// 视频理解：把「QQ 里发来的视频」变成模型能读的东西。
//
// 模型不能播放视频，但能读**图片**和**文字**。这里复用 video-watch skill 的
// `scripts/watch.py`（uv 脚本，依赖写在文件头，首次运行自动拉 yt-dlp / Pillow /
// faster-whisper），产出正好是模型需要的两样：
//
//   · 联系表（contact sheet）：3×3 拼图，每格标 `#frame mm:ss`，一张图 = 9 个时刻
//   · 转写（transcript）：faster-whisper 本地转写，带时间戳
// 外加 report.md 里的元信息（时长/分辨率/是否有音轨）。
//
// 为什么复用 skill 而不是自己抽帧：
//   ① skill 里的抽帧包含「场景切换 + 前 3 秒 hook + 均匀网格」三种采样，自己写容易漏掉
//      hook（视频最重要的 0–3 秒）和切镜点；
//   ② 转写要 Whisper，Node 侧没有等价物，硬接 native 绑定是另一场灾难；
//   ③ 用户要的是「bot 能看视频」，同一个 watch.py 在 QQ 链路和链接链路里语义一致，
//      不会出现「群里发视频看到的东西」和「发链接看到的东西」不一样。
//
// 沙箱注意：子进程一律 `stdio: 'ignore'`（stdout/stderr 重定向到日志文件），
// 受限沙箱里 pipe 会 EPERM（同 voice-core.js / media-normalize.js 的约定）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveFfmpeg } from './voice-core.js';

/** 默认值集中一处，bridge.js 只做 config 覆盖。 */
export const VIDEO_DEFAULTS = Object.freeze({
  enabled: true,
  // 下载上限：QQ 群的短视频一般 1–30 MB；超过这个体积通常不是「随手拍的视频」。
  maxBytes: 32 * 1024 * 1024,
  // 超过这个时长不看（几十分钟的直播回放会把整轮对话卡死）。
  maxSeconds: 180,
  // 一张 3×3 联系表 = 9 帧；两页 = 18 帧，覆盖 3 分钟以内的视频足够。
  maxFrames: 18,
  maxSheets: 2,
  // faster-whisper 模型：tiny/base/small。base 是中文口播的性价比拐点。
  model: 'base',
  // 空字符串 = 让 Whisper 自动判断语种；固定 `zh` 可以避免短音频乱翻。
  language: '',
  // 整条链路（下载+抽帧+转写）的总超时。
  timeoutMs: 300000,
  // 转写文本进上下文的字符上限（Whisper 对长视频会产出几万字）。
  maxTranscriptChars: 6000,
  // 空字符串 = 自动查找。
  uvPath: '',
  scriptPath: '',
  // 首次运行要装 27 个 Python 包；默认 PyPI 在国内基本拉不动（实测 pypi.org 直接超时，
  // 清华镜像 0.6s）。留空则用 uv 自己的默认源。
  pypiIndex: 'https://pypi.tuna.tsinghua.edu.cn/simple'
});

const WIN = process.platform === 'win32';

/** 找 uv：配置 > 环境变量 > PATH > 常见安装位置。 */
export function resolveUv(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.UV_EXE) candidates.push(process.env.UV_EXE);
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, WIN ? 'uv.exe' : 'uv'));
  }
  const home = os.homedir();
  candidates.push(path.join(home, '.local', 'bin', WIN ? 'uv.exe' : 'uv'));
  candidates.push(path.join(home, '.cargo', 'bin', WIN ? 'uv.exe' : 'uv'));
  for (const candidate of candidates) {
    try {
      if (candidate && fs.statSync(candidate).isFile()) return candidate;
    } catch { /* 继续找 */ }
  }
  return null;
}

/** watch.py 的位置：配置 > 环境变量 > DSH_HOME/skills > 桌面 DSH 的 skills。 */
export function resolveWatchScript(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.QQ_VIDEO_WATCH_SCRIPT) candidates.push(process.env.QQ_VIDEO_WATCH_SCRIPT);
  for (const home of [process.env.DSH_HOME, path.join(os.homedir(), '.dsh-qq'), path.join(os.homedir(), '.dsh')]) {
    if (!home) continue;
    candidates.push(path.join(home, 'skills', 'video-watch', 'scripts', 'watch.py'));
  }
  for (const candidate of candidates) {
    try {
      if (candidate && fs.statSync(candidate).isFile()) return candidate;
    } catch { /* 继续找 */ }
  }
  return null;
}

/** ffprobe 与 ffmpeg 同目录（voice-core 已经是 ffmpeg 定位的唯一实现）。 */
function resolveFfprobe() {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) return null;
  const name = WIN ? 'ffprobe.exe' : 'ffprobe';
  const dir = path.dirname(ffmpeg);
  // resolveFfmpeg() 命中 PATH 时返回的是裸命令名（dirname = '.'），此时 ffprobe
  // 也交给 spawn 去 PATH 里找——否则会拼出 './ffprobe' 这种永远不存在的路径。
  if (dir && dir !== '.' && dir !== path.sep) {
    const probe = path.join(dir, name);
    try {
      if (fs.statSync(probe).isFile()) return probe;
    } catch { /* 同目录没有就回落到 PATH */ }
  }
  return 'ffprobe';
}

function runQuiet(cmd, args, { timeoutMs = 20000, logPath = null, env = process.env } = {}) {
  return new Promise((resolve) => {
    let fd = 'ignore';
    try {
      if (logPath) fd = fs.openSync(logPath, 'w');
    } catch { /* 开不了日志就丢弃输出 */ }
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', fd], windowsHide: true, env });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (typeof fd === 'number') fs.closeSync(fd); } catch { /* ignore */ }
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { if (WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    child.on('error', (error) => finish({ code: null, error: error?.message ?? String(error) }));
    child.on('close', (code) => finish({ code, timedOut: false }));
  });
}

/** ffprobe 读时长/分辨率/音轨（失败返回 null，不阻断主流程）。 */
export async function probeVideo(filePath) {
  const ffprobe = resolveFfprobe();
  if (!ffprobe) return null;
  const outFile = path.join(path.dirname(filePath), `.probe-${process.pid}-${Date.now()}.json`);
  const args = ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath];
  const result = await new Promise((resolve) => {
    let fd = 'ignore';
    try { fd = fs.openSync(outFile, 'w'); } catch { /* ignore */ }
    const child = spawn(ffprobe, args, { stdio: ['ignore', fd, 'ignore'], windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(false); }, 20000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
  let json = null;
  try {
    if (result) json = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch { json = null; }
  try { fs.unlinkSync(outFile); } catch { /* ignore */ }
  if (!json) return null;
  const streams = Array.isArray(json.streams) ? json.streams : [];
  const video = streams.find((s) => s?.codec_type === 'video');
  const audio = streams.find((s) => s?.codec_type === 'audio');
  const duration = Number(json.format?.duration ?? video?.duration);
  return {
    durationSec: Number.isFinite(duration) ? Math.round(duration * 10) / 10 : null,
    width: Number(video?.width) || null,
    height: Number(video?.height) || null,
    hasAudio: Boolean(audio),
    bytes: Number(json.format?.size) || null,
    format: String(json.format?.format_name ?? '')
  };
}

function readMetaFromReport(reportPath) {
  try {
    const text = fs.readFileSync(reportPath, 'utf8');
    const m = /## Source metadata\s*```json\s*([\s\S]*?)```/.exec(text);
    if (!m) return null;
    return JSON.parse(m[1]);
  } catch { return null; }
}

/**
 * 跑一遍 watch.py，把视频变成「联系表图片 + 转写 + 元信息」。
 * 返回 { ok, reason, sheets:[{name, buffer}], transcript, meta, durationSec }。
 * 永不抛错：失败也要给一句话，交给模型去解释（同 media-normalize 的取舍）。
 */
export async function digestVideo({ filePath, sourceUrl, outDir, cfg = {}, onLog = () => {} }) {
  const settings = { ...VIDEO_DEFAULTS, ...(cfg ?? {}) };
  const uv = resolveUv(settings.uvPath);
  if (!uv) return { ok: false, reason: '没找到 uv（视频理解依赖 video-watch skill 的 uv 运行时）', sheets: [] };
  const script = resolveWatchScript(settings.scriptPath);
  if (!script) return { ok: false, reason: '没找到 video-watch 的 watch.py（应位于 $DSH_HOME/skills/video-watch/scripts/watch.py）', sheets: [] };
  // 支持两种来源：本地文件（QQ 群里下载下来的）和 http(s) 链接（watch.py 内部用 yt-dlp 抓）。
  const source = String(sourceUrl || filePath || '').trim();
  if (!source) return { ok: false, reason: '没有可处理的视频来源', sheets: [] };

  fs.mkdirSync(outDir, { recursive: true });
  const logPath = path.join(outDir, 'watch.log');
  const args = ['run', '--script', script, source, '--out', outDir, '--max-frames', String(settings.maxFrames)];
  if (settings.model) args.push('--model', String(settings.model));
  if (settings.language) args.push('--language', String(settings.language));
  // 本地文件可以先探测：无音轨就不白跑一次 Whisper（模型加载就要几秒）。
  // 链接探测不了（还没下载），交给 watch.py 自己判断。
  const probe = filePath ? await probeVideo(filePath) : null;
  if (probe && probe.hasAudio === false) args.push('--no-transcript');

  onLog(`[video] watch.py 开始：${path.basename(source).slice(0, 80)}（${probe?.durationSec ?? '?'}s，${probe?.width ?? '?'}x${probe?.height ?? '?'}）`);
  const started = Date.now();
  const result = await runQuiet(uv, args, {
    timeoutMs: settings.timeoutMs,
    logPath,
    env: {
      ...process.env,
      UV_LINK_MODE: 'copy',
      UV_HTTP_TIMEOUT: process.env.UV_HTTP_TIMEOUT || '120',
      ...(settings.pypiIndex ? { UV_DEFAULT_INDEX: String(settings.pypiIndex) } : {})
    }
  });

  const sheetsDir = path.join(outDir, 'sheets');
  let sheetNames = [];
  try {
    sheetNames = fs.readdirSync(sheetsDir).filter((n) => /\.(jpe?g|png|webp)$/i.test(n)).sort();
  } catch { sheetNames = []; }
  const sheets = [];
  for (const name of sheetNames.slice(0, Math.max(1, settings.maxSheets))) {
    try {
      sheets.push({ name, buffer: fs.readFileSync(path.join(sheetsDir, name)) });
    } catch { /* 跳过读不到的图 */ }
  }

  let transcript = '';
  try {
    transcript = fs.readFileSync(path.join(outDir, 'transcript.txt'), 'utf8').trim();
    if (transcript === '(no speech detected)') transcript = '';
  } catch { /* 没有转写文件 */ }

  const meta = readMetaFromReport(path.join(outDir, 'report.md'));
  const elapsedMs = Date.now() - started;
  onLog(`[video] watch.py 结束：code=${result.code} 用时 ${Math.round(elapsedMs / 1000)}s，联系表 ${sheets.length} 张，转写 ${transcript.length} 字`);

  if (!sheets.length) {
    let tail = '';
    try { tail = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300); } catch { /* ignore */ }
    const why = result.timedOut
      ? `处理超时（>${Math.round(settings.timeoutMs / 1000)}s）`
      : (result.error || `watch.py 退出码 ${result.code}`);
    return { ok: false, reason: `${why}${tail ? `：${tail}` : ''}`, sheets: [], transcript, meta, probe };
  }
  // 联系表在转写之前就写盘了（watch.py 第 3/4 步），所以「有图没字」是可用的部分成功：
  // 常见原因是 Whisper 模型首次下载失败 / 音频解不出来。照旧把画面交给模型，
  // 只是明确告诉它「这段视频没有转写」，避免它以为视频没人说话。
  let warning = '';
  if (result.timedOut || result.code !== 0 || result.error) {
    warning = result.timedOut
      ? '转写超时，只有画面'
      : `转写失败（${result.error || `watch.py 退出码 ${result.code}`}），只有画面`;
  }
  return { ok: true, sheets, transcript, meta, probe, elapsedMs, warning };
}

/** 临时工作目录（每条视频一个，处理完删掉）。 */
export function makeVideoWorkDir(baseDir) {
  const dir = path.join(baseDir, `video-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanupVideoWorkDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
