'use strict';

/**
 * Business policies — now driven by config/business.json, not hardcoded.
 *
 * ProQue values (set with Kevin, updated 2026-09-28) live in the config file:
 * - Triage is 24/7: the bot always answers and collects details. There is no
 *   business-hours concept and no after-hours note.
 * - Spending: default auto-approve $350 per landlord (adjustable per landlord).
 * - Emergencies: alert Kevin first, then start the dispatch flow.
 */

const biz = require('./config');

const AUTO_APPROVE_DEFAULT = biz.autoApproveDefault;

// ---------------------------------------------------------------------------
// NTE spending cap. A quote at or under the landlord's cap is auto-approved;
// anything over needs the landlord's sign-off.
// ---------------------------------------------------------------------------

function evaluateQuote(limit, total) {
  const lim = Number(limit) || AUTO_APPROVE_DEFAULT;
  const tot = Number(total) || 0;
  return { withinCap: tot <= lim, limit: lim, total: tot };
}

// ---------------------------------------------------------------------------
// Location-based dispatch. Trade profiles carry serviceAreas (cities or
// postal zones they cover). Candidates match the ticket's trade first, then
// rank trades whose service area covers the tenant's address first.
// ---------------------------------------------------------------------------

function findCandidateTrades(store, ticket) {
  const profiles = (store.getTradeProfiles ? store.getTradeProfiles() : [])
    .filter((p) => p && p.trade === ticket.trade);
  const addr = String(ticket.address || '').toLowerCase();
  return profiles
    .map((p) => ({
      profile: p,
      covers: addr && Array.isArray(p.serviceAreas)
        ? p.serviceAreas.some((a) => addr.includes(String(a).toLowerCase()))
        : false,
    }))
    .sort((a, b) => Number(b.covers) - Number(a.covers))
    .map((x) => x.profile);
}

// Find a trade profile by phone (digits). Used so a pro replying to a job
// card is never triaged as a new tenant; their reply goes to Kevin.
function findProByPhone(store, phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  return (store.getTradeProfiles ? store.getTradeProfiles() : [])
    .find((p) => p && String(p.phone || '').replace(/\D/g, '') === digits) || null;
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
  AUTO_APPROVE_DEFAULT,
  evaluateQuote,
  findCandidateTrades,
  findProByPhone,
  startEmergencyDispatch,
};
