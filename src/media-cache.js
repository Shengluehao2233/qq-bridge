// 内容寻址的媒体结果缓存（视频理解结果：关键帧联系表 + 音轨转写）。
//
// 为什么单独一个模块：
//   · 视频分析是这套系统里最贵的一步——下载 → 抽帧 → Whisper 转写，一个 30 秒视频
//     要十几秒到一分钟。群里同一个视频被两个人转发、或者用户隔天又发一次「看看这个」，
//     没有缓存就得从头再算一遍，白烧 CPU 和时间。
//   · 缓存键必须是**内容**而不是链接：QQ 的媒体链接几分钟就过期，同一段视频每次拿到的
//     URL 都不一样；只有 sha256(字节) 才稳定。链接型（yt-dlp）没法预先下载，只能退回
//     按 URL + 设置指纹缓存。
//   · 落盘要考虑「进程随时被杀」：meta.json 原子替换（.tmp + rename，rename 失败时退回
//     copyFile），图片文件先写临时名再改名，坏掉的条目在读取时直接判 miss 并删掉。
//
// 目录形态：
//   <dir>/<kind>/<前两位>/<键>/meta.json     元数据（含 hits/lastUsedAt/estimateBytes）
//   <dir>/<kind>/<前两位>/<键>/sheet_01.jpg  缓存下来的联系表原图
//
// 注意：这里**不做任何解码/校验**，只负责存取；内容是否可信由调用方（bridge）决定。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CACHE_DEFAULTS = {
  enabled: true,
  dir: 'state/media-cache',
  maxBytes: 512 * 1024 * 1024, // 512 MiB，超过就按 LRU 淘汰
  maxEntries: 400,
  maxAgeDays: 30,
  // 链接型视频（yt-dlp）无法在下载前算内容哈希，按 URL 缓存时加一个更短的有效期：
  // 同一个链接的视频内容也可能被作者换掉，太旧的结果不可信。
  urlMaxAgeDays: 7
};

/** 键 = sha256(parts.join('\u0000'))，稳定、与顺序无关（调用方自己保证语义顺序）。 */
export function cacheKey(...parts) {
  const h = crypto.createHash('sha256');
  // 分隔符必须**逐段**写：只在整个结尾补一个 \0 的话，('ab','c') 与 ('a','bc') 会撞键。
  for (const p of parts) {
    h.update(String(p ?? ''));
    h.update('\u0000');
  }
  return h.digest('hex');
}

/** 设置指纹：影响结果形态的参数变了，缓存必须失效（否则会拿到旧帧数/旧模型的结果）。 */
export function settingsFingerprint(obj) {
  const norm = Object.keys(obj ?? {}).sort().map((k) => `${k}=${String(obj[k])}`).join('&');
  return cacheKey('settings', norm).slice(0, 16);
}

function safeName(name, fallback) {
  const s = path.basename(String(name ?? '')).replace(/[^\w.@-]/g, '_').slice(0, 80);
  return s && s !== '.' && s !== '..' ? s : fallback;
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch {
    // OneDrive/杀软占用时 rename 会 EPERM；退回覆盖写（内容完整性由调用方的 JSON.parse 兜底）。
    fs.copyFileSync(tmp, file);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

export function createMediaCache(options = {}) {
  const opts = { ...CACHE_DEFAULTS, ...(options ?? {}) };
  const root = path.resolve(opts.dir);
  const enabled = opts.enabled !== false;

  function entryDir(kind, key) {
    return path.join(root, safeName(kind, 'misc'), key.slice(0, 2), key);
  }

  function readMeta(dir) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  function ageDays(meta) {
    const t = Date.parse(meta?.createdAt ?? '');
    return Number.isFinite(t) ? (Date.now() - t) / 86_400_000 : Infinity;
  }

  function tooOld(meta) {
    const limit = meta?.url ? (opts.urlMaxAgeDays ?? CACHE_DEFAULTS.urlMaxAgeDays) : opts.maxAgeDays;
    return ageDays(meta) > limit;
  }

  function removeEntry(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  /**
   * 读缓存。
   * @returns {{meta:object, files:Record<string,Buffer>}|null}
   *          命中时会顺手刷新 hits/lastUsedAt（失败不影响命中本身）。
   */
  function get(kind, key) {
    if (!enabled || !key) return null;
    const dir = entryDir(kind, key);
    const meta = readMeta(dir);
    if (!meta) {
      // 目录在、meta 读不出来（半截写、被别的进程写坏）→ 直接清掉，别让它一直占着位置。
      if (fs.existsSync(dir)) removeEntry(dir);
      return null;
    }
    if (tooOld(meta)) { removeEntry(dir); return null; }
    const files = {};
    for (const name of Array.isArray(meta.files) ? meta.files : []) {
      try {
        files[safeName(name, 'file')] = fs.readFileSync(path.join(dir, safeName(name, 'file')));
      } catch {
        // 图片丢了但元数据还在 → 当作 miss，让调用方重算一遍（比交半份结果更好）。
        removeEntry(dir);
        return null;
      }
    }
    meta.hits = (Number(meta.hits) || 0) + 1;
    meta.lastUsedAt = new Date().toISOString();
    try { writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta)); } catch {}
    return { meta, files };
  }

  /**
   * 写缓存。files 是 {文件名: Buffer}；写入前会先清理旧目录，避免同名残留。
   * 失败只返回 false，绝不抛错（缓存坏掉不该让主流程失败）。
   */
  function put(kind, key, meta, files = {}) {
    if (!enabled || !key) return false;
    const dir = entryDir(kind, key);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const names = [];
      for (const [rawName, buf] of Object.entries(files ?? {})) {
        if (!buf || !buf.length) continue;
        const name = safeName(rawName, 'file');
        writeAtomic(path.join(dir, name), buf);
        names.push(name);
      }
      const now = new Date().toISOString();
      const record = {
        ...(meta ?? {}),
        key,
        files: names,
        estimateBytes: names.reduce((sum, n) => sum + (files[n]?.length ?? 0), 0),
        createdAt: now,
        lastUsedAt: now,
        hits: 0
      };
      writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(record));
      return true;
    } catch {
      removeEntry(dir);
      return false;
    }
  }

  /** 列出所有条目（只读 meta，用于统计与淘汰；坏条目顺手清掉）。 */
  function entries() {
    const out = [];
    let kinds = [];
    try { kinds = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
    for (const kind of kinds) {
      let buckets = [];
      try { buckets = fs.readdirSync(path.join(root, kind), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
      for (const bucket of buckets) {
        let keys = [];
        try { keys = fs.readdirSync(path.join(root, kind, bucket), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
        for (const key of keys) {
          const dir = path.join(root, kind, bucket, key);
          const meta = readMeta(dir);
          if (!meta) { removeEntry(dir); continue; }
          out.push({ dir, kind, key, meta });
        }
      }
    }
    return out;
  }

  /**
   * 淘汰：先删过期的，再按 lastUsedAt 从旧到新删到体积/条数达标。
   * @returns {{removed:number, bytes:number, entries:number}}
   */
  function prune() {
    if (!enabled) return { removed: 0, bytes: 0, entries: 0 };
    const all = entries();
    let removed = 0;
    for (const item of all) {
      if (tooOld(item.meta)) { removeEntry(item.dir); removed += 1; }
    }
    const alive = entries().sort((a, b) => String(a.meta.lastUsedAt ?? '').localeCompare(String(b.meta.lastUsedAt ?? '')));
    let size = alive.reduce((sum, it) => sum + (Number(it.meta.estimateBytes) || 0), 0);
    let count = alive.length;
    for (const item of alive) {
      if (count <= opts.maxEntries && size <= opts.maxBytes) break;
      removeEntry(item.dir);
      size -= Number(item.meta.estimateBytes) || 0;
      count -= 1;
      removed += 1;
    }
    return { removed, bytes: Math.max(0, size), entries: Math.max(0, count) };
  }

  function stats() {
    const all = entries();
    return {
      enabled,
      dir: root,
      entries: all.length,
      bytes: all.reduce((sum, it) => sum + (Number(it.meta.estimateBytes) || 0), 0),
      hits: all.reduce((sum, it) => sum + (Number(it.meta.hits) || 0), 0),
      byKind: all.reduce((acc, it) => {
        acc[it.kind] = (acc[it.kind] ?? 0) + 1;
        return acc;
      }, {})
    };
  }

  /** 清空全部（给控制台/排错用）。 */
  function clear() {
    let removed = 0;
    for (const item of entries()) { removeEntry(item.dir); removed += 1; }
    return removed;
  }

  return { enabled, root, get, put, prune, stats, clear, entries, cacheKey, settingsFingerprint };
}
