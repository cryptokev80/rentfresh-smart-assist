'use strict';

/**
 * Business policies — now driven by config/business.json, not hardcoded.
 *
 * ProQue values (set with Kevin, updated 2026-09-28) live in the config file:
 * - Business hours: Mon-Fri 9am-6pm America/Toronto. Closed weekends.
 * - After hours: the bot still answers and collects details, tells the sender
 *   when the team replies next, and still escalates true emergencies at once.
 * - Spending: default auto-approve $350 per landlord (adjustable per landlord).
 * - Emergencies: alert Kevin first, then start the dispatch flow.
 */

const biz = require('./config');

const BUSINESS_TZ = biz.timezone;
const AUTO_APPROVE_DEFAULT = biz.autoApproveDefault;

function parseHM(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

const OPEN_MIN = parseHM(biz.businessHours.open);
const CLOSE_MIN = parseHM(biz.businessHours.close);
const OPEN_DAYS = new Set(biz.businessHours.days || []);
const DAY_ORDER = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_FULL = {
  Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday',
  Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday',
};

function tzParts(date) {
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

/** 'YYYY-MM-DD' in business time: used to note after-hours once per day. */
function torontoDayKey(date) {
  const p = tzParts(date || new Date());
  return p.year + '-' + p.month + '-' + p.day;
}

function isBusinessHours(date) {
  const p = tzParts(date || new Date());
  if (!OPEN_DAYS.has(p.weekday)) return false;
  const mins = parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10);
  return mins >= OPEN_MIN && mins < CLOSE_MIN;
}

function fmtHour(mins) {
  const h = Math.floor(mins / 60);
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ampm;
}

/** e.g. "Mon-Fri, 9am-6pm" for the after-hours note. */
function hoursLabel() {
  const days = biz.businessHours.days || [];
  const dayLabel = days.length === 5 && days[0] === 'Mon' && days[4] === 'Fri'
    ? 'Mon-Fri'
    : days.join(', ');
  return dayLabel + ', ' + fmtHour(OPEN_MIN) + '-' + fmtHour(CLOSE_MIN);
}

/** Human phrasing for when the team replies next, e.g. "tomorrow at 9am". */
function nextReplyText(date) {
  const p = tzParts(date || new Date());
  const mins = parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10);
  const openLabel = fmtHour(OPEN_MIN);
  if (!OPEN_DAYS.has(p.weekday) || mins >= CLOSE_MIN) {
    // Find the next open day.
    const idx = DAY_ORDER.indexOf(p.weekday);
    for (let i = 1; i <= 7; i++) {
      const d = DAY_ORDER[(idx + i) % 7];
      if (OPEN_DAYS.has(d)) {
        const when = i === 1 ? 'tomorrow' : DAY_FULL[d];
        return when + ' at ' + openLabel;
      }
    }
  }
  return 'at ' + openLabel;
}

function afterHoursNote(date) {
  return biz.fill(biz.messaging.afterHoursNote, {
    hoursLabel: hoursLabel(),
    nextReply: nextReplyText(date),
    emergencyExamples: biz.emergency.examples,
  });
}

// ---------------------------------------------------------------------------
// Emergency dispatch flow. Today: alert the owner (done by the caller via
// flagForKevin) and record the dispatch on the ticket so the inbox shows it.
// The trade-priority step is where the pro ping + calendar booking plugs in.
// ---------------------------------------------------------------------------

function startEmergencyDispatch(store, ticket) {
  const dispatch = {
    flow: 'emergency',
    priorityTrade: biz.emergency.priorityTrade,
    status: 'awaiting_owner',
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
  torontoParts: tzParts,
  torontoDayKey,
  isBusinessHours,
  nextReplyText,
  afterHoursNote,
  startEmergencyDispatch,
};
