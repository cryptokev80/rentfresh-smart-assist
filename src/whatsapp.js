'use strict';

/**
 * WhatsApp Cloud API client.
 * Set DRY_RUN=true to log outgoing messages instead of sending them.
 */

const GRAPH_VERSION = 'v26.0';
const GRAPH = 'https://graph.facebook.com/' + GRAPH_VERSION;

function dryRun() {
  return String(process.env.DRY_RUN || '').toLowerCase() === 'true';
}

function creds() {
  return {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    token: process.env.WHATSAPP_ACCESS_TOKEN,
  };
}

async function sendText(to, text) {
  if (dryRun()) {
    console.log('[DRY_RUN] -> ' + to + ':\n' + text + '\n');
    return { dryRun: true };
  }
  const { phoneNumberId, token } = creds();
  if (!phoneNumberId || !token) throw new Error('Missing WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN');
  const res = await fetch(GRAPH + '/' + phoneNumberId + '/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text, preview_url: false },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('WhatsApp send failed: ' + JSON.stringify(data));
  return data;
}

/**
 * Download media (photo or video) sent by a user. Returns a Buffer or null.
 * In DRY_RUN a tiny fake buffer is returned so the media relay path can be
 * exercised end to end without touching the network.
 */
async function downloadMedia(mediaId) {
  if (!mediaId) return null;
  if (dryRun()) return Buffer.from('dryrun-media');
  const { token } = creds();
  if (!token) return null;
  try {
    const metaRes = await fetch(GRAPH + '/' + mediaId, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!metaRes.ok) return null;
    const meta = await metaRes.json();
    if (!meta.url) return null;
    const fileRes = await fetch(meta.url, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!fileRes.ok) return null;
    const buf = Buffer.from(await fileRes.arrayBuffer());
    return buf.length ? buf : null;
  } catch (err) {
    console.error('media download failed:', err.message);
    return null;
  }
}

/**
 * Upload a media buffer to the WhatsApp Cloud API so it can be sent as an
 * image or video message. Returns the upload response ({ id }) or throws.
 * Used by the trade<->tenant relay to forward photos and videos.
 */
async function uploadMedia(buffer, mimeType) {
  if (dryRun()) {
    console.log('[DRY_RUN] upload media (' + (mimeType || 'unknown') + '), ' + (buffer ? buffer.length : 0) + ' bytes');
    return { dryRun: true, id: 'dryrun-media-id' };
  }
  const { phoneNumberId, token } = creds();
  if (!phoneNumberId || !token) throw new Error('Missing WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN');
  if (!buffer || !buffer.length) throw new Error('Nothing to upload: empty media buffer');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), 'media');
  form.append('type', mimeType || 'application/octet-stream');
  form.append('messaging_product', 'whatsapp');
  const res = await fetch(GRAPH + '/' + phoneNumberId + '/media', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('WhatsApp media upload failed: ' + JSON.stringify(data));
  return data;
}

async function sendMediaMessage(to, kind, mediaId, caption) {
  if (dryRun()) {
    console.log('[DRY_RUN] -> ' + to + ' [' + kind + ' id=' + mediaId + ']:\n' + (caption || '') + '\n');
    return { dryRun: true };
  }
  const { phoneNumberId, token } = creds();
  if (!phoneNumberId || !token) throw new Error('Missing WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN');
  const mediaObj = { id: mediaId };
  if (caption) mediaObj.caption = caption;
  const res = await fetch(GRAPH + '/' + phoneNumberId + '/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: kind,
      [kind]: mediaObj,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('WhatsApp send failed: ' + JSON.stringify(data));
  return data;
}

/** Send a photo by uploaded media id, with an optional caption. */
async function sendImage(to, mediaId, caption) {
  return sendMediaMessage(to, 'image', mediaId, caption);
}

/** Send a video by uploaded media id, with an optional caption. */
async function sendVideo(to, mediaId, caption) {
  return sendMediaMessage(to, 'video', mediaId, caption);
}

module.exports = { sendText, sendImage, sendVideo, uploadMedia, downloadMedia, dryRun };
