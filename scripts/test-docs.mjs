// qq-docs（群文件 / 文档抽取）的回归测试。
//
// 默认完全离线：只测类型判定、文件名消毒、编码兜底、截断，以及 txt/md/json/png/zip 这些
// 不依赖外部工具的路径。docx / xlsx / pdf 需要真实夹具与 LibreOffice Kit、pdftotext，
// 夹具不在了就跳过（⏭），不会把测试搞红。
//
// 跑法：node scripts/test-docs.mjs
// 夹具目录默认 <repo>/../_tmp/docs，可用 QQDOCS_FIXTURES 覆盖。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  docKindOf, sanitizeFileName, formatBytes, decodeText, truncateText, extractDocument
} from '../src/qq-docs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TMP = path.join(os.tmpdir(), `qq-docs-test-${process.pid}`);
const FIXTURES = process.env.QQDOCS_FIXTURES || path.join(REPO, '..', '_tmp', 'docs');
fs.mkdirSync(TMP, { recursive: true });

let pass = 0;
let skipped = 0;
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
function skip(name, why) {
  skipped += 1;
  console.log(`  ⏭ ${name}（${why}）`);
}
const section = (s) => console.log(`\n${s}`);

// 读取 config.json 里的真实工具路径（没有就留空，走「跳过」分支）
function readLimits() {
  let files = {};
  try {
    files = JSON.parse(fs.readFileSync(path.join(REPO, 'config.json'), 'utf8')).files ?? {};
  } catch {
    files = {};
  }
  return {
    officeCli: files.officeCli || '',
    pdftotext: files.pdftotext || '',
    timeoutMs: files.timeoutMs || 120000,
    maxTextChars: files.maxTextChars || 20000,
    maxImages: files.maxImages || 4
  };
}

const write = (name, dataOrString, encoding) => {
  const p = path.join(TMP, name);
  if (encoding) fs.writeFileSync(p, dataOrString, encoding);
  else fs.writeFileSync(p, dataOrString);
  return p;
};

// ── 1. 类型判定 ─────────────────────────────────────────────────────────────
section('类型判定 docKindOf');
await t('文本类：txt / md / json / csv / log / yml', () => {
  for (const name of ['a.txt', 'b.md', 'c.json', 'd.csv', 'e.log', 'f.yml', 'g.yaml', 'h.ini', 'i.xml']) {
    assert.equal(docKindOf(name), 'text', name);
  }
});
await t('Office 类：docx / doc / odt / rtf → docx', () => {
  for (const name of ['a.docx', 'b.doc', 'c.odt', 'd.rtf']) assert.equal(docKindOf(name), 'docx', name);
});
await t('表格类：xlsx / xls / ods / csv 中的表格扩展名 → sheet', () => {
  for (const name of ['a.xlsx', 'b.xls', 'c.ods']) assert.equal(docKindOf(name), 'sheet', name);
});
await t('幻灯片类：pptx / ppt / odp → slide', () => {
  for (const name of ['a.pptx', 'b.ppt', 'c.odp']) assert.equal(docKindOf(name), 'slide', name);
});
await t('PDF / 图片 / 压缩包 / 二进制', () => {
  assert.equal(docKindOf('a.pdf'), 'pdf');
  for (const name of ['a.png', 'b.jpg', 'c.jpeg', 'd.webp', 'e.gif', 'f.bmp']) assert.equal(docKindOf(name), 'image', name);
  for (const name of ['a.zip', 'b.rar', 'c.7z', 'd.tar', 'e.gz']) assert.equal(docKindOf(name), 'archive', name);
  for (const name of ['a.exe', 'b.dll', 'c.bin', 'd.mp4', 'e.mp3']) assert.equal(docKindOf(name), 'binary', name);
});
await t('大小写与无扩展名', () => {
  assert.equal(docKindOf('A.DOCX'), 'docx');
  assert.equal(docKindOf('README'), 'binary');
  assert.equal(docKindOf(''), 'binary');
});

// ── 2. 文件名消毒 ───────────────────────────────────────────────────────────
section('文件名消毒 sanitizeFileName');
await t('去掉路径分隔符与非法字符', () => {
  const clean = sanitizeFileName('../../etc/passwd');
  assert.ok(!clean.includes('/') && !clean.includes('..'), clean);
  const clean2 = sanitizeFileName('a\\b:c*d?e"f<g>h|i.txt');
  assert.ok(!/[\\/:*?"<>|]/.test(clean2), clean2);
});
await t('保留中文与常见字符', () => {
  assert.equal(sanitizeFileName('群文件-第三天(1).docx'), '群文件-第三天(1).docx');
});
await t('空名 / 纯非法字符走兜底', () => {
  assert.equal(sanitizeFileName('', 'file'), 'file');
  assert.ok(sanitizeFileName('///', 'file').length > 0);
});

// ── 3. 编码与截断 ───────────────────────────────────────────────────────────
section('编码兜底与截断');
await t('UTF-8 正常解码', () => {
  assert.equal(decodeText(Buffer.from('中文 utf8', 'utf8')), '中文 utf8');
});
await t('GB18030 兜底解码', () => {
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // 「中文」的 GBK 编码
  assert.equal(decodeText(gbk).trim(), '中文');
});
await t('二进制噪声不会抛错', () => {
  assert.equal(typeof decodeText(Buffer.from([0x00, 0xff, 0x10, 0x80])), 'string');
});
await t('truncateText 截断并标记', () => {
  const r = truncateText('x'.repeat(100), 10);
  assert.equal(r.text.length, 10);
  assert.equal(r.truncated, true);
  const r2 = truncateText('short', 10);
  assert.equal(r2.text, 'short');
  assert.equal(r2.truncated, false);
});

// ── 4. formatBytes ──────────────────────────────────────────────────────────
section('尺寸格式化 formatBytes');
await t('常见量级', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.match(formatBytes(2048), /^2(\.0)?\s?KB$/i);
  assert.match(formatBytes(5 * 1024 * 1024), /^5(\.0)?\s?MB$/i);
});

// ── 5. 纯本地抽取路径 ───────────────────────────────────────────────────────
section('本地抽取（不依赖外部工具）');
const limits = readLimits();

await t('txt 抽取', async () => {
  const p = write('a.txt', '第一行\n第二行\n', 'utf8');
  const r = await extractDocument({ filePath: p, fileName: 'a.txt', limits });
  assert.equal(r.kind, 'text');
  assert.match(r.text, /第一行/);
  assert.equal(r.truncated, false);
});
await t('md / json 都按文本抽取', async () => {
  const md = write('b.md', '# 标题\n\n- 条目\n', 'utf8');
  const j = write('c.json', '{"a":1}', 'utf8');
  assert.match((await extractDocument({ filePath: md, fileName: 'b.md', limits })).text, /标题/);
  assert.match((await extractDocument({ filePath: j, fileName: 'c.json', limits })).text, /"a": 1|"a":1/);
});
await t('GBK 文本文件按文本抽取且不乱码', async () => {
  const p = path.join(TMP, 'gbk.txt');
  fs.writeFileSync(p, Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]));
  const r = await extractDocument({ filePath: p, fileName: 'gbk.txt', limits });
  assert.match(r.text.trim(), /中文/);
});
await t('超过 maxTextChars 会截断并标记', async () => {
  const p = write('big.txt', 'A'.repeat(500), 'utf8');
  const r = await extractDocument({ filePath: p, fileName: 'big.txt', limits: { ...limits, maxTextChars: 50 } });
  assert.equal(r.text.length, 50);
  assert.equal(r.truncated, true);
});
await t('图片给 model media（base64）', async () => {
  // 1x1 透明 PNG
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex'
  );
  const p = write('p.png', png);
  const r = await extractDocument({ filePath: p, fileName: 'p.png', limits });
  assert.equal(r.kind, 'image');
  assert.equal(r.images.length, 1);
  assert.equal(r.images[0].mimeType, 'image/png');
  assert.ok(r.images[0].data.length > 0);
});
await t('压缩包不解压，只回提示', async () => {
  const p = write('a.zip', Buffer.from('PK\u0003\u0004fake', 'binary'));
  const r = await extractDocument({ filePath: p, fileName: 'a.zip', limits });
  assert.equal(r.kind, 'archive');
  assert.equal(r.images, undefined);
  assert.match(r.note ?? '', /不自动解压/);
});
await t('二进制只给元信息', async () => {
  const p = write('a.exe', Buffer.from([0x4d, 0x5a, 0x00, 0x01]));
  const r = await extractDocument({ filePath: p, fileName: 'a.exe', limits });
  assert.equal(r.kind, 'binary');
  assert.match(r.note ?? '', /不支持/);
});

// ── 6. Office / PDF（需要夹具 + 外部工具，缺失则跳过） ──────────────────────
section('Office / PDF 抽取（需要夹具与外部工具）');
const has = (name) => fs.existsSync(path.join(FIXTURES, name));

if (!fs.existsSync(FIXTURES)) {
  skip('docx / xlsx / pdf 抽取', `夹具目录不存在：${FIXTURES}`);
} else {
  if (!limits.officeCli || !fs.existsSync(limits.officeCli)) {
    skip('docx 抽取', '未配置可用的 files.officeCli');
  } else if (!has('sample.docx')) {
    skip('docx 抽取', '缺夹具 sample.docx');
  } else {
    await t('docx 抽取出可读文本（含表格文字）', async () => {
      const r = await extractDocument({ filePath: path.join(FIXTURES, 'sample.docx'), fileName: 'sample.docx', limits });
      assert.equal(r.kind, 'docx');
      assert.match(r.text, /群文件解析测试/);
      assert.match(r.text, /Chtholly/);
    });
  }

  if (!limits.officeCli || !fs.existsSync(limits.officeCli)) {
    skip('xlsx 抽取', '未配置可用的 files.officeCli');
  } else if (!has('sample.xlsx')) {
    skip('xlsx 抽取', '缺夹具 sample.xlsx');
  } else {
    await t('xlsx 抽取成 CSV 文本', async () => {
      const r = await extractDocument({ filePath: path.join(FIXTURES, 'sample.xlsx'), fileName: 'sample.xlsx', limits });
      assert.equal(r.kind, 'sheet');
      assert.match(r.text, /苹果/);
      assert.match(r.note ?? '', /CSV/);
    });
  }

  const pdfPath = has('sample.pdf') ? path.join(FIXTURES, 'sample.pdf') : '';
  if (!pdfPath) skip('pdf 抽取', '缺夹具 sample.pdf');
  else {
    await t('pdf 抽取：有文本层给文本，没有就给页面图片', async () => {
      const r = await extractDocument({ filePath: pdfPath, fileName: 'sample.pdf', limits });
      assert.equal(r.kind, 'pdf');
      const hasText = String(r.text ?? '').replace(/\s+/g, '').length >= 20;
      assert.ok(hasText || (r.images && r.images.length > 0), `既没文本也没图片：${JSON.stringify({ note: r.note })}`);
    });
  }
}

// ── 7. 缺工具时的报错 ──────────────────────────────────────────────────────
section('缺工具时的报错');
await t('没有 officeCli 时 docx 抽取明确报错', async () => {
  if (!has('sample.docx')) {
    skip('docx 缺工具报错', '缺夹具 sample.docx');
    return;
  }
  await assert.rejects(
    extractDocument({ filePath: path.join(FIXTURES, 'sample.docx'), fileName: 'sample.docx', limits: { ...limits, officeCli: '' } }),
    /officeCli|dsoffice/
  );
});

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n通过 ${pass} 项${skipped ? `，跳过 ${skipped} 项` : ''}${failures.length ? `，失败 ${failures.length} 项` : ''}`);
if (failures.length) {
  for (const f of failures) console.error(`\n❌ ${f.name}\n${f.error?.stack ?? f.error}`);
  process.exit(1);
}
console.log('🎉 文档抽取测试全部通过');
