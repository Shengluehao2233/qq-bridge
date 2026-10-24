// TTS 命令行：把一段文字合成语音，可选直接发到某个群/私聊。
//
// 用法见 usage()。核心只有两步：
//   1) src/tts/index.js 的 synthesize() —— 按 config.tts.provider 选引擎合成并落盘到 audio/tts/
//   2) --send 时交给 scripts/send-voice.mjs 去发（白名单 / 限流 / 落地校验全部复用那一套，
//      不在这里另写一份发送逻辑，避免两处规则漂移）
//
// 环境变量：TTS_PYTHON（python 解释器）、FFPROBE_PATH、各家云 Key（OPENAI_API_KEY 等）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  synthesize, listProviders, listVoices, normalizeConfig, pruneOutputs,
  LOCALE_VOICES, normalizeLocale, resolveVoice, TtsError
} from '../src/tts/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

// ── 参数解析（与 scripts/send-voice.mjs 同一套写法）──────────────────────────
const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
  if (a.startsWith('--')) {
    const [k, inline] = a.slice(2).split('=');
    if (inline !== undefined) flags.set(k, inline);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { flags.set(k, argv[i + 1]); i += 1; }
    else flags.set(k, true);
  } else if (a.startsWith('-') && a.length === 2) {
    flags.set(a.slice(1), true);
  } else {
    positional.push(a);
  }
}
const has = (k) => flags.has(k);
const val = (k, d = undefined) => (flags.has(k) ? (flags.get(k) === true ? '' : String(flags.get(k))) : d);
const num = (k, d) => {
  if (!flags.has(k)) return d;
  const n = Number(flags.get(k));
  return Number.isFinite(n) ? n : d;
};

const quiet = has('q') || has('quiet');
const asJson = has('json');
const out = (...a) => { if (!quiet && !asJson) console.log(...a); };
const fail = (msg, code = 1) => {
  if (asJson) console.log(JSON.stringify({ ok: false, error: String(msg) }));
  else console.error(`❌ ${msg}`);
  process.exit(code);
};

/**
 * 语种参数：--lang 或 --locale，接受 zh-CN / en / 日语 这类写法。
 * 认不出来的写法直接报错（而不是悄悄当默认语种），否则用户会以为改成功了。
 */
function langArg() {
  const raw = val('locale', val('lang', null));
  if (raw === null || raw === undefined || raw === '') return null;
  const loc = normalizeLocale(raw);
  if (!loc) fail(`认不出语种「${raw}」；可用：${Object.keys(LOCALE_VOICES.edge).join(' / ')}（或 zh / en / ja 这类简写）`);
  return loc;
}

function loadConfig() {
  const p = path.resolve(val('config', CONFIG_PATH));
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`读取配置失败（${p}）：${error?.message ?? error}`);
  }
}

const cfg = loadConfig();
const ttsRaw = cfg.tts && typeof cfg.tts === 'object' ? cfg.tts : {};
const ttsCfg = normalizeConfig(ttsRaw);
const provider = val('provider', ttsCfg.provider);

/**
 * 命令行里能临时覆盖的 provider 配置项。
 * 只把「真的给了值」的键塞进去，没给的保持 config.json 里的值。
 */
function settingsOverride() {
  const o = {};
  const keys = [
    ['rate', 'rate'], ['pitch', 'pitch'], ['volume', 'volume'],
    ['style', 'style'], ['speed', 'speed'], ['instructions', 'instructions'],
    ['model', 'model'], ['base-url', 'baseUrl'], ['region', 'region'],
    ['format', 'format'], ['output-format', 'outputFormat'],
    ['python', 'python'], ['key', 'apiKey']
  ];
  for (const [flag, field] of keys) {
    if (!has(flag)) continue;
    o[field] = flag === 'speed' ? num('speed', 1) : val(flag);
  }
  return o;
}

const maskText = (t, n = 60) => {
  const s = String(t).replace(/\n/g, '⏎');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

// ── 子命令 ──────────────────────────────────────────────────────────────────
function cmdProviders() {
  const rows = listProviders(ttsRaw);
  if (asJson) { console.log(JSON.stringify({ ok: true, providers: rows }, null, 2)); return; }
  out('可用的 TTS 提供方：');
  for (const r of rows) {
    const mark = r.active ? '▶' : ' ';
    const state = r.configured ? '✅ 已就绪' : `⛔ ${r.reason}`;
    out(`  ${mark} ${r.id.padEnd(13)} ${r.label}`);
    out(`     ${state}${r.voice ? ` · 当前音色 ${r.voice}` : ''}`);
  }
  out(`\n当前使用：${ttsCfg.provider}（改 config.json 的 tts.provider，或加 --provider）`);
}

async function cmdVoices() {
  try {
    const loc = langArg();
    const res = await listVoices({
      config: ttsRaw,
      provider,
      locale: loc,
      limit: num('limit', undefined),
      timeoutMs: num('timeout', undefined)
    });
    if (asJson) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.ok) fail(res.error);
    const voices = Array.isArray(res.voices) ? res.voices : [];
    const scope = loc ? `语种 ${loc}` : '全部语种';
    const paging = res.total > voices.length ? `，只显示前 ${voices.length} 个` : '';
    out(`${res.providerLabel ?? provider} 的音色（${scope}，共 ${res.total} 个${paging}）：`);
    if (res.recommended) out(`  推荐：女声 ${res.recommended.female} / 男声 ${res.recommended.male}`);
    for (const v of voices) {
      const cur = v.id === res.current ? ' ← 当前' : '';
      const meta = [v.gender, v.categories, v.tags].filter(Boolean).join(' · ');
      out(`  ${v.id.padEnd(34)} ${meta}${cur}`);
    }
    if (!loc) out(`\n可用语种：${Object.keys(LOCALE_VOICES[res.provider] ?? {}).join(' ') || '（该引擎不按语种分类）'}`);
  } catch (error) {
    fail(error?.message ?? error);
  }
}

/** 列语种：给的是「推荐音色」表，不联网。 */
function cmdLangs() {
  const rows = LOCALE_VOICES[provider];
  if (asJson) { console.log(JSON.stringify({ ok: true, provider, locales: rows ?? {} }, null, 2)); return; }
  if (!rows) {
    out(`「${provider}」不按语种分类（它是多语种引擎，直接用 --voice 选音色）。`);
    return;
  }
  const resolved = resolveVoice({ config: ttsRaw, provider, locale: langArg() });
  out(`${provider} 支持的语种（推荐音色）：`);
  for (const [id, v] of Object.entries(rows)) {
    const cur = id === resolved.locale ? ' ← 当前' : '';
    out(`  ${id.padEnd(7)} ${String(v.label).padEnd(14)} 女声 ${v.female.padEnd(26)} 男声 ${v.male}${cur}`);
  }
  out(`\n当前语种：${resolved.locale || '未设置'}；不指定音色时用该语种的推荐音色（默认女声，加 --gender male 换男声）。`);
}

function textFromArgs() {
  if (has('file')) {
    const f = path.resolve(String(val('file')));
    try { return fs.readFileSync(f, 'utf8'); } catch (error) { fail(`读不到文本文件 ${f}：${error?.message ?? error}`); }
  }
  const fromArgs = positional.join(' ').trim();
  if (fromArgs) return fromArgs;
  if (process.stdin.isTTY) return '';
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

async function cmdSynth() {
  const text = textFromArgs();
  if (!text.trim()) {
    usage(2);
  }

  const outDir = val('out-dir', undefined);
  const filename = val('out', undefined) ? String(val('out')) : null;
  const loc = langArg();
  let result;
  try {
    result = await synthesize(text, {
      config: ttsRaw,
      provider,
      voice: val('voice', null),
      locale: loc,
      gender: val('gender', null),
      outDir: outDir ? path.resolve(String(outDir)) : null,
      filename,
      maxChars: num('max-chars', undefined),
      timeoutMs: num('timeout', undefined),
      settingsOverride: settingsOverride()
    });
  } catch (error) {
    if (error instanceof TtsError || error?.code === 'provider_unconfigured') fail(error.message);
    fail(`合成失败：${error?.message ?? error}`);
  }

  // 顺带清理旧产物，避免 audio/tts 无限长（默认留最近 50 条）。
  const keep = num('keep', 50);
  if (Number.isFinite(keep) && keep >= 0) {
    try { pruneOutputs(path.dirname(result.path), { keep }); } catch {}
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    out('─'.repeat(60));
    out(`文本  : ${maskText(result.text)}（${result.chars} 字）`);
    out(`引擎  : ${result.providerLabel}${result.voice ? ` · 音色 ${result.voice}` : ''}${result.locale ? ` · 语种 ${result.locale}` : ''}`);
    out(`音频  : ${result.path}`);
    out(`        ${result.duration ? `${result.duration.toFixed(1)}s · ` : ''}${(result.bytes / 1024).toFixed(1)} KB · 合成 ${result.ms} ms`);
    if (result.warning) out(`ℹ️  ${result.warning}`);
    for (const w of result.warnings ?? []) out(`⚠️  ${w}`);
    out('─'.repeat(60));
  }

  const target = val('send', val('to', null));
  if (target) await sendViaSendVoice(result.path, String(target), val('label', ''));
  return result;
}

/** 交给 send-voice.mjs 发：白名单/限流/落地校验只维护一份。 */
async function sendViaSendVoice(file, target, label) {
  const script = path.join(ROOT, 'scripts', 'send-voice.mjs');
  const args = [script, 'send', file, target];
  if (label) args.push('--label', label);
  if (has('dry-run')) args.push('--dry-run');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`send-voice.mjs 退出码 ${code}`))));
  }).catch((error) => fail(`发送失败：${error?.message ?? error}`, 3));
}

function usage(code = 0) {
  const t = [
    'TTS 命令行（默认引擎：edge-tts，可通过 config.tts.provider 换服务商）',
    '',
    '  合成：',
    '    node scripts/tts.mjs "今晚月亮挺圆的"',
    '    node scripts/tts.mjs --file 台词.txt --voice zh-CN-YunxiNeural',
    '    echo "你好呀" | node scripts/tts.mjs --voice zh-CN-XiaoyiNeural --json',
    '    node scripts/tts.mjs "晚安" --send group:542654144        # 合成后直接发',
    '',
    '  查看：',
    '    node scripts/tts.mjs --list-providers',
    '    node scripts/tts.mjs --list-langs                        # 语种与推荐音色',
    '    node scripts/tts.mjs --list-voices [--provider edge]     # 全部音色',
    '    node scripts/tts.mjs --list-voices --lang ja --limit 20  # 只看日语',
    '',
    '  语种与音色：',
    '    --lang <语种>      zh-CN / zh-TW / zh-HK / en-US / en-GB / ja-JP / ko-KR / fr-FR …',
    '                       （也认 zh、en、ja、日语、粤语、英语 这类简写）',
    '                       只给语种时，自动用该语种的推荐音色（默认女声）',
    '    --gender male|female   语种推荐音色里挑男声还是女声（默认 female）',
    '    --voice <name>     指定音色 id（优先级最高，如 zh-CN-XiaoyiNeural）',
    '',
    '  常用参数：',
    '    --provider <id>   edge / openai / azure / siliconflow（默认取 config.tts.provider）',
    '    --rate/--pitch/--volume   语速/音调/音量（edge 形如 +10% / +0Hz；azure 同）',
    '    --out <文件>      指定输出文件名（默认 tts-时间戳.mp3，落在 audio/tts/）',
    '    --out-dir <目录>  指定输出目录',
    '    --max-chars <n>   覆盖单条文本上限（默认 config.tts.maxChars=200）',
    '    --send <目标>     合成后直接发送：group:群号 / private:QQ号 / 群号',
    '    --label <说明>    发送时写进会话记录的说明',
    '    --json            只输出 JSON（方便其它脚本消费）',
    '    --keep <n>        发送后保留最近 n 条产物（默认 50，0 = 全删）',
    '',
    '  云服务 Key 可写在 config.json 的 tts.providers.<id>.apiKey，或用环境变量：',
    '    OPENAI_API_KEY / AZURE_SPEECH_KEY / SILICONFLOW_API_KEY'
  ].join('\n');
  (code === 0 ? console.log : console.error)(t);
  process.exit(code);
}

// ── 入口 ────────────────────────────────────────────────────────────────────
if (has('help') || has('h')) usage(0);
if (has('list-providers')) cmdProviders();
else if (has('list-voices')) await cmdVoices();
else if (has('list-langs') || has('list-locales')) cmdLangs();
else if (has('prune')) {
  const dir = path.resolve(val('out-dir', ttsCfg.outputDir));
  const n = pruneOutputs(dir, { keep: num('keep', 0) });
  out(`已清理 ${n} 个文件（${dir}）`);
} else await cmdSynth();
