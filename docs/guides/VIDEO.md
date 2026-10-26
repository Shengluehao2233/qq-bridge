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
