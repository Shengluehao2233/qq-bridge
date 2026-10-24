// ── 硅基流动 provider（OpenAI 兼容的 /v1/audio/speech，跑 CosyVoice2）─────────
//
// 接的是 FunAudioLLM/CosyVoice2 —— 中文自然度高，还能用 `voice` 里的参考音频做音色克隆
// （形如 `FunAudioLLM/CosyVoice2-0.5B:<自定义音色名>`，先在控制台建好音色再填名字）。
//
// 契约见 src/tts/providers/edge.js 顶部注释。
import { postForAudio, resolveKey } from './http-audio.js';

export const meta = {
  id: 'siliconflow',
  label: '硅基流动 CosyVoice2（中文 / 可克隆）',
  needsKey: true,
  docUrl: 'https://docs.siliconflow.cn/cn/api-reference/audio/create-speech',
  defaults: {
    apiKey: '',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/CosyVoice2-0.5B',
    // 官方预置音色：alex / anna / bella / benjamin / charles / claire / david / diana …
    voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
    format: 'mp3',
    speed: 1,
    timeoutMs: 60000
  }
};

export function status(settings = {}) {
  const sh = { ...meta.defaults, ...settings };
  const key = resolveKey(sh, ['SILICONFLOW_API_KEY']);
  if (!key) return { configured: false, reason: '没有配置 apiKey（tts.providers.siliconflow.apiKey 或环境变量 SILICONFLOW_API_KEY）' };
  if (!/^https?:\/\//i.test(String(sh.baseUrl || ''))) return { configured: false, reason: `baseUrl 不是合法地址：${sh.baseUrl}` };
  return { configured: true, reason: '' };
}

export async function synthesize({ text, voice, settings = {} } = {}) {
  const sh = { ...meta.defaults, ...settings };
  const key = resolveKey(sh, ['SILICONFLOW_API_KEY']);
  const base = String(sh.baseUrl || meta.defaults.baseUrl).replace(/\/+$/, '');
  const finalVoice = String(voice || sh.voice || meta.defaults.voice);
  const speed = Number(sh.speed);
  const payload = {
    model: String(sh.model || meta.defaults.model),
    input: String(text),
    voice: finalVoice,
    response_format: String(sh.format || 'mp3')
  };
  if (Number.isFinite(speed) && speed > 0) payload.speed = speed;

  const { buffer, contentType } = await postForAudio(`${base}/audio/speech`, {
    headers: { authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
    timeoutMs: sh.timeoutMs,
    label: '硅基流动 TTS'
  });
  return { buffer, ext: '.mp3', mime: contentType || 'audio/mpeg', voice: finalVoice, extra: { engine: String(sh.model || '') } };
}
