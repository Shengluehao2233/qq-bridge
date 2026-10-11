// 从 QQ 聊天记录导出（chunked jsonl）自动生成角色卡草稿。
//
// 用法：
//   node build-role-card.mjs --uins 3149641864,3581863221 --name Self
//   node build-role-card.mjs --uins 123456 --corpus "D:\exports" --out "..\roles\某人.md"
//
// 产出：一份 Markdown 角色卡，统计部分全部由真实语料算出，
//       示例全部为真实发言；人格/梗/边界那几节留成骨架供人工填写。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  return def;
}

const uins = String(arg('uins', '')).split(',').map((s) => s.trim()).filter(Boolean);
const corpus = arg('corpus', 'C:\\Users\\sbsb1\\OneDrive\\Desktop\\测试\\聊天记录');
let name = arg('name', '');
const outArg = arg('out', '');
const dropBotLines = arg('drop-bot-lines', 'true') !== 'false';
const sampleCount = Number(arg('samples', 90)) || 90;

if (!uins.length) {
  console.error('缺少 --uins（逗号分隔的 QQ 号，同一人的多个号都写上）');
  console.error('例：node build-role-card.mjs --uins 3149641864,3581863221 --name Self');
  process.exit(2);
}
if (!fs.existsSync(corpus)) {
  console.error(`语料目录不存在：${corpus}`);
  process.exit(2);
}

// 机器人自己留下的痕迹，不该被当成"本人风格"模仿
const BOT_LINE = /attachment-error|会话令牌|x-agent-token|mcp__snowluma|mcp__web-search|agent 处理出错|⚠️|image unavailable|does not support image input|ds h|请求失败/;

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const files = walk(corpus);
if (!files.length) { console.error('语料目录里没有 .jsonl 文件'); process.exit(2); }

const target = new Set(uins);
const msgs = [];           // 目标号的有效发言
const names = new Map();   // uin -> 昵称计数
const uinCounts = new Map();
const groupCount = new Map();
let total = 0;
let skippedBot = 0;

for (const f of files) {
  const srcDir = path.basename(path.dirname(path.dirname(f)));
  const rl = readline.createInterface({ input: fs.createReadStream(f, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    total++;
    // 先用便宜的字符串判断挡掉绝大多数行，再 JSON.parse
    let m; try { m = JSON.parse(line); } catch { continue; }
    const uin = String(m?.sender?.uin ?? '');
    if (!uin) continue;
    uinCounts.set(uin, (uinCounts.get(uin) || 0) + 1);
    if (!target.has(uin)) continue;
    if (m.system || m.recalled) continue;
    const nm = String(m?.sender?.name ?? '');
    if (nm) names.set(`${uin}|${nm}`, (names.get(`${uin}|${nm}`) || 0) + 1);
    const raw = String(m.content?.text ?? '');
    // 归一化导出器标记，别把文件哈希写进角色卡
    const text = raw
      .replace(/\[回复消息\]/g, '')
      .replace(/\[(图片|表情|视频|语音|文件|动画表情|JSON消息|转发消息)[^\]]*\]/g, (s0) => (s0.includes('转发') ? '[转发消息]' : `[${/图片|表情|视频|语音|文件|动画表情|JSON消息/.exec(s0)[0]}]`))
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    if (dropBotLines && BOT_LINE.test(text)) { skippedBot++; continue; }
    msgs.push({ uin, name: nm, text, ts: Number(m.timestamp) || 0, src: srcDir });
    groupCount.set(srcDir, (groupCount.get(srcDir) || 0) + 1);
  }
}
if (!msgs.length) { console.error(`语料里没有找到这些号的发言：${uins.join(', ')}`); process.exit(1); }

msgs.sort((a, b) => a.ts - b.ts);
const n = msgs.length;
const lens = msgs.map((m) => m.text.length).sort((a, b) => a - b);
const q = (p) => lens[Math.min(lens.length - 1, Math.floor(lens.length * p))] ?? 0;
const pct = (c) => ((c / n) * 100).toFixed(1);
const count = (fn) => msgs.filter(fn).length;

const stats = {
  n,
  median: q(0.5), p25: q(0.25), p75: q(0.75), p90: q(0.9),
  avg: (lens.reduce((a, b) => a + b, 0) / n).toFixed(1),
  max: lens[lens.length - 1],
  le4: count((m) => m.text.length <= 4),
  le8: count((m) => m.text.length <= 8),
  oneChar: count((m) => m.text.length === 1),
  punctEnd: count((m) => /[。！？!?…~～]$/.test(m.text)),
  fullStop: count((m) => m.text.includes('。')),
  emoji: count((m) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(m.text)),
  at: count((m) => /@/.test(m.text)),
  atSpace: count((m) => /@[^\s@]+\s/.test(m.text)),
  atAll: count((m) => /@全体成员/.test(m.text)),
  pure: count((m) => /^[?？!！。.…~～、,，\s]+$/.test(m.text)),
  question: count((m) => /[?？]$/.test(m.text)),
  latin: count((m) => /[A-Za-z]{2,}/.test(m.text)),
  digit: count((m) => /\d/.test(m.text)),
  paren: count((m) => /[（(][^）)]{0,20}[）)]/.test(m.text)),
  over100: count((m) => m.text.length >= 100),
  over300: count((m) => m.text.length >= 300),
  days: new Set(msgs.map((m) => new Date(m.ts).toISOString().slice(0, 10))).size
};

// 连发（90 秒内同一人连续消息算一组）
let bursts = 0;
for (let i = 0; i < n; i++) if (i === 0 || msgs[i].ts - msgs[i - 1].ts > 90_000) bursts++;

// 小时分布
const hours = new Array(24).fill(0);
for (const m of msgs) hours[new Date(m.ts).getHours()]++;
const hourTop = hours.map((c, h) => ({ h, c })).sort((a, b) => b.c - a.c).slice(0, 6);

// 高频词：短消息的 2~6 字子串
const phrase = new Map();
for (const m of msgs) {
  const t = m.text.replace(/\s+/g, '');
  if (!t || t.length > 24) continue;
  for (let L = 2; L <= 6; L++) {
    for (let i = 0; i + L <= t.length; i++) {
      const g = t.slice(i, i + L);
      if (/^[\d\s]+$/.test(g) || g.startsWith('@') || g.includes('[图片') || g.includes('[表情')) continue;
      phrase.set(g, (phrase.get(g) || 0) + 1);
    }
  }
}
const topPhrases = [...phrase.entries()]
  .filter(([g, c]) => c >= Math.max(4, n * 0.002) && g.length >= 2)
  .sort((a, b) => b[1] - a[1]);

// @ 对象
const atMap = new Map();
for (const m of msgs) {
  for (const g of m.text.matchAll(/@([^\s@，。！？,]{1,16})/g)) atMap.set(g[1], (atMap.get(g[1]) || 0) + 1);
}
const topAt = [...atMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

// 示例挑法：短回应 / 问句 / @人 / 日常中句 / 长文整活
const pick = (arr, k) => {
  const step = Math.max(1, Math.floor(arr.length / k));
  const out = [];
  for (let i = 0; i < arr.length && out.length < k; i += step) out.push(arr[i]);
  return out;
};
const noAt = msgs.filter((m) => !/@/.test(m.text) && !m.text.startsWith('['));
const examples = {
  short: pick(msgs.filter((m) => m.text.length <= 6 && !/@/.test(m.text)), Math.ceil(sampleCount / 5)),
  typical: pick(noAt.filter((m) => m.text.length > 6 && m.text.length <= 25), Math.ceil(sampleCount / 4)),
  questions: pick(msgs.filter((m) => /[?？]$/.test(m.text)), 8),
  ats: pick(msgs.filter((m) => /^@/.test(m.text)), 10),
  long: msgs.filter((m) => m.text.length >= 120).slice(-4).map((m) => m.text.slice(0, 200))
};

const nameGuess = name || [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]?.split('|')[1] || uins[0];
const fmtDate = (t) => new Date(t).toISOString().slice(0, 10);
const topUinRows = uins.map((u) => {
  const c = msgs.filter((m) => m.uin === u).length;
  const nicks = [...names.entries()].filter(([k]) => k.startsWith(u + '|')).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, v]) => `${k.split('|')[1]}(${v})`).join('、') || '（语料里没有昵称）';
  return `| ${u} | ${c} | ${nicks} |`;
}).join('\n');

const md = `# 角色卡：${nameGuess} —— QQ 群友版

> 本文件由 \`qq-bridge/scripts/build-role-card.mjs\` 从真实聊天记录自动生成草稿。
> **统计与示例都是真实数据**；带 \`TODO\` 的条目需要人工补写（身份、梗、边界这些机器猜不出来）。

## 〇、数据来源
- 语料目录：\`${corpus}\`
- 扫描文件：${files.length} 个 jsonl，共 ${total.toLocaleString('en-US')} 条消息
- 目标号：${uins.join('、')}，有效发言 **${n.toLocaleString('en-US')} 条**
- 时间跨度：${fmtDate(msgs[0].ts)} ~ ${fmtDate(msgs[n - 1].ts)}，共 **${stats.days} 个活跃日**
- 剔除的疑似机器人痕迹：${skippedBot} 条

| QQ | 发言数 | 用过的昵称（次数） |
| --- | --- | --- |
${topUinRows}

**群/会话分布**
${[...groupCount.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}：${v} 条`).join('\n')}

## 一、语言形态（实测，可直接照抄进角色卡的"说话铁律"）
| 指标 | 数值 |
| --- | --- |
| 长度 中位/平均/最长 | ${stats.median} 字 / ${stats.avg} 字 / ${stats.max} 字 |
| 长度分位 p25 / p75 / p90 | ${stats.p25} / ${stats.p75} / ${stats.p90} 字 |
| ≤8 字 / ≤4 字 / 单字 | ${pct(stats.le8)}% / ${pct(stats.le4)}% / ${pct(stats.oneChar)}% |
| 以标点结尾 | ${pct(stats.punctEnd)}% |
| 出现过句号"。" | ${pct(stats.fullStop)}% |
| 含 emoji | ${pct(stats.emoji)}% |
| 含 @ | ${pct(stats.at)}%（其中 @某某 + 空格 + 内容 占 ${stats.at ? ((stats.atSpace / stats.at) * 100).toFixed(0) : 0}%） |
| @全体成员 | ${stats.atAll} 次 |
| 纯符号消息（？/。。。等） | ${pct(stats.pure)}% |
| 以问号结尾 | ${pct(stats.question)}% |
| 含拉丁字母 / 数字 | ${pct(stats.latin)}% / ${pct(stats.digit)}% |
| 含括号补充 | ${pct(stats.paren)}% |
| ≥100 字 / ≥300 字 | ${pct(stats.over100)}% / ${pct(stats.over300)}% |
| 连发 | ${bursts} 组，平均每组 **${(n / bursts).toFixed(2)} 条** |

**活跃时段（次数降序）**：${hourTop.map((x) => `${String(x.h).padStart(2, '0')}点 ${x.c}`).join('、')}

## 二、高频词与口头禅
高频短语（短消息 2~6 字子串，已剔除 @ 与图片标记）：

${topPhrases.slice(0, 80).map(([g, c]) => `${g}×${c}`).join('  ')}

> 用法建议：把其中"结构性"的词（例如口头禅、语气词、固定搭配）挑进角色卡的"常用词"一节；
> 纯名词（群友外号、专有名词）不要当成语言风格。

## 三、常 @ 的人（关系网）
${topAt.map(([k, v]) => `- ${k} ×${v}`).join('\n') || '- （几乎没有 @ 行为）'}

## 四、真实语料样本（全部原样摘录）
**短回应 / 口头反应**
${examples.short.map((m) => `- ${m.text}`).join('\n')}

**日常中句（7~25 字）**
${examples.typical.map((m) => `- ${m.text}`).join('\n')}

**问句**
${examples.questions.map((m) => `- ${m.text}`).join('\n')}

**点名/喊人的写法**
${examples.ats.map((m) => `- ${m.text}`).join('\n')}

**长文整活（≥120 字，截断展示）**
${examples.long.map((m) => `- ${m}`).join('\n\n') || '- （没有长文；此人几乎不发长段）'}

## 五、角色卡骨架（人工补写区）
下面几节建议按下表补完；统计结论已经在上面，直接引用即可。

### 一、你是谁
- TODO 真实身份/职业/年龄段（语料里能推断的线索：…）
- TODO 与本群的关系：潜水党 / 活跃分子 / 半个管理 / 技术担当？
- TODO 网名沿革（见〇节的昵称表）
- 最高原则：**先像群里那个真人，再谈别的**。

### 二、群聊说话铁律
- 按上面的语言形态写死数值：中位 ${stats.median} 字、≤8 字占 ${pct(stats.le8)}%、以标点结尾仅 ${pct(stats.punctEnd)}%、平均每组连发 ${(n / bursts).toFixed(2)} 条。
- TODO 有没有专属的口头禅/语气词（从第二节里挑）。

### 三、说话方式
- TODO 讽刺/吐槽/夸人的具体说法；中英数混排习惯（本语料含拉丁 ${pct(stats.latin)}%）。
- TODO 对群友的称呼方式（从第三节的 @ 名单里找）。

### 四、节奏与消息习惯
- 活跃时段：${hourTop.map((x) => `${x.h}点`).join('、')}；TODO 是否夜猫子、白天是否安静。
- TODO 冷场时会不会主动抛话题、被 @ 时的反应。

### 五、人格与梗
- TODO 群里反复出现的梗、绰号、内部笑话。
- TODO 情绪表达方式（语料里几乎不用 emoji 的话就别加）。

### 六、AI 味黑名单
- 通用：不要"首先/其次/综上"、"作为AI"、"希望这个回答对你有帮助"、Markdown 列表、长篇解释。
- 本语料特有：以标点结尾只有 ${pct(stats.punctEnd)}%，**句末加句号立刻出戏**。

### 七、回复示例
- 从上文第四节挑真实样本改写成"你不要 / 你可以"对照。

### 八~十一、群文化自适应 / 表情包 / 记忆 / 边界
- 可直接复用本仓库 \`roles/大肥鱼.md\` 对应章节的写法（工具协议部分通用）。
- TODO 边界与雷点：身份暴露、隐私、专业建议（医疗/法律）、越界请求。

---

生成命令：
\`\`\`
node qq-bridge/scripts/build-role-card.mjs --uins ${uins.join(',')} --name ${nameGuess}
\`\`\`
`;

const out = outArg || path.join(REPO, 'roles', `${nameGuess}.md`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, md, 'utf8');
console.log(`✅ 已生成角色卡草稿：${out}`);
console.log(`   目标号 ${uins.join(',')}，有效发言 ${n} 条，时间跨度 ${fmtDate(msgs[0].ts)} ~ ${fmtDate(msgs[n - 1].ts)}`);
console.log(`   剔除疑似机器人痕迹 ${skippedBot} 条；统计：中位 ${stats.median} 字 / ≤8字 ${pct(stats.le8)}% / @率 ${pct(stats.at)}%`);
console.log(`   填完 TODO 后，在群里发「进入角色扮演：${nameGuess}」即可生效`);
