/** Only explicit input-format rejection is evidence. Do not persist upstream bodies. */
export function classifyMediaRejection(status, text, formats) {
  if (![400, 415, 422].includes(status)) return null;
  const message = String(text || '').toLowerCase();
  if (/size|too large|duration|length|corrupt|decode|invalid.*(?:base64|url)|quota|billing/.test(message)) return null;
  const unsupported = /not support|unsupported|not allowed|does not accept|only supports/.test(message);
  if (!unsupported) return null;
  const matched = formats.filter(mime => message.includes(mime) ||
    (mime.startsWith('audio/') && /audio|input_audio/.test(message)) ||
    (mime.startsWith('video/') && /video|video_url/.test(message)) ||
    (mime.startsWith('image/') && /image|vision/.test(message)));
  return matched.length === 1 ? matched[0] : null;
}

export function requestMediaFormats(init) {
  try {
    const body = JSON.parse(init.body);
    const formats = new Set();
    for (const message of body.messages || []) for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part.type === 'input_audio') formats.add(part.input_audio?.format === 'wav' ? 'audio/wav' : 'audio/mpeg');
      if (part.type === 'video_url' || part.type === 'image_url') {
        const url = (part.video_url || part.image_url)?.url || '';
        const mime = /^data:([^;,]+)/.exec(url)?.[1];
        if (mime) formats.add(mime);
      }
    }
    return [...formats];
  } catch { return []; }
}
