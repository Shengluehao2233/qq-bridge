// 视频理解模块的回归测试。
//
// 默认**离线**：只测 uv/watch.py 定位、ffprobe 探测、错误分支，不联网、不跑 Whisper。
// 加 --live 才会真的跑一遍 watch.py（首次会下载 yt-dlp/Pillow/faster-whisper，几百 MB）。
// 跑法：
//   node scripts/test-video.mjs                       # 离线
//   node scripts/test-video.mjs --live <视频路径>      # 真跑（不给路径就用 _tmp/vw/test.mp4）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIDEO_DEFAULTS, digestVideo, probeVideo, resolveUv, resolveWatchScript } from '../src/video-digest.js';

const LIVE = process.argv.includes('--live');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 样例视频可能放在仓库里（qq-bridge/_tmp）也可能放在上一层（DshBot/_tmp），两处都找。
const SAMPLE = [path.join(ROOT, '_tmp', 'vw', 'test.mp4'), path.resolve(ROOT, '..', '_tmp', 'vw', 'test.mp4')]
  .find((p) => fs.existsSync(p)) ?? path.join(ROOT, '_tmp', 'vw', 'test.mp4');
const TMP = path.join(os.tmpdir(), `qq-video-test-${process.pid}`);
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

// ── 1. 运行时定位 ───────────────────────────────────────────────────────────
section('运行时定位');

await t('默认值形状稳定', () => {
  assert.equal(VIDEO_DEFAULTS.enabled, true);
  assert.equal(VIDEO_DEFAULTS.maxSeconds, 180);
  assert.equal(VIDEO_DEFAULTS.model, 'base');
  assert.ok(VIDEO_DEFAULTS.maxBytes >= 1024 * 1024);
});

await t('能定位 uv（找不到就报 null 而不是抛错）', () => {
  const uv = resolveUv();
  assert.ok(uv === null || fs.existsSync(uv), `uv 路径不可用：${uv}`);
  console.log(`     uv = ${uv ?? '（没找到）'}`);
});

await t('配置里指定的 uvPath 优先', () => {
  const uv = resolveUv(process.execPath); // 拿一个一定存在的文件当“假的 uv”
  assert.equal(uv, process.execPath);
});

await t('能定位 watch.py（找不到就报 null 而不是抛错）', () => {
  const script = resolveWatchScript();
  assert.ok(script === null || fs.existsSync(script), `watch.py 路径不可用：${script}`);
  console.log(`     watch.py = ${script ?? '（没找到）'}`);
});

// ── 2. ffprobe 探测 ─────────────────────────────────────────────────────────
section('ffprobe 探测');

const hasSample = fs.existsSync(SAMPLE);
await t('探测本地样例视频的时长/分辨率/音轨', async () => {
  if (!hasSample) throw new Error(`样例不存在，跳过：${SAMPLE}`);
  const probe = await probeVideo(SAMPLE);
  assert.ok(probe, 'ffprobe 没返回结果（检查 ffmpeg/ffprobe 是否在 PATH 或 tools/ffmpeg）');
  assert.ok(probe.durationSec > 5 && probe.durationSec < 7, `时长异常：${probe.durationSec}`);
  assert.equal(probe.width, 640);
  assert.equal(probe.height, 360);
  assert.equal(probe.hasAudio, true);
});

await t('探测不存在的文件返回 null', async () => {
  const probe = await probeVideo(path.join(TMP, 'nope.mp4'));
  assert.equal(probe, null);
});

// ── 3. 失败分支（不联网、不抽帧） ───────────────────────────────────────────
section('失败分支');

await t('watch.py 不存在时 ok=false 且说明原因', async () => {
  const result = await digestVideo({
    filePath: path.join(TMP, 'x.mp4'),
    outDir: path.join(TMP, 'out1'),
    cfg: { scriptPath: path.join(TMP, 'missing-watch.py'), uvPath: process.execPath }
  });
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /watch\.py/);
  assert.deepEqual(result.sheets, []);
});

await t('uv 不存在时 ok=false 且说明原因', async () => {
  const result = await digestVideo({
    filePath: path.join(TMP, 'x.mp4'),
    outDir: path.join(TMP, 'out2'),
    cfg: { uvPath: path.join(TMP, 'missing-uv.exe') }
  });
  assert.equal(result.ok, false);
  assert.equal(result.sheets.length, 0);
});

// ── 4. 真跑（--live） ───────────────────────────────────────────────────────
if (LIVE) {
  section('真跑 watch.py（--live）');
  const target = process.argv.find((a, i) => i > 2 && !a.startsWith('--')) || SAMPLE;
  await t(`digestVideo(${path.basename(String(target))}) 产出联系表+转写`, async () => {
    if (!fs.existsSync(target)) throw new Error(`视频不存在：${target}`);
    const outDir = path.join(TMP, 'live');
    const result = await digestVideo({ filePath: target, outDir, cfg: { maxFrames: 6, timeoutMs: 600000 } });
    if (!result.ok) throw new Error(`处理失败：${result.reason}`);
    assert.ok(result.sheets.length >= 1, '没产出联系表');
    assert.ok(result.sheets[0].buffer.length > 1000, '联系表太小，可能没截到内容');
    console.log(`     联系表 ${result.sheets.length} 张（${result.sheets.map((s) => `${s.name} ${(s.buffer.length / 1024).toFixed(0)}KB`).join(', ')}）`);
    console.log(`     转写 ${String(result.transcript ?? '').length} 字，用时 ${Math.round((result.elapsedMs ?? 0) / 1000)}s`);
  });
}

// ── 收尾 ───────────────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${failures.length ? '❌' : '🎉'} ${pass} 项通过${failures.length ? `，${failures.length} 项失败` : ''}`);
if (failures.length) {
  for (const f of failures) console.log(`   - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exitCode = 1;
}
