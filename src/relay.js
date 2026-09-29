'use strict';

/**
 * Trade <-> tenant message relay.
 *
 * After a ticket is dispatched, the assigned trade and the tenant can
 * dialogue through the bot, each staying in their own WhatsApp chat with
 * the ProQue number. Text, photos, and videos forward both ways.
 *
 * Routing decisions:
 *   trade -> tenant : triage.tradeReplyTarget(text) === 'tenant'
 *                     (questions / detail requests for the tenant).
 *                     Anything else stays on today's Kevin flow.
 *   tenant -> trade : the message reads as a follow-up on the dispatched
 *                     ticket (triage.isFollowupOnTicket). Emergencies and
 *                     genuinely new issues are handled before this is ever
 *                     consulted, so they keep today's behavior.
 *
 * Loop safety: forwarded copies are logged with direction 'out', so they
 * can never re-enter the inbound handler. Every forwarded copy also
 * carries an explicit relay tag ({ ticket, from, at }) in the store, and
 * relayRecipient() refuses to forward a message back to its own sender.
 * The relay is live only while the ticket is dispatched to that pro;
 * closing the ticket ends it.
 */

const triage = require('./triage');

function digits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

// The relay is live only while the ticket is dispatched to this pro.
function isRelayActive(ticket, proPhone) {
  if (!ticket || !proPhone) return false;
  if (ticket.status !== 'dispatched') return false;
  if (!ticket.dispatch || ticket.dispatch.status !== 'dispatched') return false;
  const linked = digits(ticket.assignedProPhone);
  return !!linked && linked === digits(proPhone);
}

// "Joe (JSL Plumbing)" — falls back to the first name when no company.
function proLabel(pro) {
  const first = String((pro && pro.name) || '').split(' ')[0] || 'Pro';
  return pro && pro.company ? first + ' (' + pro.company + ')' : first;
}

function tenantLabel(ticket) {
  return 'Tenant (' + ticket.id + ')';
}

// Explicit marker stored on every forwarded message in the store.
function relayTag(fromRole, ticket) {
  return { ticket: ticket.id, from: fromRole, at: new Date().toISOString() };
}

function isRelayedMessage(msg) {
  return !!(msg && msg.relay && msg.relay.ticket);
}

// Trade -> tenant? (trade -> Kevin is today's default)
function tradeTargetsTenant(text) {
  return triage.tradeReplyTarget(text) === 'tenant';
}

// Tenant -> trade? During an active relay the tenant is mid-conversation
// with the pro, so plain answers ("it's the hot water side") relay too.
// Only a genuinely new issue (a different trade) stays out; emergencies
// never reach here (handleText step 1) but are excluded anyway.
function tenantTargetsTrade(text, relayTicket) {
  if (!relayTicket) return false;
  const cls = triage.classify(String(text || ''));
  if (cls.emergency) return false;
  return cls.trade === 'general' || cls.trade === relayTicket.trade;
}

// Prefix a relayed text so each side knows who is talking.
function buildRelayText(fromRole, ticket, pro, text) {
  const label = fromRole === 'pro' ? proLabel(pro) : tenantLabel(ticket);
  return label + ': ' + String(text || '').trim();
}

// Caption for a relayed photo/video. The caption is the whole message, so
// it carries the speaker prefix too.
function buildRelayCaption(fromRole, ticket, pro, kind, caption) {
  const label = fromRole === 'pro' ? proLabel(pro) : tenantLabel(ticket);
  const cap = String(caption || '').trim();
  if (cap) return label + ': ' + cap;
  return label + ' sent a ' + (kind === 'video' ? 'video' : 'photo') + '.';
}

// Resolve the forward destination. Returns null when there is no safe
// recipient (missing number, or the number is the sender's own).
function relayRecipient(fromRole, ticket, pro) {
  const to = fromRole === 'pro' ? ticket.phone : pro && pro.phone;
  const fromPhone = fromRole === 'pro' ? pro && pro.phone : ticket.phone;
  if (!to || digits(to) === digits(fromPhone)) return null;
  return to;
}

// Short confirmation the sender gets when their message was forwarded.
function relayAck(fromRole, pro) {
  return fromRole === 'pro' ? 'Sent to the tenant.' : 'Sent to ' + proLabel(pro).split(' ')[0] + '.';
}

// Honest failure note when a forward did not go through. Kevin is flagged
// separately by the send path, so this only tells the sender.
function relayFailureNotice(kind) {
  const what = kind === 'video' ? 'that video' : kind === 'image' ? 'that photo' : 'that';
  return 'I could not pass ' + what + ' along just now. Kevin has been notified and will follow up.';
}

module.exports = {
  digits,
  isRelayActive,
  proLabel,
  tenantLabel,
  relayTag,
  isRelayedMessage,
  tradeTargetsTenant,
  tenantTargetsTrade,
  buildRelayText,
  buildRelayCaption,
  relayRecipient,
  relayAck,
  relayFailureNotice,
};
