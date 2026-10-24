// ── Edge TTS provider ───────────────────────────────────────────────────────
//
// 用 Python 包 edge-tts（微软 Edge 浏览器「大声朗读」的同一套在线语音）合成 mp3。
// 免费、不需要 Key，代价是必须能连外网、且本机要有装了 edge-tts 的 Python。
//
// 契约（所有 provider 一致，见 src/tts/index.js 顶部注释）：
//   meta                     静态元信息
//   status(settings)         → { configured, reason }  只报告「配没配好」，不产生副作用
//   synthesize({...})        → { buffer, ext, mime, voice }
//   listVoices({...})        → { ok, voices: [{ id, gender, categories, tags }] }
//
// 为什么把文本写进临时文件再用 `--file`：中文、引号、换行、!@#$ 直接塞进命令行参数
// 会被 cmd/Windows 参数解析吃掉或截断，而 `--file` 只要求 UTF-8 文本文件。
//
// 为什么 stderr 走文件描述符而不是管道：受限沙箱下 spawn 一个 stdio:'pipe' 的子进程
// 会直接 EPERM（voice-core.js 里踩过这个坑），写文件在两个模式下都允许。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const meta = {
  id: 'edge',
  label: '微软 Edge TTS（免费 / 无需 Key）',
  needsKey: false,
  docUrl: 'https://github.com/rany2/edge-tts',
  defaults: {
    voice: 'zh-CN-XiaoyiNeural',
    rate: '+0%',
    pitch: '+0Hz',
    volume: '+0%',
    // 空 = 走 PATH 里的 python；多解释器机器上可以指到具体路径。
    python: ''
  }
};

/** 可写临时目录（合成用的文本/音频/错误日志都落在这里）。 */
function tmpDir() {
  const dir = path.join(os.tmpdir(), 'qq-tts');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pythonExe(settings = {}) {
  const raw = String(settings.python || process.env.TTS_PYTHON || 'python').trim();
  return raw || 'python';
}

/** 把子进程的 stderr 接进文件（避免 stdio:'pipe' 在沙箱里 EPERM）。 */
function openErrFile(tag) {
  try {
    const file = path.join(tmpDir(), `err-${tag}-${process.pid}-${Date.now()}.log`);
    return { file, fd: fs.openSync(file, 'w') };
  } catch {
    return { file: null, fd: 'ignore' };
  }
}

function readErrFile(file) {
  if (!file) return '';
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

function dropErrFile(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch {}
}

/** 合成失败时把 stderr 翻成人话：最常见的就是「没装包」和「没联网」。 */
function explainError(stderr, fallback) {
  const s = String(stderr || '');
  if (/ModuleNotFoundError|No module named ['"]?edge_tts/i.test(s)) {
    return 'Python 里没有安装 edge-tts（在命令行执行：pip install edge-tts）';
  }
  if (/ENOENT|not recognized as an internal or external command|无法将|不是内部或外部命令/i.test(s)) {
    return '找不到 python 解释器（确认 python 在 PATH 里，或在 tts.providers.edge.python 里写绝对路径）';
  }
  if (/Unable to connect|getaddrinfo|ProxyError|CERTIFICATE|SSL|timed? ?out|10054|10060/i.test(s)) {
    return `连不上微软语音服务（网络/代理问题）：${s.split('\n')[0]}`;
  }
  if (/Voice .* not found|Invalid voice/i.test(s)) {
    return `音色不存在：${s.split('\n')[0]}（用 --list-voices 看可用音色）`;
  }
  const first = s.split('\n').map((l) => l.trim()).filter(Boolean)[0];
  return first ? `${fallback}：${first}` : fallback;
}

// 探测结果缓存：--list-providers 会问一遍，别每次多花 200ms 起 Python。
let probeCache = null;

/** 检查 python 能不能 import edge_tts。同步、带缓存、不抛异常。 */
export function status(settings = {}) {
  const python = pythonExe(settings);
  if (probeCache && probeCache.python === python) return probeCache.result;

  const { file, fd } = openErrFile('probe');
  let result;
  try {
    const r = spawnSync(python, ['-c', 'import edge_tts'], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', fd],
      timeout: 10000
    });
    if (r.error) {
      result = { configured: false, reason: r.error.code === 'ENOENT' ? `找不到 python 解释器「${python}」` : `python 启动失败：${r.error.message}` };
    } else if (r.status === 0) {
      result = { configured: true, reason: '' };
    } else {
      const err = readErrFile(file);
      result = { configured: false, reason: explainError(err, `python -c "import edge_tts" 失败（退出码 ${r.status}）`) };
    }
  } catch (error) {
    result = { configured: false, reason: `探测 python 失败：${error?.message ?? error}` };
  } finally {
    if (typeof fd === 'number') { try { fs.closeSync(fd); } catch {} }
    dropErrFile(file);
  }
  probeCache = { python, result };
  return result;
}

/**
 * 合成一段语音。
 * @param {object} opts
 *   text     已清洗过的文本
 *   voice    音色 id（如 zh-CN-XiaoyiNeural）
 *   settings 该 provider 的配置（voice/rate/pitch/volume/python）
 *   timeoutMs 整体超时
 */
export async function synthesize({ text, voice, settings = {}, timeoutMs = 60000 } = {}) {
  const sh = { ...meta.defaults, ...settings };
  const python = pythonExe(sh);
  const finalVoice = String(voice || sh.voice || meta.defaults.voice);
  const dir = tmpDir();
  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const txtFile = path.join(dir, `in-${tag}.txt`);
  const outFile = path.join(dir, `out-${tag}.mp3`);
  const { file: errFile, fd: errFd } = openErrFile(tag);

  // 无 BOM 的 UTF-8：edge-tts 按 utf-8 读，BOM 会被念成奇怪的东西。
  fs.writeFileSync(txtFile, String(text), 'utf8');

  const args = [
    '-m', 'edge_tts',
    '--file', txtFile,
    '--voice', finalVoice,
    `--rate=${sh.rate || '+0%'}`,
    `--pitch=${sh.pitch || '+0Hz'}`,
    `--volume=${sh.volume || '+0%'}`,
    '--write-media', outFile
  ];

  try {
    const res = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(python, args, { windowsHide: true, stdio: ['ignore', 'ignore', errFd] });
      } catch (error) {
        resolve({ code: -1, error: error?.message ?? String(error) });
        return;
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve({ code: -2, error: '合成超时' });
      }, Math.max(5000, Number(timeoutMs) || 60000));
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: -1, error: e.code === 'ENOENT' ? `找不到 python 解释器「${python}」` : `python 不可用：${e.message}` });
      });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code }); });
    });

    if (res.error) throw new Error(explainError(readErrFile(errFile), res.error));
    if (res.code !== 0) throw new Error(explainError(readErrFile(errFile), `edge-tts 退出码 ${res.code}`));
    let buffer;
    try { buffer = fs.readFileSync(outFile); } catch (error) {
      throw new Error(explainError(readErrFile(errFile), `edge-tts 没有产出音频文件（${error?.message ?? error}）`));
    }
    if (!buffer.length) throw new Error(explainError(readErrFile(errFile), 'edge-tts 产出了空文件'));
    return { buffer, ext: '.mp3', mime: 'audio/mpeg', voice: finalVoice, extra: { engine: 'edge-tts' } };
  } finally {
    if (typeof errFd === 'number') { try { fs.closeSync(errFd); } catch {} }
    for (const f of [txtFile, outFile, errFile]) { try { fs.unlinkSync(f); } catch {} }
  }
}

/** 列出微软在线音色（中文优先排在前面）。 */
export async function listVoices({ settings = {}, timeoutMs = 30000 } = {}) {
  const python = pythonExe(settings);
  const { file: errFile, fd: errFd } = openErrFile(`voices-${process.pid}`);
  const outFile = path.join(tmpDir(), `voices-${process.pid}-${Date.now()}.txt`);

  const res = await new Promise((resolve) => {
    let child;
    try {
      // --list-voices 只有 stdout，没有写文件选项：用 fd 写文件代替管道。
      const outFd = fs.openSync(outFile, 'w');
      child = spawn(python, ['-m', 'edge_tts', '--list-voices'], { windowsHide: true, stdio: ['ignore', outFd, errFd] });
      child.on('error', (e) => {
        try { fs.closeSync(outFd); } catch {}
        resolve({ code: -1, error: e.message });
      });
      child.on('close', (code) => {
        try { fs.closeSync(outFd); } catch {}
        resolve({ code });
      });
      setTimeout(() => { try { child.kill(); } catch {} }, Math.max(5000, Number(timeoutMs) || 30000));
    } catch (error) {
      resolve({ code: -1, error: error?.message ?? String(error) });
    }
  });

  let text = '';
  try { text = fs.readFileSync(outFile, 'utf8'); } catch {}
  // 先把 stderr 读出来再删文件：上面的错误分支还要用它翻译成人话。
  const errText = readErrFile(errFile);
  for (const f of [outFile, errFile]) { try { fs.unlinkSync(f); } catch {} }
  if (typeof errFd === 'number') { try { fs.closeSync(errFd); } catch {} }

  if (res.error) throw new Error(explainError(errText, res.error));
  if (res.code !== 0) throw new Error(explainError(errText, `edge-tts --list-voices 退出码 ${res.code}`));

  const voices = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^Name\s/i.test(t)) continue;
    // 列：Name(1)  Gender(1)  ContentCategories(2+)  VoicePersonalities(2+)
    const cols = t.split(/\s{2,}/).map((s) => s.trim());
    if (cols.length < 2 || !/Neural$/.test(cols[0])) continue;
    voices.push({
      id: cols[0],
      gender: cols[1] || '',
      categories: cols[2] || '',
      tags: cols[3] || ''
    });
  }
  voices.sort((a, b) => {
    const rank = (v) => (v.id.startsWith('zh-CN') ? 0 : v.id.startsWith('zh-') ? 1 : 2);
    return rank(a) - rank(b) || a.id.localeCompare(b.id);
  });
  return { ok: true, voices, total: voices.length };
}
