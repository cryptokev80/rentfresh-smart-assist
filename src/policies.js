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
  startEmergencyDispatch,
};
