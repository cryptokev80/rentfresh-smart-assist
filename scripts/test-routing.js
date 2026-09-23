'use strict';

/**
 * Routing tests for Smart Assist handleText intent order:
 *   emergency -> landlord reply -> human -> in-flow -> acknowledgment
 *   -> lead -> general -> maintenance triage (default)
 *
 * Run: node scripts/test-routing.js
 * Exit code 0 = all pass.
 */

const triage = require('../src/triage');

// Mirror of the routing order in server.js handleText (minus store-dependent
// steps: landlord reply and in-flow continuation).
function route(text) {
  const result = triage.classify(text);
  if (result.emergency) return 'emergency';
  if (triage.wantsHuman(text)) return 'human';
  if (triage.isAcknowledgment(text)) return 'acknowledgment';
  if (triage.isLeadInquiry(text)) return 'lead';
  if (triage.isGeneralInquiry(text)) return 'general';
  return 'triage';
}

const cases = [
  // --- NEW: general business route ---
  ['Hi', 'general'],
  ['Hello', 'general'],
  ['Hey', 'general'],
  ['Good morning', 'general'],
  ['What are your hours?', 'general'],
  ['What do you do?', 'general'],
  ['What is RentFresh?', 'general'],
  ['How does this work?', 'general'],
  ['Who is this?', 'general'],
  ['Where are you located?', 'general'],
  ['What is your phone number?', 'general'],

  // --- general must NOT steal problem reports (greeting + problem) ---
  ['Hi, my sink is leaking', 'triage'],
  ['Hello, my toilet is clogged', 'triage'],
  ['Hey, there is no heat in my unit', 'triage'],

  // --- regressions: existing intents unchanged ---
  ['Water is pouring through my kitchen ceiling right now', 'emergency'],
  ['I smell gas in the kitchen', 'emergency'],
  ['Ok thanks', 'acknowledgment'],
  ['Thanks so much', 'acknowledgment'],
  ['I want to talk to a real person', 'human'],
  ['Can I speak to a human please', 'human'],
  ['I need a quote for a unit turnover', 'lead'],
  ['Do you service North York?', 'lead'],
  ['How much for a move out cleaning?', 'lead'],
  ['My kitchen sink is dripping', 'triage'],
  ['The bathroom thingy is making a weird noise', 'triage'], // unknown -> triage default
];

let failed = 0;
for (const [text, expected] of cases) {
  const got = route(text);
  const ok = got === expected;
  if (!ok) failed += 1;
  console.log((ok ? 'PASS' : 'FAIL') + '  [' + got + ']  "' + text + '"' + (ok ? '' : '  (expected ' + expected + ')'));
}

// The general reply must not promise quotes/prices over chat and must
// point both tenants and landlords at a next step.
const reply = triage.generalReplyMessage();
const replyChecks = [
  ['mentions RentFresh', /rentfresh/i.test(reply)],
  ['mentions Toronto/GTA', /toronto|gta/i.test(reply)],
  ['tenant next step', /describe it/i.test(reply)],
  ['landlord next step', /landlord or property manager/i.test(reply)],
];
for (const [label, ok] of replyChecks) {
  if (!ok) failed += 1;
  console.log((ok ? 'PASS' : 'FAIL') + '  general reply ' + label);
}

console.log(failed === 0 ? '\nAll routing tests passed.' : '\n' + failed + ' test(s) FAILED.');
process.exit(failed === 0 ? 0 : 1);
