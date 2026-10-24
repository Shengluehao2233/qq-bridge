// ── OpenAI TTS provider（语音端点 /v1/audio/speech）──────────────────────────
//
// 模型 `gpt-4o-mini-tts` 支持 `instructions`（用自然语言描述语气，比如「像在跟朋友随口聊天」），
// 这是它和 edge-tts 最大的区别；`tts-1` / `tts-1-hd` 也仍可用，只是不能带 instructions。
//
// 契约见 src/tts/providers/edge.js 顶部注释。
import { postForAudio, resolveKey } from './http-audio.js';

export const meta = {
  id: 'openai',
  label: 'OpenAI TTS（gpt-4o-mini-tts）',
  needsKey: true,
  docUrl: 'https://platform.openai.com/docs/guides/text-to-speech',
  defaults: {
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-tts',
    voice: 'alloy',
    format: 'mp3',
    // 只有 gpt-4o-mini-tts 认这个字段；留空就不发。
    instructions: '',
    timeoutMs: 60000
  }
};

export function status(settings = {}) {
  const sh = { ...meta.defaults, ...settings };
  const key = resolveKey(sh, ['OPENAI_API_KEY']);
  if (!key) return { configured: false, reason: '没有配置 apiKey（tts.providers.openai.apiKey 或环境变量 OPENAI_API_KEY）' };
  if (!/^https?:\/\//i.test(String(sh.baseUrl || ''))) return { configured: false, reason: `baseUrl 不是合法地址：${sh.baseUrl}` };
  return { configured: true, reason: '' };
}

export async function synthesize({ text, voice, settings = {} } = {}) {
  const sh = { ...meta.defaults, ...settings };
  const key = resolveKey(sh, ['OPENAI_API_KEY']);
  const base = String(sh.baseUrl || meta.defaults.baseUrl).replace(/\/+$/, '');
  const finalVoice = String(voice || sh.voice || meta.defaults.voice);
  const payload = {
    model: String(sh.model || meta.defaults.model),
    input: String(text),
    voice: finalVoice,
    response_format: String(sh.format || 'mp3')
  };
  if (String(sh.instructions || '').trim()) payload.instructions = String(sh.instructions).trim();

  const { buffer, contentType } = await postForAudio(`${base}/audio/speech`, {
    headers: { authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
    timeoutMs: sh.timeoutMs,
    label: 'OpenAI TTS'
  });
  const ext = String(sh.format || 'mp3').toLowerCase() === 'wav' ? '.wav' : '.mp3';
  return { buffer, ext, mime: contentType || 'audio/mpeg', voice: finalVoice, extra: { engine: String(sh.model || '') } };
}
