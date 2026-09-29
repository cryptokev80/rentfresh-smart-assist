'use strict';

/**
 * Trade <-> tenant relay tests (built 2026-09-28):
 *   routing decisions (trade->tenant vs trade->Kevin, tenant follow-up vs
 *   new issue), relay-active lookup, message builders, and the loop guard.
 *
 * Run: node scripts/test-relay.js
 * Exit code 0 = all pass. No network is touched.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the store: point DATA_DIR at a temp dir before requiring it.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-assist-relay-'));
process.env.DATA_DIR = tmpDir;

const triage = require('../src/triage');
const policies = require('../src/policies');
const store = require('../src/store');
const relay = require('../src/relay');

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) {
    failures += 1;
    console.error('FAIL ' + name + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  } else {
    console.log('ok   ' + name);
  }
}
function checkContains(name, haystack, needle) {
  const ok = String(haystack).includes(needle);
  if (!ok) {
    failures += 1;
    console.error('FAIL ' + name + ': expected to contain ' + JSON.stringify(needle));
  } else {
    console.log('ok   ' + name);
  }
}
function noEmDash(name, s) {
  check(name + ' has no em dash', String(s).includes('\u2014'), false);
}

// --- fixtures: Joe the plumber, one dispatched ticket ---
const joe = store.saveTradeProfile({
  name: 'Joe Locker',
  trade: 'plumbing',
  phone: '16473337087',
  company: 'JSL Plumbing',
  serviceAreas: ['Toronto'],
});
const solo = store.saveTradeProfile({
  name: 'Sam Solo',
  trade: 'electrical',
  phone: '14165550001',
});

let ticket = store.createTicket({
  phone: '14165551234',
  tenantName: 'Sarah',
  kind: 'maintenance',
  trade: 'plumbing',
  urgency: 'routine',
  summary: 'Kitchen faucet leaking at the base',
});
// Simulate what dispatchApprovedTicket stores on a successful dispatch.
ticket = store.updateTicket(ticket.id, {
  status: 'dispatched',
  dispatch: { flow: 'nte-auto', status: 'dispatched', proId: joe.id, proName: joe.name },
  assignedProPhone: joe.phone,
  assignedProId: joe.id,
  assignedProName: joe.name,
});

// --- relay-active lookup ---
check('relay ticket found by pro phone', store.findRelayTicketByProPhone('16473337087').id, ticket.id);
check('relay lookup tolerates formatting', store.findRelayTicketByProPhone('+1 (647) 333-7087').id, ticket.id);
check('relay lookup: unknown pro -> null', store.findRelayTicketByProPhone('14165559999'), null);
check('relay lookup: empty -> null', store.findRelayTicketByProPhone(''), null);
check('relay ticket found by tenant phone', store.findRelayTicketByTenantPhone('14165551234').id, ticket.id);
check('relay lookup: unknown tenant -> null', store.findRelayTicketByTenantPhone('19995550101'), null);

// A failed dispatch never opens the relay.
const failed = store.createTicket({ phone: '14165550002', tenantName: 'Pat', trade: 'plumbing', summary: 'Drip' });
store.updateTicket(failed.id, {
  status: 'new',
  dispatch: { flow: 'nte-auto', status: 'failed', proId: joe.id },
  assignedProPhone: joe.phone,
});
check('failed dispatch: no relay for pro', store.findRelayTicketByProPhone(joe.phone).id, ticket.id);
check('failed dispatch: no relay for tenant', store.findRelayTicketByTenantPhone('14165550002'), null);

// Closing the ticket ends the relay.
store.setTicketStatus(ticket.id, 'closed');
check('closed ticket: no relay for pro', store.findRelayTicketByProPhone(joe.phone), null);
check('closed ticket: no relay for tenant', store.findRelayTicketByTenantPhone('14165551234'), null);
const closedTicket = store.getTicket(ticket.id);
check('isRelayActive false when closed', relay.isRelayActive(closedTicket, joe.phone), false);
store.setTicketStatus(ticket.id, 'dispatched');
ticket = store.getTicket(ticket.id);
check('isRelayActive true when dispatched', relay.isRelayActive(ticket, joe.phone), true);
check('isRelayActive false for wrong pro', relay.isRelayActive(ticket, solo.phone), false);
check('isRelayActive false without pro', relay.isRelayActive(ticket, ''), false);
check('isRelayActive false without ticket', relay.isRelayActive(null, joe.phone), false);

// --- trade reply routing: confirmations/status stay with Kevin ---
const toKevin = [
  'Affirmative',
  'Confirmed',
  'On my way',
  'Heading there now',
  'Done, all fixed',
  'Finished the job',
  'Thanks!',
  'Got it',
  'Will do',
  'Ok sounds good',
  'I will be there at 3pm',
  'Running 10 minutes late',
  '',
];
for (const text of toKevin) {
  check('trade->Kevin: ' + JSON.stringify(text), triage.tradeReplyTarget(text), 'kevin');
}

// --- trade reply routing: questions and detail requests go to the tenant ---
const toTenant = [
  'Can you send me a photo of the leak?',
  'Where is the shutoff valve?',
  'Is anyone home tomorrow morning?',
  'Please leave the door unlocked',
  'What floor is the unit on',
  'Could you take a picture of the meter?',
  'Do you have parking on site?',
  'Send me a video of the noise it makes',
];
for (const text of toTenant) {
  check('trade->tenant: ' + JSON.stringify(text), triage.tradeReplyTarget(text), 'tenant');
}
check('relay.tradeTargetsTenant true', relay.tradeTargetsTenant('Where is the valve?'), true);
check('relay.tradeTargetsTenant false', relay.tradeTargetsTenant('On my way'), false);

// --- tenant routing: follow-ups relay, new issues triage as today ---
check('follow-up question relays', relay.tenantTargetsTrade('Any update on the visit?', ticket), true);
check('status check relays', relay.tenantTargetsTrade('When is the pro coming?', ticket), true);
check('new plumbing issue does not relay', relay.tenantTargetsTrade('My sink is leaking again', ticket), false);
check('emergency-ish new report does not relay', relay.tenantTargetsTrade('Water is pouring through the ceiling', ticket), false);
check('no relay ticket -> no relay', relay.tenantTargetsTrade('Any update?', null), false);

// --- labels and message builders ---
check('pro label with company', relay.proLabel(joe), 'Joe (JSL Plumbing)');
check('pro label without company', relay.proLabel(solo), 'Sam');
check('tenant label', relay.tenantLabel(ticket), 'Tenant (' + ticket.id + ')');

const rt = relay.buildRelayText('pro', ticket, joe, 'Can you send a photo of the leak?');
check('trade->tenant text prefix', rt, 'Joe (JSL Plumbing): Can you send a photo of the leak?');
const tr = relay.buildRelayText('tenant', ticket, joe, 'The drip is worse this morning');
check('tenant->trade text prefix', tr, 'Tenant (' + ticket.id + '): The drip is worse this morning');
check('no-company trade prefix', relay.buildRelayText('pro', ticket, solo, 'Hi'), 'Sam: Hi');

check('photo caption with tenant caption',
  relay.buildRelayCaption('tenant', ticket, joe, 'image', 'Here is the leak'),
  'Tenant (' + ticket.id + '): Here is the leak');
check('photo caption without caption',
  relay.buildRelayCaption('pro', ticket, joe, 'image', ''),
  'Joe (JSL Plumbing) sent a photo.');
check('video caption without caption',
  relay.buildRelayCaption('pro', ticket, joe, 'video', null),
  'Joe (JSL Plumbing) sent a video.');

// --- sender-facing strings ---
check('relay ack to trade', relay.relayAck('pro', joe), 'Sent to the tenant.');
check('relay ack to tenant', relay.relayAck('tenant', joe), 'Sent to Joe.');
checkContains('failure notice names Kevin', relay.relayFailureNotice('text'), 'Kevin has been notified');
checkContains('failure notice photo wording', relay.relayFailureNotice('image'), 'that photo');
checkContains('failure notice video wording', relay.relayFailureNotice('video'), 'that video');
for (const s of [relay.relayAck('pro', joe), relay.relayAck('tenant', joe),
  relay.relayFailureNotice('text'), relay.relayFailureNotice('image'), relay.relayFailureNotice('video'),
  rt, tr, relay.buildRelayCaption('pro', ticket, joe, 'image', '')]) {
  noEmDash('relay string', s);
}

// --- loop guard ---
const tag = relay.relayTag('pro', ticket);
check('relay tag carries ticket', tag.ticket, ticket.id);
check('relay tag carries direction', tag.from, 'pro');
check('relay tag carries timestamp', typeof tag.at, 'string');

// A forwarded copy stored in the recipient's conversation carries the tag.
const idx = store.addMessage('14165551234', 'out', 'text', rt, { relay: tag });
const stored = store.getMessages('14165551234')[idx];
check('forwarded copy is tagged', relay.isRelayedMessage(stored), true);
check('tag survives the store round-trip', stored.relay.ticket, ticket.id);

// Ordinary messages are not tagged: the inbound handler only ever sees
// untagged 'in' messages, so a forward can never be re-forwarded.
const inIdx = store.addMessage('16473337087', 'in', 'text', 'Where is the valve?');
check('inbound message not tagged', relay.isRelayedMessage(store.getMessages('16473337087')[inIdx]), false);
check('null message not tagged', relay.isRelayedMessage(null), false);

// Never forward back to the sender's own number.
const selfTicket = Object.assign({}, ticket, { phone: joe.phone });
check('same-number pro/tenant -> no recipient', relay.relayRecipient('pro', selfTicket, joe), null);
check('normal relay recipient (pro->tenant)', relay.relayRecipient('pro', ticket, joe), '14165551234');
check('normal relay recipient (tenant->pro)', relay.relayRecipient('tenant', ticket, joe), joe.phone);
check('missing pro phone -> no recipient', relay.relayRecipient('tenant', ticket, { phone: '' }), null);

// The trade lookup still resolves, so relay wiring uses real profiles.
check('findProByPhone for relay', policies.findProByPhone(store, joe.phone).name, 'Joe Locker');

if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('all relay tests passed');
