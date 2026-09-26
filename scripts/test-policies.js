'use strict';

/**
 * Policy tests for Smart Assist business rules (set with Kevin 2026-09-23):
 *   business hours Mon-Fri 9am-6pm Toronto, after-hours note,
 *   $300 default auto-approve with per-landlord overrides,
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

// 2026-09-21 is a Monday. Toronto is EDT (UTC-4) in September.
function edt(y, m, d, h, min) {
  return new Date(Date.UTC(y, m - 1, d, h + 4, min || 0));
}
const MON = (h, min) => edt(2026, 9, 21, h, min); // Monday
const FRI = (h, min) => edt(2026, 9, 25, h, min); // Friday
const SAT = (h, min) => edt(2026, 9, 26, h, min); // Saturday
const SUN = (h, min) => edt(2026, 9, 27, h, min); // Sunday

// --- business hours ---
check('Mon 10:00 open', policies.isBusinessHours(MON(10)), true);
check('Mon 09:00 boundary open', policies.isBusinessHours(MON(9, 0)), true);
check('Mon 08:59 closed', policies.isBusinessHours(MON(8, 59)), false);
check('Fri 17:59 open', policies.isBusinessHours(FRI(17, 59)), true);
check('Fri 18:00 boundary closed', policies.isBusinessHours(FRI(18, 0)), false);
check('Sat 10:00 closed', policies.isBusinessHours(SAT(10)), false);
check('Sun 10:00 closed', policies.isBusinessHours(SUN(10)), false);

// --- next reply text ---
check('Fri night -> Monday', policies.nextReplyText(FRI(20)), 'Monday at 9am');
check('Sat -> Monday', policies.nextReplyText(SAT(12)), 'Monday at 9am');
check('Sun -> Monday', policies.nextReplyText(SUN(12)), 'tomorrow at 9am');
check('Wed night -> tomorrow', policies.nextReplyText(edt(2026, 9, 23, 20)), 'tomorrow at 9am');
check('Wed early -> at 9am', policies.nextReplyText(edt(2026, 9, 23, 7)), 'at 9am');

// --- after-hours note ---
const note = policies.afterHoursNote(FRI(20));
check('note mentions hours', note.includes('Mon-Fri, 9am-6pm'), true);
check('note mentions Monday reply', note.includes('Monday at 9am'), true);
check('note has no em dashes', note.includes('\u2014'), false);

// --- day key ---
check('day key format', policies.torontoDayKey(MON(10)), '2026-09-21');

// --- landlord spending policy ---
check('default limit 300', store.getLandlordPolicy('16475551212').autoApproveLimit, 300);
store.setLandlordPolicy('16475551212', { autoApproveLimit: 500 });
check('override to 500', store.getLandlordPolicy('16475551212').autoApproveLimit, 500);
check('other landlord still default', store.getLandlordPolicy('16475559999').autoApproveLimit, 300);

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
