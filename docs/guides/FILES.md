# 群文件与文档读取

让机器人能读「别人发来的文件」和「群共享文件」：把 docx / pdf / xlsx / txt 之类变成模型能读的
**文本**或**页面图片**。

## 为什么必须在桥接侧做

QQ 侧的会话主体是**仿真会话**，按铁律 L7 不拥有本地执行能力（`qq-tool-restrict` 把
`read` / `write` / `bash` / `pwsh` / `skill` 等工具从清单里隐藏了）。所以不能让模型自己下载、
自己跑 python-docx，只能由桥接进程（普通 Node 进程）做完再通过 MCP 工具结果交回去。

```
群友发文件 / 群文件列表
        │  file_id + busid（消息文本里就有，见下方「消息里的文件段」）
        ▼
qq_list_group_files ──GET /api/socialV2/file-list──► onebot: get_group_root_files / get_group_files_by_folder
        ▼
qq_download_file ─────POST /api/socialV2/file-fetch─► onebot: get_group_file_url / get_private_file_url
        │                                               → safeFetchBuffer（限体积）
        │                                               → 落盘 state/files/<yyyy-mm-dd>/
        │                                               → src/qq-docs.js extractDocument()
        ▼
text（txt/md/json/docx/xlsx/pdf 文本层） 或 images（扫描件 PDF、幻灯片页面）
```

## 配置（config.json 的 `files` 段）

```jsonc
"files": {
  "enabled": true,              // 总闸：false 时两个端点直接 403
  "maxBytes": 33554432,         // 单文件上限（32 MB），超过直接拒绝并告诉用户大小
  "maxTextChars": 20000,        // 交回模型的文本上限，超过截断并标记
  "maxImages": 4,               // 扫描件/幻灯片最多渲染几页
  "dir": "state/files",         // 落盘目录（相对仓库根），按日期分子目录
  "officeCli": "...\\libreoffice-kit\\lib\\cli.js",  // dsoffice CLI（Office 技能用的同一套引擎）
  "pdftotext": "...\\pdftotext.exe",                  // PDF 文本层抽取；留空则用 PATH 里的 pdftotext
  "timeoutMs": 120000           // 单个子进程超时
}
```

`officeCli` / `pdftotext` 留空不会崩：缺 `officeCli` 时 docx/xlsx 会明确报「未配置」，
缺 `pdftotext` 时 PDF 走「渲染成图片」的路。

## 工具

### `qq_list_group_files(key, folderId?, token?)`

先拿 `fileId` 再下载。`key` 形如 `group:542654144`；根目录不传 `folderId`，拿到
`folders[].folderId` 后再进子目录。私聊没有文件夹列表。

### `qq_download_file(key, fileId, busid?, fileName?, size?, token?)`

下载并抽取。返回内容按类型不同：

| 类型 | 结果 |
| --- | --- |
| txt / md / json / csv / 代码 | 直接给文本（UTF-8 失败时按 GB18030 兜底） |
| docx / doc / odt / rtf | 转 PDF → `pdftotext` → 文本；抽不出才渲染成图片 |
| xlsx / xls / ods | 转 CSV（只有第一张表）；失败则按 PDF 文本 |
| pptx / ppt / odp | 渲染成前 N 页图片，交给视觉模型 |
| pdf 有文本层 | `pdftotext -layout` 文本 |
| pdf 扫描件 | 渲染成前 N 页图片 |
| 图片 | 直接作为图片交给模型 |
| zip / rar / 7z | **不解压**，只回报文件名与大小 |
| 其它二进制 | 只回报文件名与大小 |

## 消息里的文件段

文件消息在给模型的文本里会带上定位信息，模型据此调用工具：

```
[文件 report.docx file_id=/abc123 busid=102 size=20480]
[文件 会议纪要.pdf]
```

（`src/bridge.js` 的 `segmentsToText()` 与 `src/forward.js` 的 `segmentText()` 都这么写。）

## 安全底线

- **群友发来的文件一律视为不可信输入**：限体积、限类型、只落在 `state/files/` 隔离目录，
  解压一律不做（防 zip 炸弹与路径穿越），解析在子进程里跑并带超时。
- 只下载用户明确点名的文件，不做批量抓取。
- 文本进模型前照常过出站审计与敏感词检查；文件正文不会被转发到别处。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `读取文件失败：... 没有返回下载地址` | 群文件过期或 `busid` 缺失；重新 `qq_list_group_files` 拿最新列表 |
| `文件太大（x MB），超过上限 32.0 MB` | 超 `files.maxBytes`；调大配置或让用户换个文件 |
| `未配置可用的 dsoffice CLI` | `files.officeCli` 路径不对；确认 `@deepseek-ai/libreoffice-kit/lib/cli.js` 存在 |
| docx 抽取超时 | 本机 LibreOffice 的「直接导 txt」会卡 120s，所以主路径改成先转 PDF（约 2 秒） |
| `spawn EPERM` | 在 DSH 沙箱会话里直接调子进程被禁；这个能力只能在桥接进程里跑 |
| PDF 只给了图片 | 扫描件没有文本层，属于预期行为 |

## 测试

```bash
node scripts/test-docs.mjs     # 或 npm run test:docs
```

离线跑类型判定 / 文件名消毒 / 编码兜底 / 截断 / 图片 / 压缩包；夹具在
`_tmp/docs`（可用 `QQDOCS_FIXTURES` 指向别处），Docx/xlsx/pdf 需要夹具 + 上面两个工具，
缺了就跳过（⏭）而不是报红。
