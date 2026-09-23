'use strict';

/**
 * RentFresh Smart Assist — business policies.
 * Set with Kevin 2026-09-23. These drive bot behavior; change them here,
 * not scattered through the handlers.
 *
 * - Business hours: Mon-Fri 9am-6pm America/Toronto. Closed weekends.
 * - After hours: the bot still answers and collects details, tells the sender
 *   when the team replies next, and still escalates true emergencies at once.
 * - Spending: default auto-approve $300 per landlord (adjustable per landlord).
 * - Emergencies: alert Kevin first, then start the dispatch flow, which
 *   prioritizes a plumber (most emergencies are plumbing).
 */

const BUSINESS_TZ = 'America/Toronto';
const OPEN_MIN = 9 * 60; // 9:00am
const CLOSE_MIN = 18 * 60; // 6:00pm

const AUTO_APPROVE_DEFAULT = 300;

function torontoParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** 'YYYY-MM-DD' in Toronto time: used to note after-hours once per day. */
function torontoDayKey(date) {
  const p = torontoParts(date || new Date());
  return p.year + '-' + p.month + '-' + p.day;
}

function isBusinessHours(date) {
  const p = torontoParts(date || new Date());
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const mins = parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10);
  return mins >= OPEN_MIN && mins < CLOSE_MIN;
}

/** Human phrasing for when the team replies next, e.g. "tomorrow at 9am". */
function nextReplyText(date) {
  const p = torontoParts(date || new Date());
  const mins = parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10);
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return 'Monday at 9am';
  if (p.weekday === 'Fri' && mins >= CLOSE_MIN) return 'Monday at 9am';
  if (mins >= CLOSE_MIN) return 'tomorrow at 9am';
  return 'at 9am';
}

function afterHoursNote(date) {
  return (
    'Heads up: we are outside business hours (Mon-Fri, 9am-6pm Toronto time). ' +
    "I've saved everything and the team will reply " + nextReplyText(date) + '. ' +
    'If this is an emergency (flooding, gas smell, no heat), say so and I will escalate it right away.'
  );
}

// ---------------------------------------------------------------------------
// Emergency dispatch flow. Today: alert Kevin (done by the caller via
// flagForKevin) and record the dispatch on the ticket so the inbox shows it.
// The plumber-priority step is where Joe's WhatsApp ping + calendar booking
// plugs in once Kevin gives the go.
// ---------------------------------------------------------------------------

function startEmergencyDispatch(store, ticket) {
  const dispatch = {
    flow: 'emergency',
    priorityTrade: 'plumbing', // most emergencies are plumbing - Kevin 2026-09-23
    status: 'awaiting_kevin',
    startedAt: new Date().toISOString(),
  };
  try {
    store.updateTicket(ticket.id, { dispatch });
  } catch (e) {
    console.error('dispatch record failed:', e.message);
  }
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'dispatch',
      flow: 'emergency',
      ticket: ticket.id,
      priorityTrade: dispatch.priorityTrade,
    })
  );
  return dispatch;
}

module.exports = {
  BUSINESS_TZ,
  AUTO_APPROVE_DEFAULT,
  torontoParts,
  torontoDayKey,
  isBusinessHours,
  nextReplyText,
  afterHoursNote,
  startEmergencyDispatch,
};
