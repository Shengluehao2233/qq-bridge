# TTS 语音合成（文字 → 语音）

> 一句话：把一段文字念成 mp3，存进语音库，然后用现成的语音发送链路当作 QQ 语音条发出去。
> 默认引擎是 **edge-tts**（微软在线语音，免费、无需 Key）；接口按「可换服务商」设计，
> OpenAI TTS / Azure 语音服务 / 硅基流动 CosyVoice2 已经接好，填个 Key 就能切过去。

---

## 1. 目录与职责

| 文件 | 职责 |
| --- | --- |
| `src/tts/index.js` | 内核：provider 登记、配置规整、文本校验、落盘（原子写 + EPERM 重试）、时长探测、清理旧产物 |
| `src/tts/providers/edge.js` | edge-tts（Python 包）实现 + 音色列表 |
| `src/tts/providers/openai.js` | `/v1/audio/speech`（`gpt-4o-mini-tts`，支持 `instructions` 语气描述） |
| `src/tts/providers/azure.js` | Azure 语音服务（SSML、`mstts:express-as` 风格、输出格式可调） |
| `src/tts/providers/siliconflow.js` | 硅基流动 OpenAI 兼容接口（CosyVoice2，可克隆音色） |
| `src/tts/providers/http-audio.js` | 云 provider 的公共请求/错误解析（不回显 Key） |
| `scripts/tts.mjs` | 命令行：合成、列音色、列服务商、合成后直接发送 |
| `scripts/test-tts.mjs` | 回归测试（默认离线；`--live` 才真合成） |

合成产物默认落在 **`audio/tts/`**，也就是语音库（`audio/`）内部 —— 这样 `qq_send_voice`（AI 通道）
和 `scripts/send-voice.mjs`（操作者通道）都能直接取用，不需要额外开放路径权限。

---

## 2. provider 契约（要加一家新服务，只做这四件事）

```js
export const meta = {
  id: 'myvendor',            // 与登记名一致，写进 config.tts.provider
  label: '某某 TTS',
  needsKey: true,
  docUrl: 'https://…',
  defaults: { voice: 'xxx' } // 该引擎的默认配置，config 里可覆盖
};

export function status(settings) {          // 只报告，不产生副作用
  return settings.apiKey
    ? { configured: true, reason: '' }
    : { configured: false, reason: '没有配置 apiKey' };
}

export async function synthesize({ text, voice, settings, timeoutMs }) {
  // …调用服务，拿回音频字节
  return { buffer, ext: '.mp3', mime: 'audio/mpeg', voice };   // buffer 必须是 Buffer
}

export async function listVoices({ settings }) {   // 可选
  return { ok: true, voices: [{ id, gender, categories, tags }] };
}
```

然后在 `src/tts/index.js` 里 `import * as myvendor from './providers/myvendor.js'` 并加进
`PROVIDERS` 数组即可。**落盘、校验、限长、清理都不用你管** —— provider 只负责「文字 → 字节」。

> 为什么这么切：provider 返回纯字节，落盘就只有一个地方（要改存 OSS / 直接发字节只动这一处）；
> 时长与合法性统一走 `voice-core.js` 的 `inspectAudio()`，保证 TTS 产物和用户自己放进语音库的
> 音频过的是同一道闸（扩展名、体积、时长上限一致）。

---

## 3. 配置（`config.json` 的 `tts` 段）

```jsonc
"tts": {
  "enabled": false,          // AI 自主发声总闸（预留，目前只有 CLI/操作者通道会用到）
  "provider": "edge",        // edge | openai | azure | siliconflow
  "maxChars": 200,           // 单条文本上限（按「字」算，200/1000 之间夹取）
  "outputDir": "audio/tts",  // 相对仓库根目录
  "timeoutMs": 60000,
  "providers": {
    "edge":        { "voice": "zh-CN-XiaoyiNeural", "rate": "+0%", "pitch": "+0Hz", "volume": "+0%", "python": "" },
    "openai":      { "apiKey": "", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini-tts", "voice": "alloy", "format": "mp3", "instructions": "" },
    "azure":       { "apiKey": "", "region": "", "voice": "zh-CN-XiaoxiaoNeural", "outputFormat": "audio-24khz-48kbitrate-mono-mp3", "style": "", "rate": "+0%", "pitch": "+0Hz" },
    "siliconflow": { "apiKey": "", "baseUrl": "https://api.siliconflow.cn/v1", "model": "FunAudioLLM/CosyVoice2-0.5B", "voice": "FunAudioLLM/CosyVoice2-0.5B:alex", "format": "mp3", "speed": 1 }
  }
}
```

要点：

- **Key 也可以放环境变量**（优先级：配置里的 `apiKey` → 环境变量）：
  `OPENAI_API_KEY` / `AZURE_SPEECH_KEY` / `SILICONFLOW_API_KEY`。`config.json` 已在 `.gitignore` 里，
  但环境变量更不容易被误提交或被截图带走。
- `azure.region` 必填（如 `eastasia`），空着会明确报「缺少 region」。
- `edge.python` 空 = 用 PATH 里的 `python`；多解释器机器上写绝对路径。
- 配置是手写的，所以 `maxChars` / `timeoutMs` 都在 `src/tts/index.js` 里夹到安全区间
  （写 0、负数、字符串都不会变成「无上限」）。

---

## 4. 命令行

```bash
# 合成（默认引擎、默认音色），产物落在 audio/tts/
node scripts/tts.mjs "今晚月亮挺圆的，你要不要出来走走？"

# 换音色 / 换引擎
node scripts/tts.mjs "早点睡啊" --voice zh-CN-YunxiNeural
node scripts/tts.mjs "你好" --provider openai --voice alloy --instructions "像在跟朋友随口聊天"

# 从文件读台词 / 从 stdin 读
node scripts/tts.mjs --file 台词.txt
echo "你好呀" | node scripts/tts.mjs --voice zh-CN-XiaoyiNeural --json

# 合成后直接发（走 send-voice.mjs，白名单/限流/落地校验全部复用）
node scripts/tts.mjs "晚安" --send group:542654144
node scripts/tts.mjs "试一下" --send group:542654144 --dry-run   # 只校验不发送

# 查看
node scripts/tts.mjs --list-providers     # 四家服务商 + 配没配好
node scripts/tts.mjs --list-langs         # 语种表 + 每个语种的推荐音色（不联网）
node scripts/tts.mjs --list-voices        # 音色清单（中文排在前面）
node scripts/tts.mjs --list-voices --lang ja --limit 20   # 只看日语的前 20 个
node scripts/tts.mjs --prune --keep 20    # 清理旧产物

# 语种 / 性别（等价于挑该语种的推荐音色）
node scripts/tts.mjs "おはよう" --lang ja                 # → ja-JP-NanamiNeural（女）
node scripts/tts.mjs "Good morning" --lang en --gender male  # → en-US-GuyNeural（男）
node scripts/tts.mjs "你好" --voice zh-CN-XiaoxiaoNeural  # 显式音色，优先级最高
```

**音色解析优先级**：`--voice` 显式指定 > 语种推荐音色（`--gender` 选男女）> `config.tts.providers.<id>.voice` > provider 默认。
语种支持 `zh-CN / zh-TW / zh-HK / en-US / en-GB / ja-JP / ko-KR / fr-FR / de-DE / es-ES / ru-RU / it-IT / pt-BR`
以及口语写法（`zh`、`en`、`ja`、`日语`、`粤语`、`英文`…）。多语种引擎（OpenAI / CosyVoice2）不吃语种参数，
会明确提示「该引擎不按语种选音色」，而不是悄悄忽略。

输出示例：

```
文本  : 今晚月亮挺圆的，你要不要出来走走？（17 字）
引擎  : 微软 Edge TTS（免费 / 无需 Key） · 音色 zh-CN-XiaoyiNeural
音频  : …\qq-bridge\audio\tts\tts-20261024-162809-yd087m.mp3
        3.7s · 21.7 KB · 合成 2135 ms
```

`--json` 会输出结构化结果（`path / bytes / duration / provider / voice / text / chars / ms`），方便其它脚本消费。

### 管理员命令（QQ 群里，只有 ownerQQ 能用）

| 命令 | 作用 |
| --- | --- |
| `/语音` / `/voice` | 看状态：总闸、引擎、音色、语种、限流、语音库文件数 |
| `/语音 开` / `/语音 关` | 开 / 关「发语音功能」总闸 |
| `/语音 <文字>` | 把这段文字合成成语音，发到当前会话 |
| `/语音 音色 <id>` | 换音色；`/语音 音色 默认` 回到 config.json 里的值 |
| `/语音 音色列表 [语种]` | 列音色（联网向服务商查询，默认列前 20 个） |
| `/语音 语种 <语种>` | 换语种；不带参数则列出语种表与该语种的推荐音色 |

闸门顺序与内部实现一致，**先便宜后贵**：

1. 总闸：`socialV2.voice.enabled` 或管理员 `/语音 开`；
2. 文本审计：要念的原文**会出站到 TTS 服务商**，含路径 / 凭据 / 会话令牌直接拒绝；
3. 长度：单条 ≤ `socialV2.voice.speak.maxChars`（默认 **250 字**），超了拒绝而不是截断；
4. 频率：同一会话每 `speak.minIntervalMs`（默认 **60000 ms**）最多 1 条，合成成功即占额度。

管理员改过的开关 / 音色 / 语种写在 `state/voice-state.json`，重启桥接仍然生效；
`config.json` 永远是「出厂值」，改它才是改默认。

---

## 5. 和语音发送链路的关系

```
文字 ──(src/tts)──> audio/tts/xxx.mp3 ──┬─> send-voice.mjs（操作者通道，可发库外文件）
                                        ├─> 桥接 /api/voice/send（控制台面板）
                                        ├─> /语音 <文字>（管理员命令，在 QQ 里直接触发）
                                        └─> qq_send_voice（AI 通道，只允许库内路径）
```

- 因为产物默认就在 `audio/tts/`（语音库内），AI 通道取用时天然满足「只能发语音库里的文件」这条硬规则。
- 发送侧的限制（时长 ≤ 300s、体积 ≤ 20MB、每分钟 2 条 / 每小时 10 条、白名单、落地回读）
  全部由现有链路负责，TTS 不重复实现。
- 语音发送本身没开的话（`socialV2.voice.enabled=false`），**合成仍然可用**，只是不能发 ——
  合成和发送是两件事，把 `audio/tts` 里的文件拷走当素材也是正常用法。

---

## 6. 安全与成本

- **云 TTS = 文本出站**：念的内容会发给对应厂商（edge-tts 发给微软）。
  群聊台词在送进 TTS 之前必须先过敏感词/身份信息审计，和「发消息」用的是同一条线。
- **Key 不进仓库、不进日志**：错误信息里只出现 HTTP 状态与厂商的 message，不会回显 Key
  （`http-audio.js` 统一处理，回归测试里有一项专门断言这一点）。
- 成本：edge-tts 免费；OpenAI / Azure / 硅基流动按量计费，200 字一条通常在「几厘到几分钱」量级，
  但**会随套餐和模型波动**，别把它当固定价目表。
- 隐私：音色克隆（CosyVoice2）需要参考音频，那段音频也会上传到服务商，用前先确认来源合法。

---

## 7. 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `Python 里没有安装 edge-tts` | `pip install edge-tts` |
| `找不到 python 解释器` | `python` 不在 PATH；在 `tts.providers.edge.python` 写绝对路径 |
| `连不上微软语音服务` | 网络/代理问题；edge-tts 需要能访问微软的语音接口 |
| `返回 HTTP 401/403（Key 无效…）` | Key 错、过期、或没有该模型权限 |
| `返回 HTTP 429（触发限流或余额不足）` | 账号限流 / 欠费 |
| `文本太长：X 字，超过上限 N 字` | 调 `tts.maxChars`，或自己拆成多条 |
| `音频探测失败` 只作为 warning | ffprobe 不在 PATH 不影响发送，只是拿不到时长 |
| `TTS 提供方「…」还没配好` | 用 `--list-providers` 看缺什么 |

---

## 8. 测试

```bash
node scripts/test-tts.mjs          # 离线：配置规整 / 文本校验 / 契约 / 落盘 / 清理 / 错误不泄漏 Key
node scripts/test-tts.mjs --live   # 额外真合成一句中文并校验时长与体积
```

`--live` 需要外网和可用的 python+edge-tts；离线那部分在任意机器上都应该过。
