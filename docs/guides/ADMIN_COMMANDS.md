# 管理员命令（QQ 里直接发）

在群里或私聊**直接发**以 `/` 开头的消息即可，命令只在 `config.json` 的 `ownerQQ` 账号下生效。

- **管理员**：命令执行，结果回一条消息（部分命令只写日志）。
- **非管理员**：默认静默——不回、不解释，只在桥接日志留一行 `忽略非管理员命令`（`config.json`
  的 `commands.rejectNonOwner` 设为 `true` 才会回一句「管理命令仅管理员可用」）。
- 群友发 `#sl` / `#st` 之类**不是命令**，桥接不会理它（`#sl` 由 SnowLuma 自己的 statusCommand
  处理，与桥接无关；关闭见 `C:\SnowLuma\config\onebot_<uin>.json` 的 `statusCommand.enabled`）。

## 命令一览

| 命令 | 作用 | 备注 |
| --- | --- | --- |
| `/help` | 列出全部可用命令 | 不看当前配置，纯静态清单 |
| `/status` | 状态总览：DSH/桥接/模式/角色/白名单/语音/TTS/缓存 | 字段多了以后建议先看这条 |
| `/reset` | 清掉当前会话上下文 | 会新开一个 DSH 会话 |
| `/log` | 看桥接日志最后 30 行 | 可选行数：`/log 50`（最多 200，整条压到 3000 字） |
| `/pause` | 暂停自动回复（群里灌水停噪用） | 私聊仍可用命令 |
| `/resume` | 恢复自动回复 | |
| `/role <名>` / `/role off` / `/role list` | 切换角色卡 | 名字见 `roles/` 目录 |
| `/silent` / `/active` | 只回 @ 我 / 恢复主动接话 | |
| `/recall` / `/recall N` / `/recall <message_id>` | 撤回机器人自己发的消息 | 别名 `/undo`；QQ 撤回窗口约 2 分钟 |
| `/语音 ...` | 语音开关、换音色语种、念指定文字 | 详见 [TTS.md](TTS.md) |

## 命令有冷却，别指望连发

同一类命令 3 秒冷却（`/recall` 也是 3 秒），避免刷屏和被误触。

## `/log` 会脱敏

`/log` 返回的是桥接日志原文，但会先做替换：

- `token` / `key` / `secret` / `password` 等词后面的值 → `***`
- 图片 URL 里的哈希会被压成 `…`
- 单行超过 160 字符截断，避免一条消息刷屏

**日志里请不要出现的东西**：OneBot accessToken、DSH launch token、控制台 token、
API Key。代码里已经尽量不打印，新增功能时也请照这个口径。

## 日志落在哪、怎么控

改日志行为前先看这三条（详细实现见 `src/bridge.js` 顶部的 `log()` / `logThrottled()`）：

1. **权威记录是文件，不是窗口**：`state/bridge.log`（保留最后 2000 行）写入所有 `log()` 输出，
   `/log` 命令读的就是它。窗口里能不能看到取决于有没有真终端：双击 `start.bat`/守护窗口能看到
   实时回显；把 stdout 重定向到文件时窗口是空的，但文件照样有。
2. **另外两份文件日志**：
   - `state/bridge-out.log` —— 桥接自己的 warn/error 明细，超过 5 MB 轮转，保留 3 份；
   - `state/ipc.log` —— DSH/MCP 交互流水，超过 20 MB 轮转。
3. **等级与去重**：`LOG_LEVEL=debug|info|warn|error`（默认 `info`），`DEBUG=1` 强制 debug；
   同一条 warn 30 秒内只打一次（`logThrottled`）。

第 54 号问题是反面教材：`qq-tool-restrict` 插件曾在每次 preset 装载时把 78 个
`unknown global tool` 全名塞进一行 7 KB 的错误日志，刷满 stderr。现在改成

```
[qq-tool-restrict] 已隐藏 4 个全局工具；78 个名字在本版本不存在（预期，见名单注释）；真正失败 0 个
```

（真失败才会逐个列出名字。）

## 改了代码之后

1. `node --check src/bridge.js`（和改到的文件）
2. 重启桥接（**配置只在启动时读一次**）
3. `health.cmd`（Windows）或 `npm run health` —— 五条断言全绿再收工
4. QQ 里发 `/help`、`/status`、`/log 5` 各验一次

## 排错

| 现象 | 先看 |
| --- | --- |
| 发命令没反应 | 是不是 `ownerQQ` 本人？日志有没有 `忽略非管理员命令` |
| `/log` 返回「日志为空」 | 桥接是后台跑的，`state/bridge-out.log` 只记 warn/error，正常无内容 |
| `/reset` 后还是旧上下文 | `/status` 看 DSH 是否 `dshReady`；桥接没连上 DSH 时 `/reset` 也会报错 |
| 命令回两条 | 检查是不是 `start-all.cmd` 与手动各起了一个桥接实例（`state/bridge.lock`） |
