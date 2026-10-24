// ── TTS 内核：provider 抽象 + 文本校验 + 落盘 + 时长探测 ───────────────────────
//
// 设计目标：**换 TTS 引擎不改调用方**。桥接（将来的 qq_speak 工具）、CLI（scripts/tts.mjs）、
// 控制台都只调这里的 synthesize()，具体是哪家服务由 config.tts.provider 决定。
//
// ── provider 契约（新增一家只需实现这三样，然后登记到 PROVIDERS）──────────────
//   export const meta = {
//     id, label, needsKey, docUrl,
//     defaults: { voice, ... }        // 该 provider 的默认配置，会被 config 覆盖
//   }
//   export function status(settings) → { configured: boolean, reason: string }
//   export async function synthesize({ text, voice, settings, timeoutMs })
//        → { buffer: Buffer, ext: '.mp3', mime, voice, extra? }
//   [可选] export async function listVoices({ settings }) → { ok, voices: [...] }
//
// 为什么 provider 只返回内存里的 Buffer、由这里统一落盘：
//   · 落盘要处理 OneDrive 上的 EPERM rename（见 writeFileAtomic），只写一份实现；
//   · 时长/合法性校验统一走 voice-core.inspectAudio，保证「TTS 出来的音频」和
//     「用户自己放进语音库的音频」过的是同一道闸；
//   · 想改成存 OSS / 直接发字节，只需要换写文件这一段。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectAudio } from '../voice-core.js';
import * as edge from './providers/edge.js';
import * as openai from './providers/openai.js';
import * as azure from './providers/azure.js';
import * as siliconflow from './providers/siliconflow.js';

export const PROVIDERS = Object.fromEntries(
  [edge, openai, azure, siliconflow].map((p) => [p.meta.id, p])
);

/** 默认配置。config.json 里只需写想改的字段。 */
export const DEFAULT_TTS = {
  // AI 能不能「自己开口」的总闸。false 时只有操作者（CLI/控制台）能合成并发语音。
  enabled: false,
  provider: 'edge',
  // 单条文本上限（按「字」算，不是字节）。语音条太长没人听，也费钱。
  maxChars: 200,
  // 相对仓库根目录；TTS 产物默认落在语音库里，方便直接用 qq_send_voice / send-voice.mjs 发。
  outputDir: 'audio/tts',
  // 合成整体超时
  timeoutMs: 60000,
  providers: {}
};

/** 这些字符进了 TTS 只会让引擎读出一堆停顿/乱码，提前剥掉。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export class TtsError extends Error {
  constructor(message, { code = 'tts_error' } = {}) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
  }
}

function plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/**
 * 把 config.json 里的 tts 段规整成「一定完整」的样子。
 * 所有数字都夹在安全区间：配置是手写的，写成 0 / 负数 / 字符串时不能等于「不设上限」。
 */
export function normalizeConfig(raw) {
  const src = plainObject(raw);
  const provider = PROVIDERS[src.provider] ? String(src.provider) : DEFAULT_TTS.provider;

  const clampInt = (v, min, max, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, Math.round(n)));
  };

  const providers = {};
  for (const [id, mod] of Object.entries(PROVIDERS)) {
    providers[id] = { ...plainObject(mod.meta.defaults), ...plainObject(plainObject(src.providers)[id]) };
  }

  return {
    enabled: src.enabled === true,
    provider,
    maxChars: clampInt(src.maxChars, 1, 1000, DEFAULT_TTS.maxChars),
    outputDir: String(src.outputDir || DEFAULT_TTS.outputDir),
    timeoutMs: clampInt(src.timeoutMs, 5000, 180000, DEFAULT_TTS.timeoutMs),
    providers
  };
}

/**
 * 文本预处理：剥控制字符、统一换行、去首尾空白、按「字」校验长度。
 * 返回 { text, chars }；超长直接抛错 —— 悄悄截断会让模型以为整段都被念了。
 */
export function prepareText(input, { maxChars = DEFAULT_TTS.maxChars } = {}) {
  const cleaned = String(input ?? '')
    .replace(/\r\n/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!cleaned) throw new TtsError('文本为空，没有可念的内容', { code: 'empty_text' });
  const chars = [...cleaned].length;
  const limit = Math.max(1, Number(maxChars) || DEFAULT_TTS.maxChars);
  if (chars > limit) {
    throw new TtsError(`文本太长：${chars} 字，超过上限 ${limit} 字（config.tts.maxChars）`, { code: 'text_too_long' });
  }
  return { text: cleaned, chars };
}

/** 解析「用哪个 provider」：显式入参 > 配置 > 默认。未知 id 直接报错，不静默降级。 */
export function resolveProvider(config, id) {
  const cfg = normalizeConfig(config);
  const wanted = String(id || cfg.provider || DEFAULT_TTS.provider).trim();
  const mod = PROVIDERS[wanted];
  if (!mod) {
    throw new TtsError(`未知的 TTS 提供方「${wanted}」（可选：${Object.keys(PROVIDERS).join(' / ')}）`, { code: 'unknown_provider' });
  }
  return { mod, settings: cfg.providers[mod.meta.id] ?? {}, cfg };
}

/**
 * 合成一段语音并落盘。
 * @returns {Promise<{ok, path, bytes, duration, provider, providerLabel, voice, text, chars, ms, warnings}>}
 */
export async function synthesize(input, {
  config = null,
  provider = null,
  voice = null,
  outDir = null,
  filename = null,
  maxChars = null,
  timeoutMs = null,
  // 临时覆盖某家 provider 的配置（CLI 的 --rate/--pitch/--voice 之类走这里，不写回 config.json）
  settingsOverride = null
} = {}) {
  const resolved = resolveProvider(config, provider);
  const { mod, cfg } = resolved;
  const settings = { ...resolved.settings, ...plainObject(settingsOverride) };
  const st = typeof mod.status === 'function' ? mod.status(settings) : { configured: true, reason: '' };
  if (!st.configured) {
    throw new TtsError(`TTS 提供方「${mod.meta.label}」还没配好：${st.reason}`, { code: 'provider_unconfigured' });
  }

  const body = prepareText(input, { maxChars: maxChars ?? cfg.maxChars });
  const finalVoice = String(voice || settings.voice || mod.meta.defaults?.voice || '').trim();
  const started = Date.now();

  const result = await mod.synthesize({
    text: body.text,
    voice: finalVoice,
    settings,
    timeoutMs: timeoutMs ?? cfg.timeoutMs
  });
  if (!result || !Buffer.isBuffer(result.buffer) || result.buffer.length === 0) {
    throw new TtsError(`「${mod.meta.label}」没有返回音频`, { code: 'empty_audio' });
  }

  const dir = path.resolve(outDir || cfg.outputDir);
  fs.mkdirSync(dir, { recursive: true });
  const ext = /^\.[a-z0-9]{1,5}$/i.test(String(result.ext || '')) ? result.ext : '.mp3';
  const name = filename
    ? path.basename(String(filename))
    : `tts-${stamp()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const file = path.join(dir, name);

  writeFileAtomic(file, result.buffer);

  // 时长探测失败不算致命：音频已经落盘，发出去由网关自己判断。
  const info = await inspectAudio(file, { ffprobePath: process.env.FFPROBE_PATH || 'ffprobe' }).catch((error) => ({
    ok: false,
    warnings: [`音频探测异常：${error?.message ?? error}`]
  }));

  return {
    ok: true,
    path: file,
    bytes: fs.statSync(file).size,
    duration: Number.isFinite(info?.duration) ? info.duration : null,
    provider: mod.meta.id,
    providerLabel: mod.meta.label,
    voice: finalVoice,
    text: body.text,
    chars: body.chars,
    ms: Date.now() - started,
    warnings: info?.warnings ?? []
  };
}

/** 每家 provider 的「配没配好」一览（给 CLI 和将来的控制台用）。 */
export function listProviders(config) {
  const cfg = normalizeConfig(config);
  return Object.values(PROVIDERS).map((mod) => {
    const settings = cfg.providers[mod.meta.id] ?? {};
    let st = { configured: true, reason: '' };
    if (typeof mod.status === 'function') {
      try { st = mod.status(settings); } catch (error) { st = { configured: false, reason: error?.message ?? String(error) }; }
    }
    return {
      id: mod.meta.id,
      label: mod.meta.label,
      needsKey: mod.meta.needsKey === true,
      active: cfg.provider === mod.meta.id,
      configured: st.configured === true,
      reason: st.reason || '',
      voice: String(settings.voice || mod.meta.defaults?.voice || ''),
      docUrl: mod.meta.docUrl || ''
    };
  });
}

/** 列音色（只有实现了 listVoices 的 provider 支持）。 */
export async function listVoices({ config = null, provider = null, timeoutMs = null } = {}) {
  const { mod, settings, cfg } = resolveProvider(config, provider);
  if (typeof mod.listVoices !== 'function') {
    return { ok: false, provider: mod.meta.id, error: `「${mod.meta.label}」不支持列出音色` };
  }
  const st = typeof mod.status === 'function' ? mod.status(settings) : { configured: true };
  if (!st.configured) {
    return { ok: false, provider: mod.meta.id, error: `「${mod.meta.label}」还没配好：${st.reason}` };
  }
  const res = await mod.listVoices({ settings, timeoutMs: timeoutMs ?? cfg.timeoutMs });
  return { ...res, provider: mod.meta.id, providerLabel: mod.meta.label, current: String(settings.voice || mod.meta.defaults?.voice || '') };
}

// ── 落盘 ────────────────────────────────────────────────────────────────────

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 原子写文件：先写 .tmp 再 rename。
 * OneDrive 目录上 rename 会被杀软/同步进程短暂占用并抛 EPERM，这里重试 5 次（20/40/80ms…）
 * 后仍失败就退化成「直接覆盖写」——宁可非原子，也不要整个 TTS 失败。
 */
export function writeFileAtomic(file, buffer, { retries = 5 } = {}) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, buffer);
  let wait = 20;
  for (let i = 0; i < retries; i += 1) {
    try {
      fs.renameSync(tmp, file);
      return { ok: true, atomic: true };
    } catch (error) {
      if (i === retries - 1) {
        try { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); return { ok: true, atomic: false }; }
        catch (copyError) {
          try { fs.unlinkSync(tmp); } catch {}
          throw new TtsError(`音频写入失败：${copyError?.message ?? copyError}`, { code: 'write_failed' });
        }
      }
      const until = Date.now() + wait;
      while (Date.now() < until) { /* 忙等几十毫秒，避免引入异步 */ }
      wait *= 2;
    }
  }
  return { ok: true, atomic: false };
}

/** 清理旧的 TTS 产物（保留最近 keep 个），返回删除数量。 */
export function pruneOutputs(dir, { keep = 50 } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter((f) => /^tts-.*\.(mp3|wav|ogg|m4a)$/i.test(f))
      .map((f) => {
        const p = path.join(dir, f);
        try { return { p, m: fs.statSync(p).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.m - a.m);
  } catch { return 0; }
  let removed = 0;
  for (const item of files.slice(Math.max(0, keep))) {
    try { fs.unlinkSync(item.p); removed += 1; } catch {}
  }
  return removed;
}

/** 临时目录（导出给测试与 CLI 用）。 */
export function ttsTmpDir() {
  const dir = path.join(os.tmpdir(), 'qq-tts');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
