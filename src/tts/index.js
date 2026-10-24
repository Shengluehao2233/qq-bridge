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
  // 默认语种（只决定「没给音色时挑哪个音色」）；空 = 用 provider 自己的默认音色。
  locale: '',
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

// ── 语种 ────────────────────────────────────────────────────────────────────
//
// 「语种」在 TTS 里其实是两件事：① 语音用哪个语言的音色；② 文本本身是什么语言。
// ② 由文本自己决定（模型/人写什么就是什么），这里只负责 ①：给一个语种，挑一个该语言的
// 推荐音色。有些引擎的音色天生多语种（OpenAI、CosyVoice2），语种对它们没有意义，
// 所以 LOCALE_VOICES 里没有它的条目 —— 这时 resolveVoice() 会明确说「该引擎不按语种选音色」，
// 而不是悄悄忽略参数。
export const LOCALE_VOICES = {
  edge: {
    'zh-CN': { label: '简体中文', female: 'zh-CN-XiaoyiNeural', male: 'zh-CN-YunxiNeural' },
    'zh-TW': { label: '繁體中文（台灣）', female: 'zh-TW-HsiaoChenNeural', male: 'zh-TW-YunJheNeural' },
    'zh-HK': { label: '粵語（香港）', female: 'zh-HK-HiuMaanNeural', male: 'zh-HK-WanLungNeural' },
    'en-US': { label: 'English (US)', female: 'en-US-AriaNeural', male: 'en-US-GuyNeural' },
    'en-GB': { label: 'English (UK)', female: 'en-GB-SoniaNeural', male: 'en-GB-RyanNeural' },
    'ja-JP': { label: '日本語', female: 'ja-JP-NanamiNeural', male: 'ja-JP-KeitaNeural' },
    'ko-KR': { label: '한국어', female: 'ko-KR-SunHiNeural', male: 'ko-KR-InJoonNeural' },
    'fr-FR': { label: 'Français', female: 'fr-FR-DeniseNeural', male: 'fr-FR-HenriNeural' },
    'de-DE': { label: 'Deutsch', female: 'de-DE-KatjaNeural', male: 'de-DE-ConradNeural' },
    'es-ES': { label: 'Español', female: 'es-ES-ElviraNeural', male: 'es-ES-AlvaroNeural' },
    'ru-RU': { label: 'Русский', female: 'ru-RU-SvetlanaNeural', male: 'ru-RU-DmitryNeural' },
    'it-IT': { label: 'Italiano', female: 'it-IT-ElsaNeural', male: 'it-IT-DiegoNeural' },
    'pt-BR': { label: 'Português (BR)', female: 'pt-BR-FranciscaNeural', male: 'pt-BR-AntonioNeural' }
  },
  azure: {
    'zh-CN': { label: '简体中文', female: 'zh-CN-XiaoxiaoNeural', male: 'zh-CN-YunxiNeural' },
    'zh-TW': { label: '繁體中文（台灣）', female: 'zh-TW-HsiaoChenNeural', male: 'zh-TW-YunJheNeural' },
    'zh-HK': { label: '粵語（香港）', female: 'zh-HK-HiuMaanNeural', male: 'zh-HK-WanLungNeural' },
    'en-US': { label: 'English (US)', female: 'en-US-AriaNeural', male: 'en-US-GuyNeural' },
    'en-GB': { label: 'English (UK)', female: 'en-GB-SoniaNeural', male: 'en-GB-RyanNeural' },
    'ja-JP': { label: '日本語', female: 'ja-JP-NanamiNeural', male: 'ja-JP-KeitaNeural' },
    'ko-KR': { label: '한국어', female: 'ko-KR-SunHiNeural', male: 'ko-KR-InJoonNeural' },
    'fr-FR': { label: 'Français', female: 'fr-FR-DeniseNeural', male: 'fr-FR-HenriNeural' },
    'de-DE': { label: 'Deutsch', female: 'de-DE-KatjaNeural', male: 'de-DE-ConradNeural' },
    'es-ES': { label: 'Español', female: 'es-ES-ElviraNeural', male: 'es-ES-AlvaroNeural' }
  }
};

/** 口语化写法 → BCP-47。允许「中文 / 日语 / en / zh-tw」这类随手写法。 */
const LOCALE_ALIASES = {
  zh: 'zh-CN', 'zh-cn': 'zh-CN', cn: 'zh-CN', chinese: 'zh-CN', 中文: 'zh-CN', 普通话: 'zh-CN', 简体: 'zh-CN',
  'zh-tw': 'zh-TW', tw: 'zh-TW', 繁体: 'zh-TW', 台湾: 'zh-TW',
  'zh-hk': 'zh-HK', hk: 'zh-HK', 粤语: 'zh-HK', 粵語: 'zh-HK', yue: 'zh-HK',
  en: 'en-US', english: 'en-US', 英语: 'en-US', 英文: 'en-US',
  'en-us': 'en-US', 'en-gb': 'en-GB', uk: 'en-GB',
  ja: 'ja-JP', jp: 'ja-JP', japanese: 'ja-JP', 日语: 'ja-JP', 日文: 'ja-JP', 日本語: 'ja-JP',
  ko: 'ko-KR', korean: 'ko-KR', 韩语: 'ko-KR', 한국어: 'ko-KR',
  fr: 'fr-FR', french: 'fr-FR', 法语: 'fr-FR',
  de: 'de-DE', german: 'de-DE', 德语: 'de-DE',
  es: 'es-ES', spanish: 'es-ES', 西班牙语: 'es-ES',
  ru: 'ru-RU', russian: 'ru-RU', 俄语: 'ru-RU',
  it: 'it-IT', italian: 'it-IT', 意大利语: 'it-IT',
  pt: 'pt-BR', portuguese: 'pt-BR', 葡语: 'pt-BR', 葡萄牙语: 'pt-BR'
};

/** 规范化语种写法；认不出来就返回 null（调用方决定是报错还是忽略）。 */
export function normalizeLocale(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/_/g, '-');
  if (LOCALE_ALIASES[key]) return LOCALE_ALIASES[key];
  // 形如 zh-CN / en-US：大小写归一后再查一次
  const m = /^([a-z]{2,3})-([a-z]{2})$/.exec(key);
  if (m) {
    const canon = `${m[1]}-${m[2].toUpperCase()}`;
    return LOCALE_ALIASES[canon.toLowerCase()] ?? canon;
  }
  return null;
}

/** 从音色 id 里取语种：zh-CN-XiaoyiNeural → zh-CN。 */
export function localeFromVoiceId(id) {
  const m = /^([a-z]{2,3}-[A-Za-z]{2})/.exec(String(id ?? ''));
  return m ? normalizeLocale(m[1]) : null;
}

/** 某个 provider 是否有这个语种的推荐音色。 */
export function localeVoices(providerId, locale = null) {
  const table = LOCALE_VOICES[providerId] ?? {};
  const loc = normalizeLocale(locale);
  if (!loc) return table;
  return table[loc] ? { [loc]: table[loc] } : {};
}

/**
 * 挑音色：显式 voice > 语种推荐音色（gender 优先）> 配置里的 voice > provider 默认。
 * 返回 { voice, locale, source, note }。note 用来告诉用户「这个引擎不吃语种参数」。
 */
export function resolveVoice({ config = null, provider = null, voice = null, locale = null, gender = null } = {}) {
  const { mod, settings, cfg } = resolveProvider(config, provider);
  // 注意用 || 而不是 ??：调用方经常传空字符串（`locale ?? cfg.locale` 在 cfg.locale 为空时就是 ''），
  // 而空字符串必须当成「没指定」，否则会盖掉 settings.locale（= config.tts.providers.<id>.locale，
  // 管理员 /语音 语种 改的就是这里），表现为「语种改了但声音没变」。2026-10-24 真踩过。
  const loc = normalizeLocale(locale) || normalizeLocale(settings.locale) || normalizeLocale(cfg.locale);
  const table = LOCALE_VOICES[mod.meta.id] ?? {};
  const picked = loc && table[loc] ? table[loc] : null;
  const wantGender = String(gender || '').toLowerCase();
  let voiceId = '';
  let source = '';
  if (String(voice ?? '').trim()) {
    const rawVoice = String(voice).trim();
    // 允许只写语种里的简称：female / male
    if (picked && /^(female|male|女|男)$/i.test(rawVoice)) {
      const g = /^(male|男)$/i.test(rawVoice) ? 'male' : 'female';
      voiceId = picked[g];
      source = 'locale';
    } else {
      voiceId = rawVoice;
      source = 'explicit';
    }
  } else if (picked) {
    const g = wantGender === 'male' || wantGender === '男' ? 'male' : 'female';
    voiceId = picked[g];
    source = 'locale';
  } else if (String(settings.voice ?? '').trim()) {
    voiceId = String(settings.voice).trim();
    source = 'config';
  } else {
    voiceId = String(mod.meta.defaults?.voice ?? '');
    source = 'provider-default';
  }
  const note = loc && !picked
    ? `「${mod.meta.label}」不按语种选音色（它本身是多语种引擎），语种参数只用于提示`
    : '';
  return { voice: voiceId, locale: loc || localeFromVoiceId(voiceId), source, note, provider: mod.meta.id, providerLabel: mod.meta.label, settings, cfg };
}

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
    // 默认语种：只影响「没指定音色时挑哪个音色」。空 = 用 provider 自己的默认音色。
    locale: normalizeLocale(src.locale) || '',
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
  // 语种：'zh-CN' / 'en' / '日语' 都行。只决定「没显式给音色时挑哪个音色」。
  locale = null,
  gender = null,
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
  // 音色的解析优先级统一在 resolveVoice 里（显式 > 语种推荐 > 配置 > provider 默认），
  // 免得 CLI / 桥接 / 将来的 qq_speak 三处各写一份。
  const picked = resolveVoice({ config, provider: mod.meta.id, voice, locale: locale || cfg.locale || null, gender });
  const finalVoice = picked.voice;
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
    locale: picked.locale || '',
    voiceSource: picked.source,
    warning: picked.note || '',
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

/**
 * 列音色（只有实现了 listVoices 的 provider 支持）。
 * locale 可选：给了就只返回该语种的音色（并附上该语种的推荐音色）。
 */
export async function listVoices({ config = null, provider = null, locale = null, timeoutMs = null, limit = null } = {}) {
  const { mod, settings, cfg } = resolveProvider(config, provider);
  if (typeof mod.listVoices !== 'function') {
    return { ok: false, provider: mod.meta.id, error: `「${mod.meta.label}」不支持列出音色` };
  }
  const st = typeof mod.status === 'function' ? mod.status(settings) : { configured: true };
  if (!st.configured) {
    return { ok: false, provider: mod.meta.id, error: `「${mod.meta.label}」还没配好：${st.reason}` };
  }
  const res = await mod.listVoices({ settings, timeoutMs: timeoutMs ?? cfg.timeoutMs });
  const all = (Array.isArray(res.voices) ? res.voices : []).map((v) => ({
    ...v,
    locale: normalizeLocale(v.locale) || localeFromVoiceId(v.id) || ''
  }));
  const loc = normalizeLocale(locale) || '';
  const table = LOCALE_VOICES[mod.meta.id] ?? {};
  const filtered = loc ? all.filter((v) => v.locale === loc) : all;
  const locales = {};
  for (const v of all) if (v.locale) locales[v.locale] = (locales[v.locale] ?? 0) + 1;
  const current = resolveVoice({ config, provider: mod.meta.id, voice: settings.voice, locale: loc || cfg.locale }).voice;
  return {
    ...res,
    voices: Number(limit) > 0 ? filtered.slice(0, Number(limit)) : filtered,
    total: filtered.length,
    allTotal: all.length,
    locale: loc,
    recommended: loc && table[loc] ? { ...table[loc] } : null,
    locales: Object.entries(locales).sort((a, b) => b[1] - a[1]).map(([id, count]) => ({ id, count })),
    provider: mod.meta.id,
    providerLabel: mod.meta.label,
    current
  };
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
