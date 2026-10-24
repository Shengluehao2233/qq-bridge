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
  synthesize, listProviders, listVoices, normalizeConfig, pruneOutputs, TtsError
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
    const res = await listVoices({ config: ttsRaw, provider, timeoutMs: num('timeout', undefined) });
    if (asJson) { console.log(JSON.stringify(res, null, 2)); return; }
    if (!res.ok) fail(res.error);
    const voices = Array.isArray(res.voices) ? res.voices : [];
    out(`${res.providerLabel ?? provider} 的可用音色（${voices.length} 个）：`);
    for (const v of voices) {
      const cur = v.id === res.current ? ' ← 当前' : '';
      const meta = [v.gender, v.categories, v.tags].filter(Boolean).join(' · ');
      out(`  ${v.id.padEnd(34)} ${meta}${cur}`);
    }
  } catch (error) {
    fail(error?.message ?? error);
  }
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
  let result;
  try {
    result = await synthesize(text, {
      config: ttsRaw,
      provider,
      voice: val('voice', null),
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
    out(`引擎  : ${result.providerLabel}${result.voice ? ` · 音色 ${result.voice}` : ''}`);
    out(`音频  : ${result.path}`);
    out(`        ${result.duration ? `${result.duration.toFixed(1)}s · ` : ''}${(result.bytes / 1024).toFixed(1)} KB · 合成 ${result.ms} ms`);
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
    '    node scripts/tts.mjs --list-voices [--provider edge]',
    '',
    '  常用参数：',
    '    --provider <id>   edge / openai / azure / siliconflow（默认取 config.tts.provider）',
    '    --voice <name>    音色；edge 用 zh-CN-XiaoyiNeural 这类，云服务用各自的音色名',
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
else if (has('prune')) {
  const dir = path.resolve(val('out-dir', ttsCfg.outputDir));
  const n = pruneOutputs(dir, { keep: num('keep', 0) });
  out(`已清理 ${n} 个文件（${dir}）`);
} else await cmdSynth();
