# state 目录放在哪（docs/guides/STATE.md）

2026-11-22 新增（优化 A2：把会频繁写的状态从 OneDrive 里搬出去）。

## 现在的布局

```
C:\Users\sbsb1\OneDrive\Desktop\DshBot\qq-bridge\state\         ← 仍在 OneDrive（小文件、低频）
├── bridge.log / bridge.log.1 / bridge-run.log                  ← 日志（追加写）
├── social-v2.json / slang.json / stickers.json / feedback.json ← 群聊与表情状态
├── media-cache\  files\  tts\                                  ← 媒体与语音缓存
├── agent-presets 相关、admin-*.json、supervisor.log、mcp-tools.json …
├── agents\        → [Junction] C:\Users\sbsb1\AppData\Local\DshBot\agents
└── slang-agent\   （仍在 OneDrive —— 迁移时被进程占用，待下次）
```

`agents\` 是**每个群会话的工作目录**（DSH session cwd = `qq-bridge\state\agents`），
里面还长着记忆库 `.dsh-meow\memory.db`（+`-wal`/`-shm`）和 `sessions\*.json`。
它是最热的目录：一个回合里会写十几次，WAL 长期 3-4 MB —— 放在 OneDrive 里等于
「一边写一边被同步」，代价是冲突副本、偶发锁死，以及群聊记忆被传到云端。

## 为什么用 Junction 而不是整体搬家

整体搬 `state\` 需要先把目录删掉再建链接，而 `memory.db` 常被 DSH/MCP 进程持有，
删不掉（2026-11-22 实测：停掉桥接、DSH、OneDrive 都没放开，反而把 `mv` 退化成了
「复制+逐个删除」，留下半搬移的两个目录）。改成**搬子树 + Junction**：
`state\agents` 这个目录名不变、里面的东西单独搬走，代码里的所有
`path.join(ROOT, 'state', ...)` 都不用改。

制作方式（管理员不是必须的，Junction 不需要提权）：

```cmd
robocopy "qq-bridge\state\agents" "%LOCALAPPDATA%\DshBot\agents" /E
rmdir /S /Q "qq-bridge\state\agents"
mklink /J "qq-bridge\state\agents" "%LOCALAPPDATA%\DshBot\agents"
```

## 注意

1. **DSH 必须重启**才会用新路径（它启动时把 session cwd 定下来；旧进程会继续拿着旧句柄）。
2. OneDrive 不跟 Junction：搬走以后 `agents\` 的体积不再计入同步，云端也不会收到记忆库。
   但 `qq-bridge\state` 本身仍在 OneDrive 里，所以日志/状态仍会被同步（量级小，可接受）。
3. 备份要跟着改：`backup.cmd` / 手工 `tar -czf` 对 Junction 是透明的（会跟进去），
   但 `tar` 默认不保存 Junction 本身，恢复时要重建链接。
4. 想回退：删掉 Junction（`rmdir "qq-bridge\state\agents"`，只删链接不删目标），
   再把 `%LOCALAPPDATA%\DshBot\agents` 复制回来。
5. `slang-agent\` 还是老样子（在 OneDrive）。下次停机窗口里照上面的办法再搬一次，
   搬完把这一节改成「已搬」。它比 `agents` 更大（5 MB 会话 + 1.3 MB slang.json 在 state 根上）。
