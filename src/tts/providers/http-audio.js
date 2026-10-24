// 云 TTS 的公共部分：POST 一段 JSON，拿回音频字节。
//
// 三个云 provider（openai / azure / siliconflow）的错误形状不一样，但都要满足同一件事：
// **失败时说人话，且绝不把 API Key 回显出去**。所以这里只做「发请求 → 判状态 → 取字节」，
// 错误解析统一抓 JSON 里的 message/error 字段，截断到 300 字，避免把整页 HTML 糊到终端。

/**
 * @param {string} url
 * @param {object} opts
 *   headers    附加请求头
 *   body       请求体（字符串）
 *   timeoutMs  超时
 *   label      出错信息里的名字，如 "OpenAI TTS"
 *   raw        true = 不自动加 content-type: application/json
 */
export async function postForAudio(url, { headers = {}, body, timeoutMs = 60000, label = 'TTS', raw = false } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: raw ? headers : { 'content-type': 'application/json', ...headers },
      body,
      signal: AbortSignal.timeout(Math.max(5000, Number(timeoutMs) || 60000))
    });
  } catch (error) {
    const msg = String(error?.message ?? error);
    if (/abort|timeout/i.test(msg)) throw new Error(`${label} 请求超时（${Math.round(timeoutMs / 1000)}s）`);
    if (/ENOTFOUND|EAI_AGAIN|fetch failed/i.test(msg)) throw new Error(`${label} 连不上服务端（网络或 baseUrl 配置问题）：${msg}`);
    throw new Error(`${label} 请求失败：${msg}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message ?? j?.message ?? j?.error ?? j?.detail ?? text;
    } catch {}
    const hint = res.status === 401 || res.status === 403
      ? '（Key 无效、过期或没有该模型的权限）'
      : res.status === 429 ? '（触发限流或余额不足）' : '';
    throw new Error(`${label} 返回 HTTP ${res.status}${hint}：${String(detail || '无响应内容').slice(0, 300)}`);
  }

  const contentType = String(res.headers.get('content-type') || '');
  if (/json|text\/html/i.test(contentType)) {
    const text = await res.text().catch(() => '');
    throw new Error(`${label} 返回了非音频内容（${contentType}）：${String(text).slice(0, 200)}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error(`${label} 返回了 0 字节音频`);
  return { buffer, contentType };
}

/** Key 解析顺序：provider 配置 → 环境变量。空字符串一律当成「没配」。 */
export function resolveKey(settings = {}, envNames = []) {
  const direct = String(settings.apiKey ?? '').trim();
  if (direct) return direct;
  for (const name of envNames) {
    const v = String(process.env[name] ?? '').trim();
    if (v) return v;
  }
  return '';
}
