'use strict';

/**
 * NEEDS YOU email alerts: Kevin's escalation channel.
 *
 * Sent via Resend (https://resend.com) with a single API key. If
 * RESEND_API_KEY is not set, alerts are skipped with a warning and the bot
 * keeps running: a missing alert channel must never break message handling.
 *
 * Without a verified sending domain, Resend only delivers to the account
 * owner's address, which is exactly where these alerts go (ALERT_EMAIL).
 *
 * Pure helpers (buildAlert, flagNeedsHuman) are unit-testable; only
 * sendEmail touches the network.
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'rentfreshteam@gmail.com';
const ALERT_FROM = process.env.ALERT_FROM || 'RentFresh Alerts <onboarding@resend.dev>';
const INBOX_URL =
  process.env.INBOX_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '');

function shortTime(iso) {
  return typeof iso === 'string' && iso.length >= 16 ? iso.slice(11, 16) : '';
}

function recentTranscript(messages, n) {
  return (messages || [])
    .slice(-(n || 8))
    .map((m) => {
      const who = m.direction === 'in' ? 'Them' : 'Bot';
      const t = shortTime(m.at);
      const body = m.type === 'image' ? '[photo] ' + (m.body || '') : m.body || '';
      return (t ? '[' + t + '] ' : '') + who + ': ' + body;
    })
    .join('\n');
}

function buildAlert({ phone, name, reason, messages }) {
  const subject = 'NEEDS YOU: ' + reason + ' (' + phone + ')';
  const lines = [
    'RentFresh Smart Assist needs you.',
    '',
    'Reason: ' + reason,
    'From: ' + (name || 'Unknown') + ' (' + phone + ')',
  ];
  if (INBOX_URL) lines.push('Inbox: ' + INBOX_URL);
  lines.push('', 'Recent messages:', recentTranscript(messages, 8) || '(none)');
  return { to: ALERT_EMAIL, from: ALERT_FROM, subject, text: lines.join('\n') };
}

// Flag the conversation for Kevin. Returns true only on the false -> true
// transition, so one escalation produces one alert, not one per message.
// The stored reason always matches the escalation that was alerted.
function flagNeedsHuman(store, phone, reason) {
  const convo = store.getConversation(phone);
  if (convo.needsHuman) return false;
  store.updateConversation(phone, {
    needsHuman: true,
    needsHumanReason: reason || 'manual',
    needsHumanAt: new Date().toISOString(),
  });
  return true;
}

async function sendEmail({ to, from, subject, text }) {
  if (!RESEND_API_KEY) return { sent: false, reason: 'missing RESEND_API_KEY' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('Resend ' + res.status + ': ' + body.slice(0, 200));
  }
  return { sent: true };
}

async function sendNeedsHumanAlert(store, phone, reason) {
  const convo = store.getConversation(phone);
  return sendEmail(buildAlert({ phone, name: convo.name, reason, messages: convo.messages }));
}

module.exports = {
  buildAlert,
  flagNeedsHuman,
  sendEmail,
  sendNeedsHumanAlert,
  recentTranscript,
  ALERT_EMAIL,
};
