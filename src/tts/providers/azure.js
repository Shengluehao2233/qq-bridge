// ── Azure 语音服务 provider（REST /cognitiveservices/v1，SSML）─────────────────
//
// 和 edge-tts 用的是同一批神经音色，但 Azure 版多了：自有音色、SSML 精细控制（停顿/强调/风格）、
// 更高采样率与更稳的 SLA。代价是要订阅 Key + 区域。
//
// 契约见 src/tts/providers/edge.js 顶部注释。
import { postForAudio, resolveKey } from './http-audio.js';

export const meta = {
  id: 'azure',
  label: 'Azure 语音服务（SSML / 可换风格）',
  needsKey: true,
  docUrl: 'https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech',
  defaults: {
    apiKey: '',
    // 订阅所在区域，如 eastasia / eastus / japaneast。空 = 未配置。
    region: '',
    voice: 'zh-CN-XiaoxiaoNeural',
    // 输出格式；改成 audio-48khz-192kbitrate-mono-mp3 可拿更高音质（体积也更大）。
    outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
    // 音色「风格」（如 cheerful/calm/sad），只有带风格列表的音色支持；留空 = 不加 style。
    style: '',
    rate: '+0%',
    pitch: '+0Hz',
    timeoutMs: 60000
  }
};

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

export function status(settings = {}) {
  const sh = { ...meta.defaults, ...settings };
  const key = resolveKey(sh, ['AZURE_SPEECH_KEY', 'AZURE_TTS_KEY']);
  if (!key) return { configured: false, reason: '没有配置 apiKey（tts.providers.azure.apiKey 或环境变量 AZURE_SPEECH_KEY）' };
  if (!String(sh.region || '').trim()) return { configured: false, reason: '缺少 region（订阅所在区域，如 eastasia）' };
  return { configured: true, reason: '' };
}

export async function synthesize({ text, voice, settings = {} } = {}) {
  const sh = { ...meta.defaults, ...settings };
  const key = resolveKey(sh, ['AZURE_SPEECH_KEY', 'AZURE_TTS_KEY']);
  const region = String(sh.region || '').trim();
  const finalVoice = String(voice || sh.voice || meta.defaults.voice);

  const prosodyAttrs = [
    String(sh.rate || '').trim() ? ` rate="${escapeXml(sh.rate)}"` : '',
    String(sh.pitch || '').trim() ? ` pitch="${escapeXml(sh.pitch)}"` : ''
  ].join('');
  const inner = String(sh.style || '').trim()
    ? `<mstts:express-as style="${escapeXml(sh.style)}">${escapeXml(text)}</mstts:express-as>`
    : escapeXml(text);
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN">`
    + `<voice name="${escapeXml(finalVoice)}"><prosody${prosodyAttrs}>${inner}</prosody></voice></speak>`;

  const { buffer, contentType } = await postForAudio(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': String(sh.outputFormat || meta.defaults.outputFormat),
      'User-Agent': 'qq-bridge-tts'
    },
    body: ssml,
    timeoutMs: sh.timeoutMs,
    label: 'Azure TTS',
    raw: true
  });
  return { buffer, ext: '.mp3', mime: contentType || 'audio/mpeg', voice: finalVoice, extra: { engine: 'azure' } };
}
