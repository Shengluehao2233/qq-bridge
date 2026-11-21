# 守护进程（scripts/dsh-supervisor.mjs）

2026-11-22 新增（优化 A1：掉链自愈）。解决的是「机器睡一觉/半夜自动更新之后，3082 没了、机器人静默不动，
而 nobody 在电脑前面」这件事。

```cmd
DshBot\start-supervisor.cmd        :: 前台跑，Ctrl+C 退出；也可以后台
node qq-bridge\scripts\dsh-supervisor.mjs --once   :: 只检查一次，不常驻（给 cron/任务计划用）
```

## 它盯两个目标

| 目标 | 探活方式 | 挂了怎么办 |
| --- | --- | --- |
| DSH 3082 | `GET http://127.0.0.1:3082/`（200/302/401/403 都算活） | 用 `node bin.js --profile web --no-open --port 3082` 拉起，`DSH_HOME` 默认 `~/.dsh-qq` |
| 桥接 3100 | `GET http://127.0.0.1:3100/api/status` | 用 `node src/bridge.js` 拉起（工作目录 `qq-bridge/`） |

**不**动 SnowLuma：它 hook 着 QQ 进程，重启会让账号掉线重登，得不偿失。

## 关键参数（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SUPERVISOR_INTERVAL_MS` | `15000` | 巡检间隔 |
| `SUPERVISOR_DSH_HOME` | `~/.dsh-qq` | 拉起 DSH 用哪个 home。**故意不读 `DSH_HOME`** |
| `SUPERVISOR_DSH_PROFILE` | `web` | 拉起 DSH 用哪个 profile。**故意不读 `DSH_PROFILE`** |
| `SUPERVISOR_DSH_CWD` | `DshNew`（由 bin.js 路径推导） | 拉起 DSH 的工作目录 |

熔断：每个目标独立退避 `30s → 60s → 120s → 300s`，每小时最多 12 次；连续 2 次探测失败才动手
（避免一次抖动就重启）；拉起后有 **45s 启动宽限**，宽限期内失败不计数、不重复拉起。
单实例锁 `state/supervisor.lock`，日志 `state/supervisor.log`。

## 三个必须知道的坑（都是实测踩出来的）

1. **不要把桌面上那个 DSH 当成「DSH 活着」**。桌面版每次启动端口随机（曾经是 11533），
   而且它和 CLI 版用同一套本机签名密钥铸造 Cookie，探活也会成功——之前桥接的端点自愈就是这样
   把 QQ 消息接到了桌面 profile 上（人设、工具、记忆全错）。所以 3082 的探活固定打配置里的端口，
   桥接侧也用 `dsh.autoDiscoverPort=false` 关掉了跨实例跳转；健康检查会断言「桥接连的就是这个端口」。
2. **不能继承外层的 `DSH_*` 环境变量**。从桌面版会话里启动守护进程时，环境里带着
   `DSH_PROFILE=desktop`、`DSH_HOME=~/.dsh`、`DSH_INSTALL_DIR=<Electron asar>`、
   `DSH_NODE_EXECUTABLE=<Electron exe>`、`DSH_WEB_URL=http://127.0.0.1:<桌面端口>`。
   直接继承的后果：CLI 收到 `--profile desktop` 直接报
   `error: profile "desktop" is managed exclusively by the Electron application`
   然后退出；桥接还会把 `DSH_WEB_URL` 当端点候选。`childEnv()` 会把所有 `DSH_*` 剥掉再传下去。
3. **定时器不能 `unref()`**。守护进程靠 `setInterval` 维持事件循环，`unref()` 之后加上一个
   永久 pending 的 Promise，进程会「跑完第一轮就静默退出」——第一次实测就是这样，
   3082 死了 80 秒日志里一个字都没有。

## 日常怎么用

- 开机后：`start-all.cmd`（原来那套）→ 再加一个 `start-supervisor.cmd` 常驻。
- 出问题时：`health.cmd` 看哪条红 → `state/supervisor.log` 看它有没有动手 → `state/bridge.log` 看桥接侧。
- 想临时接管：先 `Ctrl+C` 停守护进程，再手工起 DSH/桥接；守护进程发现端口在线就不会再拉一个。
- 验证守护真的有效（可选）：`Stop-Process -Id <3082 的 pid>`，约 10-20 秒内
  `state/supervisor.log` 出现「已拉起 DSH 3082」+「DSH 3082 已恢复」，`health.cmd` 依旧全绿。
