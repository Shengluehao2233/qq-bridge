// 文档抽取：把群友/群文件里的文档变成模型能读的东西。
//
// 为什么要单独一层：QQ 侧的会话主体是**仿真会话**，按铁律 L7 不拥有本地执行能力
// （qq-tool-restrict 把 read/write/bash/pwsh/skill 等工具从清单里隐藏了）。所以不能
// 让它自己跑 python-docx 或 pdftotext，只能由桥接进程（普通 Node 进程）把文件读成
// 文本/图片，再通过 MCP 工具的结果交回去。
//
// 复用现成引擎而不是自己造轮子：
//   - Office 系（doc/docx/odt、xls/xlsx/ods、ppt/pptx/odp）走已安装的
//     @deepseek-ai/libreoffice-kit 的 dsoffice CLI（就是 office 技能用的那个引擎）；
//   - PDF 文本走 pdftotext（本机 TeX Live 自带）；抽不出文字（扫描件）就转成 PNG 交给视觉模型；
//   - 纯文本类（txt/md/json/csv…）直接解码。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.yaml', '.yml',
  '.xml', '.html', '.htm', '.ini', '.conf', '.cfg', '.toml', '.sql', '.srt', '.lrc',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.ps1', '.bat', '.cmd', '.sh',
  '.java', '.c', '.h', '.cpp', '.hpp', '.go', '.rs', '.rb', '.php', '.css'
])
export const OFFICE_TEXT = new Set(['.doc', '.docx', '.odt', '.rtf'])
export const OFFICE_SHEET = new Set(['.xls', '.xlsx', '.ods'])
export const OFFICE_SLIDE = new Set(['.ppt', '.pptx', '.odp'])
export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
export const ARCHIVE_EXTS = new Set(['.zip', '.7z', '.rar', '.tar', '.gz', '.tgz'])

/** 按文件名后缀判断文档类型（不看 MIME——QQ 文件的 mime 经常缺失或乱写）。 */
export function docKindOf(name) {
  const ext = path.extname(String(name ?? '')).toLowerCase()
  if (TEXT_EXTS.has(ext)) return 'text'
  if (OFFICE_TEXT.has(ext)) return 'docx'
  if (OFFICE_SHEET.has(ext)) return 'sheet'
  if (OFFICE_SLIDE.has(ext)) return 'slide'
  if (ext === '.pdf') return 'pdf'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (ARCHIVE_EXTS.has(ext)) return 'archive'
  return 'binary'
}

/** 文件名消毒：QQ 传来的名字可能带路径/控制字符/超长，落盘前必须处理。 */
export function sanitizeFileName(name, fallback = 'file') {
  let base = String(name ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
  // 控制字符 + Windows 非法字符（:<">|?*）一并去掉，避免落盘时抛 EINVAL
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>:"|?*]/g, '_').trim()
  // Windows 不允许结尾是点或空格
  base = base.replace(/[. ]+$/, '')
  if (!base || base === '.' || base === '..') base = fallback
  if (base.length > 120) {
    const ext = path.extname(base).slice(0, 20)
    base = base.slice(0, 120 - ext.length) + ext
  }
  return base
}

export function formatBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / 1024 / 1024).toFixed(1)} MB`
}

/** 文本解码：UTF-8（含 BOM）优先，解不出来再按 GB18030 兜底（中文环境的老文件）。 */
export function decodeText(buffer) {
  if (!buffer?.length) return ''
  let b = buffer
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3)
  const utf8 = b.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gb18030', { fatal: false }).decode(b)
  } catch {
    return utf8
  }
}

/** 把一段文本截断到 maxChars，并给出是否截断。 */
export function truncateText(text, maxChars) {
  const s = String(text ?? '')
  const max = Number(maxChars) > 0 ? Number(maxChars) : 0
  if (!max || s.length <= max) return { text: s, truncated: false }
  return { text: s.slice(0, max), truncated: true }
}

function runProcess(cmd, args, { timeoutMs = 60000, maxOutputBytes = 8 * 1024 * 1024, cwd } = {}) {
  return new Promise((resolve, reject) => {
    // 沙箱（含 DSH 的 workspace-write 模式）禁掉了命名管道，stdio: 'pipe' 会直接 EPERM。
    // 所以把子进程的 stdout/stderr 都写到临时文件，用文件描述符继承——桥接进程里一样能用。
    let logPath = ''
    let logFd = null
    try {
      logPath = path.join(os.tmpdir(), `qqdoc-run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`)
      logFd = fs.openSync(logPath, 'w')
    } catch {
      logPath = ''
      logFd = null
    }
    const stdio = logFd === null ? ['ignore', 'ignore', 'ignore'] : ['ignore', logFd, logFd]
    let child
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, stdio })
    } catch (error) {
      if (logFd !== null) { try { fs.closeSync(logFd) } catch {} ; try { fs.rmSync(logPath, { force: true }) } catch {} }
      reject(error)
      return
    }
    if (logFd !== null) { try { fs.closeSync(logFd) } catch {} }
    const readLog = () => {
      try { return fs.readFileSync(logPath, 'utf8').slice(0, Math.max(maxOutputBytes, 0)) } catch { return '' }
    }
    const cleanUp = () => { if (logPath) { try { fs.rmSync(logPath, { force: true }) } catch {} } }
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      try { child.kill('SIGKILL') } catch {}
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      cleanUp()
      const hint = error?.code === 'EPERM' ? '（沙箱禁用了子进程管道：这个操作要在桥接进程里跑，不是 DSH 会话里）' : ''
      reject(new Error(`${path.basename(cmd)} 启动失败：${error?.message ?? error}${hint}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const output = readLog()
      cleanUp()
      const tail = output.trim().slice(-500)
      if (killed) { reject(new Error(`${path.basename(cmd)} 超时（${Math.round(timeoutMs / 1000)}s）${tail ? `：${tail}` : ''}`)); return }
      if (code !== 0) { reject(new Error(`${path.basename(cmd)} 退出码 ${code}${tail ? `：${tail.slice(0, 300)}` : ''}`)); return }
      resolve({ stdout: output, stderr: '' })
    })
  })
}

async function fileSize(p) {
  try { return (await fsp.stat(p)).size } catch { return 0 }
}

function resolveDsoffice(cliPath) {
  // dsoffice 是个 JS CLI，必须用 node 跑
  if (!cliPath || !fs.existsSync(cliPath)) return null
  return { cmd: process.execPath, args: [cliPath] }
}

/** 用 LibreOffice Kit 把 Office 文档转成 txt / csv。失败抛错，由调用方降级。 */
export async function dsofficeConvert({ cliPath, inputPath, outputExt, timeoutMs = 90000 }) {
  const tool = resolveDsoffice(cliPath)
  if (!tool) throw new Error('未配置可用的 dsoffice CLI（config.json 的 files.officeCli）')
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qqdoc-'))
  const outputPath = path.join(outDir, `${path.parse(inputPath).name}.${outputExt}`)
  try {
    await runProcess(tool.cmd, [...tool.args, 'convert', '--input', inputPath, '--output', outputPath], {
      timeoutMs,
      maxOutputBytes: 1024 * 1024
    })
    if (!fs.existsSync(outputPath)) throw new Error('转换没有产出文件')
    return decodeText(await fsp.readFile(outputPath))
  } finally {
    await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 用 LibreOffice Kit 把文档/PDF/幻灯片渲染成若干页 PNG（交给视觉模型）。 */
export async function dsofficeRender({ cliPath, inputPath, outDir, pages = null, timeoutMs = 120000 }) {
  const tool = resolveDsoffice(cliPath)
  if (!tool) throw new Error('未配置可用的 dsoffice CLI（config.json 的 files.officeCli）')
  await fsp.mkdir(outDir, { recursive: true })
  const args = [...tool.args, 'render', '--input', inputPath, '--output-dir', outDir]
  if (pages && Number(pages) > 0) args.push('--pages', String(pages))
  await runProcess(tool.cmd, args, { timeoutMs, maxOutputBytes: 1024 * 1024 })
  return (await fsp.readdir(outDir))
    .filter((f) => /\.png$/i.test(f))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((f) => path.join(outDir, f))
}

/** pdftotext（TeX Live / poppler 都行）抽 PDF 文本层。 */
export async function pdfToText({ pdftotextPath, inputPath, timeoutMs = 60000 }) {
  const bin = pdftotextPath || 'pdftotext'
  if (pdftotextPath && !fs.existsSync(pdftotextPath)) throw new Error(`pdftotext 不存在：${pdftotextPath}`)
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qqpdf-'))
  const outPath = path.join(dir, 'out.txt')
  try {
    await runProcess(bin, ['-layout', '-enc', 'UTF-8', inputPath, outPath], { timeoutMs, maxOutputBytes: 1024 * 1024 })
    return decodeText(await fsp.readFile(outPath))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Office 文档 → PDF → 文本（本机最稳的一条路）。抽不出文字时返回 null，由调用方渲染成图片。 */
async function officeToText({ officeCli, pdfToTextPath, inputPath, timeoutMs }) {
  if (!officeCli || !fs.existsSync(officeCli)) {
    throw new Error('未配置可用的 dsoffice CLI（config.json 的 files.officeCli）')
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qqdocpdf-'))
  const pdfPath = path.join(dir, `${path.parse(inputPath).name}.pdf`)
  try {
    await runProcess(process.execPath, [officeCli, 'convert', '--input', inputPath, '--output', pdfPath], { timeoutMs })
    if (!fs.existsSync(pdfPath)) return null
    let text = ''
    try {
      text = await pdfToText({ pdftotextPath: pdfToTextPath, inputPath: pdfPath, timeoutMs })
    } catch {
      return null
    }
    if (text.replace(/\s+/g, '').length < 10) return null
    return { text, note: '转成 PDF 后抽取的文本层' }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function readImageAsModelMedia(filePath) {
  const buf = fs.readFileSync(filePath)
  const ext = path.extname(filePath).toLowerCase()
  const mimeType = ext === '.png' ? 'image/png'
    : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.webp' ? 'image/webp'
        : ext === '.gif' ? 'image/gif'
          : ext === '.bmp' ? 'image/bmp'
            : 'application/octet-stream'
  return { mimeType, data: buf.toString('base64'), bytes: buf.length }
}

/**
 * 抽取一个文档。
 *
 * @returns {Promise<{kind:string,bytes:number,text?:string,truncated?:boolean,images?:Array,note?:string}>}
 *   text 与 images 二选一，或都为空（binary/archive 只给元信息）。
 */
export async function extractDocument({ filePath, fileName, limits = {} }) {
  const kind = docKindOf(fileName)
  const maxTextChars = Number(limits.maxTextChars) > 0 ? Number(limits.maxTextChars) : 20000
  const maxImages = Number(limits.maxImages) > 0 ? Number(limits.maxImages) : 4
  const officeCli = limits.officeCli || ''
  const pdftotextPath = limits.pdftotext || ''
  const timeoutMs = Number(limits.timeoutMs) > 0 ? Number(limits.timeoutMs) : 90000
  const bytes = await fileSize(filePath)
  const base = { kind, bytes }

  if (kind === 'text') {
    const buf = await fsp.readFile(filePath)
    const slice = buf.subarray(0, Math.min(buf.length, 4 * 1024 * 1024))
    const decoded = truncateText(decodeText(slice), maxTextChars)
    return {
      ...base,
      text: decoded.text,
      truncated: decoded.truncated,
      note: buf.length > 4 * 1024 * 1024 ? '文件较大，只读取了前 4MB' : undefined
    }
  }

  if (kind === 'docx') {
    // 本机实测：LibreOffice 的「直接导 txt」会卡在内部 120s 超时（Text 导出对话框），
    // 但 docx→pdf 只要 2 秒。所以主路径一律走 pdf → pdftotext，抽不出文本层再渲染成图片。
    const converted = await officeToText({ officeCli, pdfToTextPath: pdftotextPath, inputPath: filePath, timeoutMs })
    if (converted?.text && converted.text.replace(/\s+/g, '').length >= 10) {
      const t = truncateText(converted.text, maxTextChars)
      return { ...base, text: t.text, truncated: t.truncated, note: converted.note }
    }
    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qqdocimg-'))
    try {
      const pages = await dsofficeRender({ cliPath: officeCli, inputPath: filePath, outDir, pages: maxImages, timeoutMs })
      const images = pages.slice(0, maxImages).map(readImageAsModelMedia)
      if (images.length) {
        return { ...base, images, note: '文档没有可抽取的文字层，已渲染成页面图片' }
      }
    } catch {
      // 渲染也失败就退化成纯 txt 导出（有些环境恰好相反）
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {})
    }
    const text = await dsofficeConvert({ cliPath: officeCli, inputPath: filePath, outputExt: 'txt', timeoutMs })
    const t = truncateText(text, maxTextChars)
    return { ...base, text: t.text, truncated: t.truncated }
  }

  if (kind === 'sheet') {
    // 表格优先走 CSV（保留结构与列）；不行再走 pdf → pdftotext。
    try {
      const text = await dsofficeConvert({ cliPath: officeCli, inputPath: filePath, outputExt: 'csv', timeoutMs })
      const t = truncateText(text, maxTextChars)
      return {
        ...base,
        text: t.text,
        truncated: t.truncated,
        note: '表格按 CSV 抽取（只有第一张工作表；要看别的表请让用户截图）'
      }
    } catch (error) {
      const converted = await officeToText({ officeCli, pdfToTextPath: pdftotextPath, inputPath: filePath, timeoutMs })
      if (!converted?.text) throw error
      const t = truncateText(converted.text, maxTextChars)
      return {
        ...base,
        text: t.text,
        truncated: t.truncated,
        note: '表格转 CSV 失败，已按 PDF 文本抽取（排版可能比较乱）'
      }
    }
  }

  if (kind === 'pdf') {
    let text = ''
    try {
      text = await pdfToText({ pdftotextPath, inputPath: filePath, timeoutMs })
    } catch {
      text = ''
    }
    if (text.replace(/\s+/g, '').length >= 20) {
      const t = truncateText(text, maxTextChars)
      return { ...base, text: t.text, truncated: t.truncated, note: 'PDF 文本层抽取' }
    }
    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qqpdfimg-'))
    try {
      const pages = await dsofficeRender({ cliPath: officeCli, inputPath: filePath, outDir, pages: maxImages, timeoutMs })
      const images = pages.slice(0, maxImages).map(readImageAsModelMedia)
      return {
        ...base,
        images,
        note: pages.length ? '这份 PDF 没有可用文本层（多半是扫描件），已转成页面图片' : 'PDF 里没有可读内容'
      }
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  if (kind === 'slide') {
    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qqslide-'))
    try {
      const pages = await dsofficeRender({ cliPath: officeCli, inputPath: filePath, outDir, pages: maxImages, timeoutMs })
      const images = pages.slice(0, maxImages).map(readImageAsModelMedia)
      return {
        ...base,
        images,
        note: pages.length ? `幻灯片已渲染为 ${Math.min(pages.length, maxImages)} 页图片` : '幻灯片没有可渲染的页面'
      }
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  if (kind === 'image') {
    return { ...base, images: [readImageAsModelMedia(filePath)], note: '图片已直接附上' }
  }

  if (kind === 'archive') {
    return { ...base, note: '压缩包不自动解压（安全考虑），只能告诉用户收到了哪个压缩包' }
  }

  return { ...base, note: '这个格式暂不支持抽取内容（只能给出文件名和大小）' }
}
