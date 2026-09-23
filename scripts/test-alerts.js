'use strict';

/**
 * Tests for NEEDS YOU email alerts.
 *
 * Run: node scripts/test-alerts.js
 * Exit code 0 = all pass. No network is touched: without RESEND_API_KEY
 * the sender short-circuits, which is exactly what we assert.
 */

// Isolate the store in a temp dir (store.js reads DATA_DIR at require time).
process.env.DATA_DIR = require('os').tmpdir() + '/smart-assist-test-' + Date.now();
delete process.env.RESEND_API_KEY; // force the no-key path

const store = require('../src/store');
const alerts = require('../src/alerts');

let failed = 0;
function check(label, cond) {
  if (!cond) failed += 1;
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label);
}

const phone = '16475275802';

// --- buildAlert ---
store.addMessage(phone, 'in', 'text', 'My sink is leaking');
store.addMessage(phone, 'out', 'text', 'Got it, logging a ticket.');
const payload = alerts.buildAlert({
  phone,
  name: 'Kevin',
  reason: 'human handoff requested',
  messages: store.getMessages(phone),
});
check('subject names reason and phone',
  payload.subject === 'NEEDS YOU: human handoff requested (16475275802)');
check('to defaults to rentfreshteam@gmail.com', payload.to === 'rentfreshteam@gmail.com');
check('body has reason line', payload.text.includes('Reason: human handoff requested'));
check('body has transcript', payload.text.includes('Them: My sink is leaking') && payload.text.includes('Bot: Got it, logging a ticket.'));
check('no em dashes in payload', !payload.subject.includes('\u2014') && !payload.text.includes('\u2014'));

// --- flagNeedsHuman: one alert per escalation (transition only) ---
const first = alerts.flagNeedsHuman(store, phone, 'human handoff requested');
check('first flag returns newly=true', first === true);
const convo = store.getConversation(phone);
check('flag sets needsHuman', convo.needsHuman === true);
check('flag stores reason', convo.needsHumanReason === 'human handoff requested');
check('flag stores timestamp', typeof convo.needsHumanAt === 'string');
const second = alerts.flagNeedsHuman(store, phone, 'another reason');
check('second flag returns newly=false', second === false);
check('reason keeps first escalation', store.getConversation(phone).needsHumanReason === 'human handoff requested');

// Clearing the flag (what the inbox reply endpoint does) re-arms alerts.
store.updateConversation(phone, { needsHuman: false });
check('re-flag after clear returns newly=true', alerts.flagNeedsHuman(store, phone, 'emergency') === true);

// --- sendEmail without a key: skipped, no throw, no network ---
(async () => {
  const r = await alerts.sendEmail({ to: 'a@b.c', from: 'x@y.z', subject: 's', text: 't' });
  check('sendEmail without key is skipped', r.sent === false && r.reason === 'missing RESEND_API_KEY');

  const r2 = await alerts.sendNeedsHumanAlert(store, phone, 'human handoff requested');
  check('sendNeedsHumanAlert without key is skipped', r2.sent === false);

  console.log(failed === 0 ? '\nAll alert tests passed.' : '\n' + failed + ' test(s) FAILED.');
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
