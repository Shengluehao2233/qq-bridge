#!/usr/bin/env node
// 媒体结果缓存（src/media-cache.js）单元测试。
// 缓存出错的代价很隐蔽：命中率高但内容是旧的、条目永远不淘汰把磁盘撑爆、进程被杀留下半份
// 文件——所以这里把「键稳定性 / 命中计数 / 过期 / 淘汰 / 坏条目自清 / 关闭开关」都钉住。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMediaCache, cacheKey, settingsFingerprint, CACHE_DEFAULTS } from '../src/media-cache.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`✅ ${name}`); } else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-cache-test-'));
const dir = path.join(tmpRoot, 'cache');
const jpg = Buffer.from('fake-jpeg-bytes-for-test');

function makeCache(over = {}) {
  // dir 必须放在最后：CACHE_DEFAULTS 里也有 dir，展开顺序错了会悄悄写进真实缓存目录。
  return createMediaCache({ ...CACHE_DEFAULTS, ...over, dir });
}

// ── 1. 键与指纹 ──────────────────────────────────────────────────────────────
check('cacheKey 稳定', cacheKey('a', 'b') === cacheKey('a', 'b'));
check('cacheKey 与分段边界相关', cacheKey('ab', 'c') !== cacheKey('a', 'bc'));
check('cacheKey 长度 64', cacheKey('x').length === 64);
check('settingsFingerprint 随值变化', settingsFingerprint({ frames: 18 }) !== settingsFingerprint({ frames: 12 }));
check('settingsFingerprint 与键序无关', settingsFingerprint({ a: 1, b: 2 }) === settingsFingerprint({ b: 2, a: 1 }));

// ── 2. 基本读写 ──────────────────────────────────────────────────────────────
{
  const cache = makeCache();
  check('未命中的键返回 null', cache.get('video', cacheKey('nope')) === null);
  const key = cacheKey('video', 'fp', 'hash1');
  const ok = cache.put('video', key, { probe: { durationSec: 6 }, transcript: '你好', sheets: ['sheet_01.jpg'] }, { 'sheet_01.jpg': jpg });
  check('put 成功', ok === true);
  const hit = cache.get('video', key);
  check('get 命中', !!hit && hit.meta.transcript === '你好');
  check('get 带回图片字节', hit?.files?.['sheet_01.jpg']?.equals(jpg) === true);
  check('命中后 hits=1', hit?.meta?.hits === 1);
  const again = cache.get('video', key);
  check('再次命中 hits=2', again?.meta?.hits === 2);
  check('meta.json 落在磁盘上', fs.existsSync(path.join(dir, 'video', key.slice(0, 2), key, 'meta.json')));
  check('stats 统计到条目', cache.stats().entries === 1);
  check('stats 统计到命中数', cache.stats().hits === 2);
  check('stats 统计到体积', cache.stats().bytes === jpg.length);
  check('stats 按 kind 分组', cache.stats().byKind.video === 1);
}

// ── 3. 图片文件丢失 → 判 miss 并清掉条目（不能交半份结果）────────────────────
{
  const cache = makeCache();
  const key = cacheKey('video', 'missing-file');
  cache.put('video', key, { sheets: ['sheet_01.jpg'] }, { 'sheet_01.jpg': jpg });
  fs.unlinkSync(path.join(dir, 'video', key.slice(0, 2), key, 'sheet_01.jpg'));
  check('文件丢失时返回 null', cache.get('video', key) === null);
  check('文件丢失的条目已被删除', !fs.existsSync(path.join(dir, 'video', key.slice(0, 2), key)));
}

// ── 4. meta 损坏 → miss 并清理 ──────────────────────────────────────────────
{
  const cache = makeCache();
  const key = cacheKey('video', 'broken-meta');
  cache.put('video', key, { sheets: [] }, {});
  fs.writeFileSync(path.join(dir, 'video', key.slice(0, 2), key, 'meta.json'), '{not json');
  check('meta 损坏时返回 null', cache.get('video', key) === null);
  check('meta 损坏的条目已被清理', !fs.existsSync(path.join(dir, 'video', key.slice(0, 2), key)));
}

// ── 5. 过期策略：普通条目按 maxAgeDays，链接条目按 urlMaxAgeDays ─────────────
{
  const cache = makeCache({ maxAgeDays: 30, urlMaxAgeDays: 7 });
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString(); // 10 天前

  const kUrl = cacheKey('video-url', 'url');
  cache.put('video-url', kUrl, { url: true, sheets: [] }, {});
  const metaPath = path.join(dir, 'video-url', kUrl.slice(0, 2), kUrl, 'meta.json');
  const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  m.createdAt = old;
  fs.writeFileSync(metaPath, JSON.stringify(m));
  check('链接条目超过 urlMaxAgeDays 判定过期', cache.get('video-url', kUrl) === null);

  const kFile = cacheKey('video', 'file');
  cache.put('video', kFile, { sheets: [] }, {});
  const metaPath2 = path.join(dir, 'video', kFile.slice(0, 2), kFile, 'meta.json');
  const m2 = JSON.parse(fs.readFileSync(metaPath2, 'utf8'));
  m2.createdAt = old;
  fs.writeFileSync(metaPath2, JSON.stringify(m2));
  check('内容条目 10 天未过期', cache.get('video', kFile) !== null);
}

// ── 6. 淘汰：maxEntries ────────────────────────────────────────────────────
{
  const cache = makeCache({ maxEntries: 2, maxBytes: 10 * 1024 * 1024, maxAgeDays: 365 });
  const keys = ['a', 'b', 'c'].map((n) => cacheKey('video', n));
  // 用 lastUsedAt 造出「a 最旧、c 最新」
  for (let i = 0; i < keys.length; i += 1) {
    cache.put('video', keys[i], { sheets: [] }, {});
    const p = path.join(dir, 'video', keys[i].slice(0, 2), keys[i], 'meta.json');
    const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
    meta.lastUsedAt = new Date(Date.now() + i * 1000).toISOString();
    fs.writeFileSync(p, JSON.stringify(meta));
  }
  const res = cache.prune();
  check('淘汰后条数不超过 maxEntries', cache.stats().entries <= 2, `实际 ${cache.stats().entries}`);
  check('淘汰了至少 1 项', res.removed >= 1);
  const kept = cache.entries().map((e) => e.key);
  check('保留的是最近使用的 c', kept.includes(keys[2]));
}

// ── 7. 淘汰：maxBytes ──────────────────────────────────────────────────────
{
  const cache = makeCache({ maxEntries: 100, maxBytes: 1024, maxAgeDays: 365 });
  const big = Buffer.alloc(800, 1);
  for (const n of ['x', 'y', 'z']) {
    const key = cacheKey('video', n);
    cache.put('video', key, { sheets: ['sheet_01.jpg'] }, { 'sheet_01.jpg': big });
  }
  cache.prune();
  check('按体积淘汰到上限内', cache.stats().bytes <= 1024, `实际 ${cache.stats().bytes}`);
}

// ── 8. 关闭开关：读写都不落地 ───────────────────────────────────────────────
{
  const cache = makeCache({ enabled: false });
  const key = cacheKey('video', 'off');
  check('关闭时 put 返回 false', cache.put('video', key, { sheets: [] }, {}) === false);
  check('关闭时 get 返回 null', cache.get('video', key) === null);
  check('关闭时 prune 无操作', cache.prune().removed === 0);
}

// ── 9. clear ───────────────────────────────────────────────────────────────
{
  const cache = makeCache();
  check('clear 前有条目', cache.stats().entries > 0);
  cache.clear();
  check('clear 后清空', cache.stats().entries === 0);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '🎉' : '❌'} 媒体缓存测试：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
