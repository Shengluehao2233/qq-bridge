# 健康检查（health.cmd / scripts/health-check.mjs）

一条命令回答「现在哪儿坏了」，五条断言覆盖整条链路。2026-10-31 新增（优化 B）。

```cmd
DshBot\health.cmd                 :: 人读格式，双击也能跑；红一项即 exit 1
DshBot\health.cmd --json          :: 给脚本/监控用
DshBot\health.cmd --fix           :: 桥接没起时顺手拉起（其余只报告，不自动重启 DSH）
```

等价于 `node qq-bridge\scripts\health-check.mjs`（在 `qq-bridge\` 目录下）或 `npm run health`。

## 五条断言

| 断言 | 怎么测 | 红了的典型原因 |
| --- | --- | --- |
| SnowLuma OneBot HTTP | `POST {snowluma.httpUrl}/get_login_info`（带 `accessToken`） | SnowLuma 没起、QQ 没登录、token 与 `config.json` 不一致 |
| OneBot WebSocket | 对 `snowluma.wsUrl` 的端口做 TCP 连接 | OneBot WS 服务没开（HTTP 活着也不等于 WS 活着） |
| 桥接 | `GET {consolePort}/api/status`（带 `x-console-token`） | 桥接没起、控制台令牌不对、`dshReady=false`（= DSH 没起或没连上） |
| DSH 实例 | `GET {dsh 端口}/`（不跟随跳转，接受 200/302/401/403） | DSH 进程没了、端口被别的程序占了 |
| MCP 工具表 | 比 `state/mcp-tools.json` 的 `startedAt` 与 3082 监听进程的启动时间 | **最阴的一种**：只重启了桥接、没重启 DSH，模型仍看旧工具表 |

最后一条是这套系统最容易浪费时间的坑，所以单独做成了断言：

- MCP server 由 **DSH 启动时**拉起（`setup-dsh.mjs` 写进 profile 的 MCP 配置），桥接代码更新不会让它重新加载；
- `src/mcp-snowluma-safe.js` 在 `server.connect()` 前把本进程注册的工具名写进 `state/mcp-tools.json`（`startedAt` / `pid` / `count` / `tools`）；
- 健康检查拿这个时间和 DSH 进程启动时间比：**快照比 DSH 还旧 ⇒ 工具表是上一代**，处理办法就是重启 DSH。

## 退出码

- `0`：没有 `fail`（可能有 `warn`）
- `1`：至少一项 `fail`
- `2`：检查脚本自身出错

## 排错顺序（红了先看哪）

1. `SnowLuma OneBot HTTP` 红 → 先修 SnowLuma（`C:\SnowLuma` 起进程、确认 QQ 已登录），后面全都会连带红。
2. `桥接` 红且提示 `dshReady=false` → 去起 DSH 3082（`start-dsh-qq.cmd`），桥接会自己连上。
3. 只有 `MCP 工具表` 红 → 重启 3082 即可；重启会话最好挑没有回合在跑的时候。
4. 全绿但群里仍没反应 → 看 `qq-bridge\state\bridge.log` 里有没有 `忽略非管理员` / `白名单` 相关日志，那属于策略问题不是故障。
