# QQ 机器人的记忆（meow-memory）

机器人「记住人和事」不是桥接实现的，而是把 DSH 侧的 [meow-memory](https://github.com/Phant0Meow/dsh-meow-memory) 插件装进了 **QQ 机器人自己的 DSH 实例**（`DSH_HOME=C:\Users\sbsb1\.dsh-qq`，profile `web`，端口 3082）。

> 一句话：桥接负责「收发」，记忆负责「记得」；两者通过同一个工作区（`qq-bridge\state\agents`）共享记忆库。

## 1. 装了哪些东西

| 位置 | 改动 | 说明 |
| --- | --- | --- |
| `~/.dsh-qq/profiles/web/package.json` | `dependencies` 加 `meow-memory`；`dsh.profile.bundles` 加 `"meow-memory"` | 插件包 + 让 DSH 挂载它 |
| `~/.dsh-qq/profiles/web/cordis.patch.yml` | 顶部插入 `- id: meow-memory / name: 'meow-memory' / config: {...}` | 运行时配置（可关、可调注入条数） |
| `qq-bridge/plugins/qq-agent-presets/qq-tool-restrict.mjs` | `SAFE_EXACT` 放行 6 个 `memory_*` 工具 | 不放行的话，模型看得到工具但一调就被守卫拒 |
| `qq-bridge/docs/guides/MEMORY.md` | 本文件 | |
| `qq-bridge/scripts/probe-memory.mjs` | 端到端探针 | 真跑一回合，断言 `memory_remember` / `memory_search` 都能调 |

安装命令（profile 用的是 pnpm 的 `link:` 协议，**npm 会报 `EUNSUPPORTEDPROTOCOL`**）：

```powershell
cd C:\Users\sbsb1\.dsh-qq\profiles\web
pnpm add meow-memory@0.32.6
```

`--dump-config` 里能看到 `# == meow-memory, patched by …\cordis.patch.yml` 就说明挂上了：

```powershell
$env:DSH_HOME='C:\Users\sbsb1\.dsh-qq'
node C:\Users\sbsb1\DshNew\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --dump-config | Select-String -Pattern 'meow' -Context 1,6
```

## 2. 为什么改守卫

`qq-tool-restrict.mjs` 是「执行期白名单」：不在 `SAFE_PREFIXES` / `SAFE_EXACT` 里的工具一律拒绝。
记忆插件注册的是 `memory_search`、`memory_remember`、`memory_read`、`memory_update`、`memory_find_similar`、`memory_project` —— 都不带 `mcp__` 前缀，所以必须逐个写进 `SAFE_EXACT`。

**故意不放行的两个**：

- `memory_home`：会改实例级数据目录，是跨 profile 的全局副作用；
- `memory_dream`：会另起一轮后台反思（等于让群友间接烧模型调用）。

以后插件加新工具，**不要**图省事写 `memory_` 前缀全放行——加名字、加测试断言，`scripts/test-tool-restrict-guard.mjs` 里有一条专门防这个。

## 3. 数据落在哪

| 文件 | 内容 |
| --- | --- |
| `<工作区>\.dsh-meow\memory.db` | **真正的记忆库**（SQLite + `-wal`/`-shm`）；QQ 侧工作区 = `qq-bridge\state\agents` |
| `<工作区>\.dsh-meow\sessions\*.json` | 每个会话的注入/反思账本 |
| `<工作区>\.dsh-meow\dream-debug.log` | 反思轮调试日志 |
| `C:\Users\sbsb1\.dsh-meow\` | 插件**实例级**目录：`window-index.json`、`perf.log`、`trusted-workspaces\`、`settings-diag.log` |

- `state/` 已在 `.gitignore` 里，记忆库不会被提交、也不会被备份脚本误打包（备份跑到 `qq-bridge` 时只收 `src/scripts/public/config.json/package.json`）。
- QQ 侧所有群**共用这一个工作区** ⇒ 也共用同一个记忆库。群里聊到的偏好可能被带到另一个群的回答里，这是当前架构的已知特性（不是 bug）。

## 4. 配置项（`cordis.patch.yml`）

```yaml
- id: meow-memory
  name: 'meow-memory'
  config:
    enabled: true      # false = 注入、反思、记忆工具全关
    hitTopK: 2         # 每条消息最多注入几条命中记忆（够用即可，别调大：每轮都吃 token）
    reflect: true      # 任务结束后自动反思，把值得记的写进库
    promptLang: zh     # 注入的中文提示
```

改完要重启 DSH 3082 才生效（插件在启动时读配置）。

## 5. 验证

```powershell
Set-Location C:\Users\sbsb1\OneDrive\Desktop\DshBot\qq-bridge
$env:DSH_HOME='C:\Users\sbsb1\.dsh-qq'; $env:DSH_BASE_URL='http://127.0.0.1:3082'
node scripts/probe-memory.mjs qq-chat-v2
```

判定行应该全绿：

```
memory_remember 调用   : ✅
memory_search 调用     : ✅
工具结果错误数          : 0
```

探针会建临时会话、归档并删掉工作区；但它会真的往记忆库写一条「记忆自检」，跑完可在 `memory.db` 里看到。

在 QQ 里的人工验证：群里发「帮我记住：周五晚八点开黑」，之后再问「帮我查一下周五几点开黑」。

## 6. 关闭 / 卸载

- **临时关**：`cordis.patch.yml` 里把 `enabled` 改 `false` → 重启 DSH。
- **彻底卸**：从 `package.json` 的 `dsh.profile.bundles` 删掉 `"meow-memory"`，删掉 patch 里那条，`pnpm remove meow-memory` → 重启 DSH。记忆库文件留在工作区，需要的话手动删 `<工作区>\.dsh-meow`。
- 守卫那条白名单可以留着（工具不存在时它什么也不做）。

## 7. 坑

- **npm 装不上**：profile 的依赖是 `link:` 协议，必须用 pnpm。
- **`memory_` 出现 0 次 ≠ 没风险**：守卫的 deny 名单里没有记忆工具，真正的闸门是执行期白名单，漏加就是「模型能看到、一调就报错」——探针里表现为 `tool/result` 的 `isError: true`，而不是工具不存在。
- **`dsh/tool-names` 扫不到它们**：记忆插件的工具是运行时动态注册的，`scripts/dsh-tool-names.mjs` 只扫 `@deepseek-ai` 包，别指望自动补白名单。
- **DESKTOP 与 QQ 是两套独立实例**：桌面 DSH（3080）有自己的 meow-memory 与 `~/.dsh-meow`；QQ 侧是 profile 级安装，两边记忆不共享。
