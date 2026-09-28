'use strict';

/**
 * Pro dispatch tests for the ProQue triage bot (built 2026-09-28):
 *   job card message content, trade lookup by phone (so a pro reply is
 *   never triaged as a tenant), and candidate ranking by service area.
 *
 * Run: node scripts/test-dispatch.js
 * Exit code 0 = all pass.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the store: point DATA_DIR at a temp dir before requiring it.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-assist-dispatch-'));
process.env.DATA_DIR = tmpDir;

const triage = require('../src/triage');
const policies = require('../src/policies');
const store = require('../src/store');

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

// --- trade profiles ---
const joe = store.saveTradeProfile({
  name: 'Joe Locker',
  trade: 'plumbing',
  phone: '16473337087',
  email: 'jslplumbing25@gmail.com',
  company: 'JSL Plumbing',
  rates: { hourly: 70, minimumHours: 1.5 },
  serviceAreas: ['Toronto', 'Mississauga', 'Etobicoke', 'Scarborough', 'North York', 'Vaughan', 'Markham', 'Richmond Hill', 'Brampton'],
});
check('profile saved with id', !!joe.id, true);
check('profile rates kept', joe.rates && joe.rates.hourly, 70);
check('profile company kept', joe.company, 'JSL Plumbing');

const other = store.saveTradeProfile({
  name: 'Far Plumber',
  trade: 'plumbing',
  phone: '14165559999',
  serviceAreas: ['Ottawa'],
});
check('second profile saved', !!other.id, true);

// --- findProByPhone ---
check('finds Joe by digits', policies.findProByPhone(store, '16473337087').name, 'Joe Locker');
check('finds Joe with formatting', policies.findProByPhone(store, '+1 (647) 333-7087').name, 'Joe Locker');
check('unknown number returns null', policies.findProByPhone(store, '14165550000'), null);
check('empty returns null', policies.findProByPhone(store, ''), null);

// --- candidate ranking: local pro wins over out-of-area ---
const ticket = {
  id: 'RF-1004', trade: 'plumbing', urgency: 'routine',
  summary: 'Kitchen faucet leaking at the base',
  address: '123 King St W, Toronto', unit: 'Unit 4',
  phone: '14165551234', tenantName: 'Sarah',
  landlordName: 'Mike', landlordPhone: '14165554567',
  quote: { labor: 300, materials: 120, total: 420 },
};
const candidates = policies.findCandidateTrades(store, ticket);
check('two plumbing candidates', candidates.length, 2);
check('local pro ranked first', candidates[0].name, 'Joe Locker');

// --- job card message ---
const card = triage.proJobCardMessage(ticket, joe);
checkContains('card has ticket id', card, 'RF-1004');
checkContains('card has company', card, 'JSL Plumbing');
checkContains('card has address', card, '123 King St W, Toronto');
checkContains('card has issue', card, 'Kitchen faucet leaking at the base');
checkContains('card has quote total', card, '$420');
checkContains('card has labor/materials', card, '$300 labor + $120 materials');
checkContains('card has tenant', card, 'Sarah');
checkContains('card has landlord', card, 'Mike');
check('card has no em dashes', card.includes('\u2014'), false);

// --- job card without quote still reads fine ---
const noQuoteCard = triage.proJobCardMessage(
  Object.assign({}, ticket, { quote: null }), joe
);
checkContains('no-quote card has ticket', noQuoteCard, 'RF-1004');
check('no-quote card skips quote line', noQuoteCard.includes('Quote:'), false);

if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('all dispatch tests passed');
