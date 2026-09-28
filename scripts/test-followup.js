'use strict';
// Regression test for the thermostat-on-a-faucet-leak bug:
// "prevent" contains "vent", which used to triage the follow-up as HVAC,
// and post-ticket follow-ups used to restart triage instead of staying
// on the open ticket.
const assert = require('assert');
const triage = require('../src/triage');

// 1. Whole-word keyword matching.
let r = triage.classify('Can I do anything in the meantime to prevent more damage?');
assert.strictEqual(r.trade, 'general', 'prevent must not match vent, got: ' + r.trade);

// 2. Real HVAC reports still classify as hvac.
r = triage.classify('my heater is not working');
assert.strictEqual(r.trade, 'hvac', 'heater should be hvac, got: ' + r.trade);
r = triage.classify('is the thermostat display on');
assert.strictEqual(r.trade, 'hvac', 'thermostat should be hvac, got: ' + r.trade);

// 3. The original leak report still classifies as plumbing.
r = triage.classify('My faucet looks like it is leaking');
assert.strictEqual(r.trade, 'plumbing', 'faucet leak should be plumbing, got: ' + r.trade);

// 4. Follow-up detection: questions about the open ticket stay on it.
assert.strictEqual(
  triage.isFollowupOnTicket('Can I do anything in the meantime to prevent more damage?'),
  true
);
assert.strictEqual(triage.isFollowupOnTicket('any update on this?'), true);

// 5. New issue reports are not follow-ups, even with an open ticket.
assert.strictEqual(triage.isFollowupOnTicket('my toilet is clogged too'), false);
assert.strictEqual(triage.isFollowupOnTicket('the faucet is leaking worse now'), false);

// 6. Interim advice exists for every trade.
for (const trade of ['plumbing', 'electrical', 'hvac', 'appliance', 'general']) {
  const advice = triage.interimAdviceFor(trade);
  assert.ok(advice && advice.length > 20, 'missing interim advice for ' + trade);
}

console.log('test-followup: all assertions passed');
