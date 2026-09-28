'use strict';

/**
 * NTE + dispatch tests for the ProQue triage bot (built 2026-09-28):
 *   per-landlord NTE cap, quote evaluation (auto-approve vs landlord sign-off),
 *   cap changes by text, landlord signup properties matched by tenant phone,
 *   trade profiles with service areas, location-based dispatch ranking.
 *
 * Run: node scripts/test-nte.js
 * Exit code 0 = all pass.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the store: point DATA_DIR at a temp dir before requiring it.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-assist-nte-'));
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

// --- CAD formatting ---
check('fmtCAD whole', triage.fmtCAD(350), '$350');
check('fmtCAD thousands', triage.fmtCAD(1250), '$1,250');

// --- cap change parsing ---
check('set my cap to 500', triage.parseCapChange('set my cap to 500'), 500);
check('My limit is 400', triage.parseCapChange('My limit is 400'), 400);
check('change cap to $600', triage.parseCapChange('please change cap to $600'), 600);
check('approve is not a cap change', triage.parseCapChange('approve'), null);
check('leak report is not a cap change', triage.parseCapChange('my sink is leaking'), null);
check('absurd low ignored', triage.parseCapChange('set my cap to 5'), null);
check('absurd high ignored', triage.parseCapChange('set my cap to 99999'), null);

// --- quote evaluation ---
check('under cap approves', policies.evaluateQuote(350, 300).withinCap, true);
check('at cap approves', policies.evaluateQuote(350, 350).withinCap, true);
check('over cap needs sign-off', policies.evaluateQuote(350, 351).withinCap, false);

// --- tenant quote messages ---
const overTicket = {
  id: 'RF-1', trade: 'plumbing', urgency: 'routine', summary: 'leak',
  tenantName: 'Sarah', autoApproveLimit: 350,
  quote: { labor: 400, materials: 120, total: 520 },
};
const pendingMsg = triage.tenantQuoteMessage(overTicket, false);
check('pending shows total', pendingMsg.includes('$520'), true);
check('pending shows labor/materials split', pendingMsg.includes('$400 labor + $120 materials'), true);
check('pending shows cap', pendingMsg.includes('$350'), true);
const approvedMsg = triage.tenantQuoteMessage(
  Object.assign({}, overTicket, { quote: { labor: 200, materials: 50, total: 250 } }), true
);
check('approved shows total', approvedMsg.includes('$250'), true);
check('approved mentions pro lined up', approvedMsg.includes('lining up the pro'), true);

// --- landlord summary with quote ---
const summary = triage.landlordSummaryMessage(overTicket);
check('summary shows quote breakdown', summary.includes('Quote: $520 total ($400 labor + $120 materials).'), true);
check('summary flags over-cap', summary.includes('over your $350 auto-approve limit'), true);
check('summary keeps approve/decline prompt', summary.includes('Reply APPROVE'), true);
const underSummary = triage.landlordSummaryMessage(
  Object.assign({}, overTicket, { quote: { labor: 200, materials: 50, total: 250 } })
);
check('under-cap summary has no sign-off flag', underSummary.includes('needs your sign-off'), false);
const noQuoteSummary = triage.landlordSummaryMessage(Object.assign({}, overTicket, { quote: null }));
check('no-quote summary keeps confirm line', noQuoteSummary.includes('will confirm the quote'), true);

// --- landlord signup: properties matched by tenant phone ---
store.setLandlordPolicy('14165550101', {
  name: 'Test Landlord',
  autoApproveLimit: 400,
  properties: [
    { unit: 'Unit 4', address: '123 Main St, Toronto, ON', tenantName: 'Sarah', tenantPhone: '14165551212' },
    { unit: 'Unit 7', address: '88 Queen St, Mississauga, ON', tenantName: 'Mike', tenantPhone: '14165557777' },
  ],
});
const prop = store.findPropertyByTenantPhone('14165551212');
check('property found by tenant phone', prop && prop.address, '123 Main St, Toronto, ON');
check('property carries unit', prop && prop.unit, 'Unit 4');
check('property carries landlord cap', prop && prop.autoApproveLimit, 400);
check('property carries landlord phone', prop && prop.landlordPhone, '14165550101');
check('unknown tenant phone -> null', store.findPropertyByTenantPhone('19990000000'), null);
check('landlord known by policy', store.isKnownLandlord('14165550101'), true);
check('tenant is not a landlord', store.isKnownLandlord('14165551212'), false);
const landlords = store.listLandlords();
check('landlord listed', landlords.length, 1);
check('landlord properties listed', landlords[0].properties.length, 2);

// --- awaiting-ticket lookup for cap re-evaluation ---
const t1 = store.createTicket({
  phone: '14165551212', tenantName: 'Sarah', kind: 'maintenance',
  trade: 'plumbing', urgency: 'routine', summary: 'leak',
  landlordPhone: '14165550101',
  quote: { labor: 300, materials: 100, total: 400 },
});
store.updateTicket(t1.id, { awaitingLandlord: true, landlordNotifiedAt: new Date().toISOString() });
const awaiting = store.findAwaitingLandlordTicketsByLandlord('14165550101');
check('awaiting ticket found', awaiting.length, 1);
check('awaiting ticket id', awaiting[0].id, t1.id);

// --- trade profiles + location-based dispatch ---
store.saveTradeProfile({
  id: 'joe', name: 'Joe', trade: 'plumbing', phone: '14165550001',
  serviceAreas: ['Toronto'],
});
store.saveTradeProfile({
  id: 'sam', name: 'Sam', trade: 'plumbing', phone: '14165550002',
  serviceAreas: ['Mississauga'],
});
store.saveTradeProfile({
  id: 'ali', name: 'Ali', trade: 'electrical', phone: '14165550003',
  serviceAreas: ['Toronto'],
});
const profiles = store.getTradeProfiles();
check('three trade profiles', profiles.length, 3);
const torontoTicket = Object.assign({}, t1, { address: '123 Main St, Toronto, ON' });
const ranked = policies.findCandidateTrades(store, torontoTicket);
check('trade type filters (2 plumbers)', ranked.length, 2);
check('covering trade ranks first', ranked[0].id, 'joe');
const noAddrTicket = Object.assign({}, t1, { address: null });
const unranked = policies.findCandidateTrades(store, noAddrTicket);
check('no address still returns trade matches', unranked.length, 2);

fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('all NTE tests passed');
