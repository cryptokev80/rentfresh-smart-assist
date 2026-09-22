'use strict';

/**
 * WhatsApp Cloud API client.
 * Set DRY_RUN=true to log outgoing messages instead of sending them.
 */

const GRAPH_VERSION = 'v21.0';
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
 * Download media (photo) sent by a tenant. Returns a Buffer or null.
 */
async function downloadMedia(mediaId) {
  if (dryRun() || !mediaId) return null;
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

module.exports = { sendText, downloadMedia, dryRun };
