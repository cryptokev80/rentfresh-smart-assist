'use strict';

/**
 * WhatsApp message status events (sent / delivered / read / failed).
 *
 * Meta posts these to the same webhook as inbound messages, inside
 * value.statuses[]. Each event references the WhatsApp message id (wamid)
 * returned when we sent the reply. This module normalizes the events and
 * applies them to the store so the inbox can show per-reply delivery state.
 * Failures flag the conversation for Kevin instead of vanishing silently.
 *
 * Pure logic here is dependency-injected (store, logEvent) so it stays
 * unit-testable without booting the server.
 */

const KNOWN = new Set(['sent', 'delivered', 'read', 'failed']);

// A status only moves forward: sent -> delivered -> read. Failure is
// terminal. This keeps out-of-order webhooks from downgrading state.
const RANK = { sent: 1, delivered: 2, read: 3, failed: 4 };

function normalizeStatus(st) {
  if (!st || typeof st !== 'object') return null;
  const waId = st.id;
  const status = st.status;
  if (!waId || !KNOWN.has(status)) return null;
  let error = null;
  if (status === 'failed' && Array.isArray(st.errors) && st.errors.length) {
    error = st.errors
      .map((e) => ((e && e.code ? e.code + ': ' : '') + ((e && (e.title || e.message)) || 'failed')))
      .join('; ');
  }
  const recipient = String(st.recipient_id || '').replace(/\D/g, '') || null;
  return { waId, status, error, recipient };
}

function applyStatus(store, logEvent, norm) {
  if (!norm) return null;
  const found = store.findMessageByWaId(norm.waId);
  if (!found) {
    logEvent({ event: 'message_status', waId: norm.waId, status: norm.status, matched: false, error: norm.error });
    return null;
  }
  const curRank = RANK[found.message.status] || 0;
  if (RANK[norm.status] >= curRank) {
    const patch = { status: norm.status, statusError: norm.error || null };
    store.updateMessage(found.phone, found.index, patch);
  }
  logEvent({ event: 'message_status', waId: norm.waId, status: norm.status, to: found.phone, error: norm.error });
  if (norm.status === 'failed') {
    store.updateConversation(found.phone, { needsHuman: true });
  }
  return found.phone;
}

module.exports = { normalizeStatus, applyStatus, KNOWN };
