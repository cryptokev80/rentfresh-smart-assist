'use strict';

/**
 * Policy tests for the ProQue triage bot (set with Kevin, updated 2026-09-28):
 *   24/7 triage (no business-hours concept, no after-hours note),
 *   $350 default auto-approve with per-landlord overrides,
 *   emergency dispatch flow records plumber priority.
 *
 * Run: node scripts/test-policies.js
 * Exit code 0 = all pass.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the store: point DATA_DIR at a temp dir before requiring it.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-assist-test-'));
process.env.DATA_DIR = tmpDir;

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

// --- 24/7 triage: no hours concept on the policy surface ---
check('no isBusinessHours', typeof policies.isBusinessHours, 'undefined');
check('no afterHoursNote', typeof policies.afterHoursNote, 'undefined');

// --- landlord spending policy (default $350 from config) ---
check('default limit 350', store.getLandlordPolicy('16475551212').autoApproveLimit, 350);
store.setLandlordPolicy('16475551212', { autoApproveLimit: 500 });
check('override to 500', store.getLandlordPolicy('16475551212').autoApproveLimit, 500);
check('other landlord still default', store.getLandlordPolicy('16475559999').autoApproveLimit, 350);

// --- clearAllData preserves landlord policies (config, not test data) ---
store.getConversation('19995550101', 'Test');
const cleared = store.clearAllData();
check('cleared 1 conversation', cleared.conversations, 1);
check('policies survive wipe', store.getLandlordPolicy('16475551212').autoApproveLimit, 500);
check('conversations wiped', store.listConversations().length, 0);

// --- emergency dispatch flow ---
const t = store.createTicket({ phone: '19995550101', kind: 'maintenance', trade: 'plumbing', urgency: 'emergency', summary: 'burst pipe' });
const d = policies.startEmergencyDispatch(store, t);
check('dispatch flow emergency', d.flow, 'emergency');
check('dispatch prioritizes plumber', d.priorityTrade, 'plumbing');
check('dispatch recorded on ticket', store.getTicket(t.id).dispatch.priorityTrade, 'plumbing');

fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('all policy tests passed');
