# 换协议端（OneBot v11）

> 背景：QQ 协议端（SnowLuma）上游已于 2026-11-09 因腾讯律师函转为 private，不再更新。
> 本机版本 1.14.17 可继续用，但将来若要换端，桥接只依赖 **OneBot v11 标准接口**，
> 业务代码不用改，只改 `config.json` 里 `snowluma` 段的三个字段。

## 一、桥接只认这几项

| 字段 | 作用 | 本机当前值（SnowLuma 1.14.17） |
| --- | --- | --- |
| `snowluma.wsUrl` | OneBot **WebSocket**（事件推送 + API） | `ws://127.0.0.1:2001` |
| `snowluma.httpUrl` | OneBot **HTTP API**（发语音、取消息、群文件等） | `http://127.0.0.1:2000` |
| `snowluma.accessToken` | 两端共用的 access token | 见 config.json（本地不入库） |
| `snowluma.launcherPath` | 仅「一键启动协议端」用到，可空 | `C:\SnowLuma\launcher.bat` |
| `snowluma.homeDir` | 仅进程控制/日志定位用到，可空 | `C:\SnowLuma` |

`followDiscoveredEndpoint`（默认 true）是桥接侧的一个小优化：当协议端上报的端点与配置一致时，
允许跟随新的 token/端口（SnowLuma 重启会换 token）。换到别的协议端时建议设为 `false`，
避免它跟随到不认识的端点。

## 二、换端三步

1. **起新协议端并记下端点**：拿到它的 HTTP 端口、WS 端口、access token（大多数 OneBot 实现是
   `3000/3001` + token，别照抄本机的 2000/2001）。
2. **改三行**（`qq-bridge/config.json`）：

   ```json
   "snowluma": {
     "wsUrl": "ws://127.0.0.1:<新 WS 端口>",
     "httpUrl": "http://127.0.0.1:<新 HTTP 端口>",
     "accessToken": "<新 token>",
     "followDiscoveredEndpoint": false,
     "launcherPath": "",
     "homeDir": ""
   }
   ```

   同步把 `qq-bridge/start-all.ps1` 里的启动顺序按需调整（原来会去拉 SnowLuma）。
3. **重启桥接并验证**：`DshBot\health.cmd`（五条断言），第一条就是 OneBot `get_login_info`；
   再在群里 @ 一次做真实收发。

## 三、兼容性检查清单（新端必须支持）

基础：`get_login_info`、`send_group_msg`、`send_private_msg`、`get_msg`、`delete_msg`、
`get_group_msg_history`、`get_group_member_list`、`get_group_member_info`。

本桥接额外用到（缺了会降级或报错，不致命）：

| 能力 | 用到的地方 | 缺失后果 |
| --- | --- | --- |
| `get_group_root_files` / `get_group_file_url` | 群文件读取（`qq_list_group_files` / `qq_download_file`） | 群文件功能不可用 |
| `upload_group_file` | 上行发文件 | 发文件不可用 |
| `get_record` / `send_record`（语音） | `/语音` 与 TTS 发送 | 语音功能不可用 |
| `set_group_ban` / `set_group_kick` | 管理员动作（若开启） | 管理动作不可用 |
| `#sl` 状态命令 | SnowLuma 私有扩展，标准里没有 | 无影响（我们已关闭播报） |

## 四、换端后要重做的几件事

1. **账号配置**：新端的账号/登录信息与 SnowLuma 的 `config\onebot_<uin>.json` 不通用。
2. **token 同步**：桥接只在启动时读 `config.json`，改完必须重启桥接（`state\bridge.lock` 若残留要先删）。
3. **多账号**：本机现在是一个 SnowLuma 进程挂多个 QQ 号；换端后如果按账号分进程，`wsUrl` 只能指向
   要接机器人的那个账号。
4. **上号风控**：任何非官方协议端都有账号风险，换端前先评估，别拿主号试。

## 五、回滚

`config.json` 改前先复制一份（`config.json.bak-<时间戳>`），换端失败直接还原 + 重启桥接即可。
程序本体留底见 `DshBot\backup-snowluma-<时间戳>.tar.zst`（含 `config/`、`native/`、`index.mjs`，
不含 `logs/` 与 `data/`；恢复：解压到目标目录后跑 `launcher.bat`）。
