# 视频理解（让 bot「看」视频）

模型不能播放视频，但能读**图片**和**文字**。所以「看视频」这件事被拆成两步：

```
QQ 群里的视频 ──► ffmpeg 抽关键帧 ──► 3×3 联系表（图片，每格标 #frame 分:秒）
              └► ffmpeg 抽音轨 ────► faster-whisper 本地转写（文字，带时间戳）
                                          ↓
                            模型同时拿到「画面 + 说话内容」
```

实现在 `src/video-digest.js`，抽帧/转写复用 `video-watch` skill 的 `scripts/watch.py`
（uv 脚本，依赖写在自己头里，首次运行自动拉 yt-dlp / Pillow / faster-whisper）。

## 1. 群里发视频会发生什么

1. OneBot 推来的消息里有 `{type:'video', data:{url, file}}`；
2. `extractMediaFromSegments()` 把它记为 `kind:'video'`（同步、零 IO）；
3. 模型需要这一条上下文时，`resolveMediaList()` 调 `digestQqVideo()`：
   - 用 `safeFetchBuffer` 下载（上限 `maxBytes`，默认 32 MB）；
   - `ffprobe` 读时长/分辨率/有没有音轨，超过 `maxSeconds`（默认 180s）就只说一句「太长没看」；
   - 跑 `uv run --script watch.py <mp4> --out <临时目录> --max-frames N`；
   - 读回 `sheets/*.jpg`（联系表）、`transcript.txt`（转写）、`report.md`（元信息）；
4. 联系表以 `image` 部件、转写以 `text` 部件进上下文，模型就能像看截图一样「看」视频；
5. 临时目录用完即删（`state/tmp-video/video-*`）。

**没有音轨的视频不会白跑 Whisper**（`probeVideo().hasAudio === false` → 传 `--no-transcript`）。

**转写失败但抽帧成功**算部分成功：画面照给，附加一句「转写失败，只有画面」。

## 2. 配置（`config.json` 的 `socialV2.media.video`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后视频只留 `[视频]` 占位，不下载不处理 |
| `maxBytes` | 32 MB | 下载上限；超了直接放弃（QQ 群的短视频通常 1–30 MB） |
| `maxSeconds` | 180 | 时长上限；直播回放/长录屏不看（会把整轮对话卡住几分钟） |
| `maxFrames` | 18 | 送进 watch.py 的帧数（`--max-frames`），18 帧 = 2 张 3×3 联系表 |
| `maxSheets` | 2 | 最多把几张联系表塞进上下文（每张约 100–300 KB） |
| `model` | `base` | Whisper 模型：`tiny`/`base`/`small`；中文口播 `base` 是性价比拐点 |
| `language` | `""` | 空 = 自动判定；固定 `zh` 可避免短音频被误判成英文 |
| `timeoutMs` | 300000 | 整条链路超时（下载+抽帧+转写） |
| `maxTranscriptChars` | 6000 | 转写文本进上下文的字符上限（Whisper 对长视频会产出几万字） |
| `uvPath` | `""` | 空 = 从 PATH / `~/.local/bin` / `~/.cargo/bin` 找 `uv` |
| `scriptPath` | `""` | 空 = `$DSH_HOME/skills/video-watch/scripts/watch.py` |

改完**必须重启桥接**（`config.json` 只在启动时读）。

## 3. 依赖

| 依赖 | 本机位置 | 缺了会怎样 |
| --- | --- | --- |
| `ffmpeg`/`ffprobe` | `C:\Users\sbsb1\tools\ffmpeg\bin`（已在 PATH） | 抽帧/探针全挂，视频只会留占位 |
| `uv` | `C:\Users\sbsb1\.local\bin\uv.exe` | `ok:false`，提示「没找到 uv」 |
| `video-watch` skill | `$DSH_HOME/skills/video-watch/` | `ok:false`，提示「没找到 watch.py」 |
| Whisper 模型 | `~/.cache/huggingface/`（首次几百 MB） | 转写失败，但画面仍然可用 |

首次处理视频时 uv 会下载 yt-dlp / Pillow / faster-whisper（约 100 MB 依赖）+ Whisper 模型
（`base` 约 145 MB），所以第一条视频可能要等 1–3 分钟，之后几秒。

## 4. 链接也能看：`video-watch` skill

skill 已装到 `C:\Users\sbsb1\.dsh-qq\skills\video-watch\`（QQ 那个 DSH 的 skills 目录），
所以 AI 在群里遇到「这个视频讲了啥 https://…」时可以自己跑：

```powershell
uv run --script $env:DSH_HOME\skills\video-watch\scripts\watch.py "<url>" --out <临时目录> --max-frames 18
```

它支持 yt-dlp 能下的所有站点（B 站/抖音/YouTube/X…），也支持本地文件。
`SKILL.md` 里写了「先看 sheets 再看 transcript」的使用建议。

## 5. 测试与排错

```powershell
npm run test-video                    # 离线：定位/ffprobe/失败分支
npm run test-video:live <视频路径>      # 真跑一遍 watch.py（首跑要下载依赖和模型）
```

排错按顺序看：

1. **`[视频N]（视频理解已关闭…）`** → 没开或改完没重启桥接；
2. **`（处理超时…）`** → 网络慢或视频太长，调 `timeoutMs` / `maxSeconds`；
3. **`（…只有画面）`** → Whisper 模型没下下来，检查 `~/.cache/huggingface` 与网络；
4. **`（没找到 uv / watch.py）`** → 路径问题，用 `uvPath` / `scriptPath` 显式指定；
5. 细节日志：`state/tmp-video/…/watch.log`（处理完目录会删，需要时临时把
   `cleanupVideoWorkDir` 跳过，或直接手动跑第 4 节的命令）。

## 6. 结果缓存（`socialV2.media.cache`）

一次视频理解 = 下载 + ffmpeg 抽帧 + Whisper 转写，几十秒起步（本机实测 6 秒样例 7.3 秒）。
同一段视频被群友转发第二次、或隔天又问「看看这个」，没有缓存就得从头再算一遍。2026-10-31 新增。

**键是什么**

- 群里的视频：`sha256(视频字节) + 设置指纹`。**不能按 URL 缓存**——QQ 媒体链接几分钟就过期，
  同一段视频每次拿到的 URL 都不同。
- 链接（B 站/抖音）：下载前无法哈希，只能按「规范化 URL + 设置指纹」缓存，有效期更短
  （`urlMaxAgeDays`，默认 7 天；作者换片源时旧结果不可信）。规范化会摘掉
  `spm_id_from / vd_source / share_source / from / timestamp` 等分享参数。
- 设置指纹包含 `maxFrames / maxSheets / model / language / maxTranscriptChars` ——
  改这些参数会让旧缓存全部 miss（否则会拿到旧帧数/旧模型的结果）。

**全字段**

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关掉后行为与没有缓存完全一致 |
| `dir` | `state/media-cache` | 落盘目录（相对仓库根） |
| `maxBytes` | 512 MiB | 超过就按 LRU 淘汰 |
| `maxEntries` | 400 | 条数上限 |
| `maxAgeDays` | 30 | 内容型条目有效期 |
| `urlMaxAgeDays` | 7 | 链接型条目有效期 |

**行为**

- 命中：日志 `[cache] 视频缓存命中（N 次使用…）`，**跳过下载后的全部处理**，直接把联系表从磁盘读回，
  实测 2 ms（vs 7322 ms）。
- 写入：日志 `[cache] 已缓存视频结果：N 张联系表 / X KB`；写完顺手 `prune()`（先删过期，再按
  `lastUsedAt` 从旧到新淘汰到体积/条数达标）。
- 坏条目自清：图片文件丢失、`meta.json` 半截写坏 → 读取时判 miss 并删掉整个条目，
  绝不把半份结果交给模型。
- 落盘用 `.tmp → rename`，rename 被占用时退回 `copyFile`（OneDrive/杀软场景）。

**排错**

1. 一直不命中 → 看日志有没有 `[cache]`；同一视频两次的 `sha256` 应一致。
2. 磁盘涨得快 → 调小 `maxBytes` / `maxEntries`；`state/media-cache` 可以直接整个删掉重建。
3. 想立刻清空 → `rm -rf state/media-cache`，或临时 `enabled:false` 跑一轮。
