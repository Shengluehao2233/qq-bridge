// TTS 模块的回归测试。
//
// 默认**完全离线**：只测配置规整、文本校验、provider 登记、落盘与清理，不联网、不调用任何云服务。
// 加 --live 才真的用 edge-tts 合成一句话（约 3 秒 + 需要外网），用来确认「引擎这条路」是通的。
//
// 跑法：node scripts/test-tts.mjs [--live]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeConfig, prepareText, resolveProvider, synthesize, listProviders,
  pruneOutputs, writeFileAtomic, PROVIDERS, DEFAULT_TTS, TtsError
} from '../src/tts/index.js';

const LIVE = process.argv.includes('--live');
const TMP = path.join(os.tmpdir(), `qq-tts-test-${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });

let pass = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ❌ ${name}\n     ${error?.message ?? error}`);
  }
}

const section = (s) => console.log(`\n${s}`);

// ── 1. 配置规整 ─────────────────────────────────────────────────────────────
section('配置规整 normalizeConfig');

await t('空配置取默认值', () => {
  const c = normalizeConfig(undefined);
  assert.equal(c.provider, 'edge');
  assert.equal(c.enabled, false);
  assert.equal(c.maxChars, 200);
  assert.equal(c.outputDir, 'audio/tts');
  assert.deepEqual(Object.keys(c.providers).sort(), ['azure', 'edge', 'openai', 'siliconflow']);
});

await t('未知 provider 回落到默认（不抛错，配置要能启动）', () => {
  assert.equal(normalizeConfig({ provider: 'no-such-vendor' }).provider, 'edge');
});

await t('maxChars / timeoutMs 被夹到安全区间', () => {
  assert.equal(normalizeConfig({ maxChars: 5000 }).maxChars, 1000);
  assert.equal(normalizeConfig({ maxChars: 0 }).maxChars, 1);
  assert.equal(normalizeConfig({ maxChars: -9 }).maxChars, 1);
  assert.equal(normalizeConfig({ maxChars: 'abc' }).maxChars, DEFAULT_TTS.maxChars);
  assert.equal(normalizeConfig({ timeoutMs: 1 }).timeoutMs, 5000);
  assert.equal(normalizeConfig({ timeoutMs: 999999 }).timeoutMs, 180000);
});

await t('provider 默认值 + 用户覆盖（深合并，不丢字段）', () => {
  const c = normalizeConfig({ providers: { edge: { voice: 'zh-CN-YunxiNeural' } } });
  assert.equal(c.providers.edge.voice, 'zh-CN-YunxiNeural');
  assert.equal(c.providers.edge.rate, '+0%', '未覆盖的字段必须保留默认值');
  assert.equal(c.providers.edge.pitch, '+0Hz');
});

await t('enabled 只认真正的 true', () => {
  assert.equal(normalizeConfig({ enabled: 'true' }).enabled, false);
  assert.equal(normalizeConfig({ enabled: true }).enabled, true);
});

// ── 2. 文本校验 ─────────────────────────────────────────────────────────────
section('文本校验 prepareText');

await t('剥控制字符、统一换行、去首尾空白', () => {
  const r = prepareText('  你好\u0007\r\n世界  ');
  assert.equal(r.text, '你好\n世界');
  assert.equal(r.chars, 5);
});

await t('连续空行压到最多一行', () => {
  assert.equal(prepareText('a\n\n\n\n\nb').text, 'a\n\nb');
});

await t('空文本抛 empty_text', () => {
  assert.throws(() => prepareText('   '), (e) => e instanceof TtsError && e.code === 'empty_text');
});

await t('超长抛 text_too_long 且报出实际字数', () => {
  assert.throws(() => prepareText('字'.repeat(201), { maxChars: 200 }), (e) => {
    return e.code === 'text_too_long' && /201 字/.test(e.message);
  });
});

await t('刚好等于上限可以过', () => {
  assert.equal(prepareText('字'.repeat(200), { maxChars: 200 }).chars, 200);
});

await t('按码点计数（emoji 算 1 个字，不算 2 字节）', () => {
  assert.equal(prepareText('🌙🌙🌙').chars, 3);
});

// ── 3. provider 登记与状态 ──────────────────────────────────────────────────
section('provider 契约与状态');

await t('四家 provider 都满足契约（meta.id / meta.label / synthesize）', () => {
  for (const [id, mod] of Object.entries(PROVIDERS)) {
    assert.equal(mod.meta.id, id, `${id} 的 meta.id 必须与登记名一致`);
    assert.ok(mod.meta.label, `${id} 缺少 label`);
    assert.equal(typeof mod.synthesize, 'function', `${id} 缺少 synthesize()`);
    assert.equal(typeof mod.status, 'function', `${id} 缺少 status()`);
    assert.ok(mod.meta.defaults?.voice, `${id} 缺少默认音色`);
  }
});

await t('三家务必要 Key 的 provider 未配置时给出原因', () => {
  const rows = listProviders({});
  for (const id of ['openai', 'azure', 'siliconflow']) {
    const row = rows.find((r) => r.id === id);
    assert.equal(row.configured, false, `${id} 没有 Key 时不应报就绪`);
    assert.match(row.reason, /apiKey|region/, `${id} 的原因要指出缺什么`);
  }
});

await t('edge 的 status 返回结构化结果（本机应已就绪）', () => {
  const row = listProviders({}).find((r) => r.id === 'edge');
  assert.equal(typeof row.configured, 'boolean');
  if (!row.configured) assert.ok(row.reason.length > 0, '未就绪必须说明原因');
});

await t('unknown provider 报错而不是静默降级', () => {
  assert.throws(() => resolveProvider({}, 'gpt-tts-9000'), (e) => e.code === 'unknown_provider');
});

await t('synthesize 在 provider 未配置时抛 provider_unconfigured', async () => {
  await assert.rejects(
    () => synthesize('你好', { config: { provider: 'openai' } }),
    (e) => e.code === 'provider_unconfigured' && /还没配好/.test(e.message)
  );
});

await t('超长文本在调用引擎前就被挡住（不会白花一次合成）', async () => {
  await assert.rejects(
    () => synthesize('字'.repeat(500), { config: { provider: 'edge', maxChars: 100 } }),
    (e) => e.code === 'text_too_long'
  );
});

// ── 4. 落盘与清理 ───────────────────────────────────────────────────────────
section('落盘与清理');

await t('writeFileAtomic 写入成功且不留 .tmp', () => {
  const f = path.join(TMP, 'atomic.bin');
  writeFileAtomic(f, Buffer.from('hello'));
  assert.equal(fs.readFileSync(f, 'utf8'), 'hello');
  assert.deepEqual(fs.readdirSync(TMP).filter((n) => n.includes('.tmp-')), []);
});

await t('writeFileAtomic 覆盖已有文件', () => {
  const f = path.join(TMP, 'atomic.bin');
  writeFileAtomic(f, Buffer.from('second'));
  assert.equal(fs.readFileSync(f, 'utf8'), 'second');
});

await t('pruneOutputs 只删 tts-* 且保留最近 N 个', () => {
  const dir = path.join(TMP, 'prune');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 6; i += 1) {
    const f = path.join(dir, `tts-20260101-00000${i}.mp3`);
    fs.writeFileSync(f, 'x');
    const when = new Date(Date.now() - (6 - i) * 60000);
    fs.utimesSync(f, when, when);
  }
  fs.writeFileSync(path.join(dir, 'keep-me.mp3'), 'x');
  assert.equal(pruneOutputs(dir, { keep: 2 }), 4);
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, ['keep-me.mp3', 'tts-20260101-000004.mp3', 'tts-20260101-000005.mp3']);
});

// ── 5. 云端失败路径不泄漏 Key ───────────────────────────────────────────────
section('错误信息');

await t('云端连接失败时报错，且不回显 apiKey', async () => {
  const key = 'sk-test-secret-do-not-leak-123';
  await assert.rejects(
    () => synthesize('你好', {
      config: { provider: 'openai', providers: { openai: { apiKey: key, baseUrl: 'http://127.0.0.1:9/v1' } } },
      settingsOverride: { timeoutMs: 6000 }
    }),
    (e) => {
      assert.ok(!String(e.message).includes(key), '错误信息里出现了 API Key');
      assert.match(e.message, /连不上|请求失败|超时/);
      return true;
    }
  );
});

// ── 6. 真实合成（--live）─────────────────────────────────────────────────────
if (LIVE) {
  section('真实合成（edge-tts）');
  await t('合成一句中文 → 得到可播放的 mp3', async () => {
    const res = await synthesize('今晚月亮挺圆的，你要不要出来走走。', {
      config: { provider: 'edge', providers: { edge: { voice: 'zh-CN-XiaoyiNeural' } } },
      outDir: path.join(TMP, 'live')
    });
    assert.equal(res.ok, true);
    assert.equal(res.provider, 'edge');
    assert.ok(fs.existsSync(res.path), '文件不存在');
    assert.ok(res.bytes > 2000, `音频太小：${res.bytes} 字节`);
    assert.ok(res.duration != null && res.duration > 0.5, `时长异常：${res.duration}`);
    console.log(`     → ${path.basename(res.path)}  ${res.duration.toFixed(1)}s  ${(res.bytes / 1024).toFixed(1)}KB  ${res.ms}ms`);
    fs.unlinkSync(res.path);
  });

  await t('列出音色时中文排在前面', async () => {
    const { listVoices } = await import('../src/tts/index.js');
    const res = await listVoices({ config: { provider: 'edge' } });
    assert.equal(res.ok, true);
    assert.ok(res.voices.length > 50, `音色数量异常：${res.voices.length}`);
    assert.ok(res.voices[0].id.startsWith('zh-'), `第一个音色不是中文：${res.voices[0].id}`);
  });
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
if (failures.length === 0) {
  console.log(`🎉 TTS 测试全部通过（${pass} 项）${LIVE ? '（含真实合成）' : '（离线；加 --live 跑真实合成）'}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(0);
} else {
  console.log(`❌ ${failures.length} 项失败 / ${pass} 项通过`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
