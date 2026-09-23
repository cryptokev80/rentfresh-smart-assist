'use strict';

/**
 * Tests for WhatsApp message status events (sent / delivered / read / failed).
 *
 * Run: node scripts/test-status.js
 * Exit code 0 = all pass.
 */

// Isolate the store in a temp dir (store.js reads DATA_DIR at require time).
process.env.DATA_DIR = require('os').tmpdir() + '/smart-assist-test-' + Date.now();

const store = require('../src/store');
const msgStatus = require('../src/status');

let failed = 0;
function check(label, cond) {
  if (!cond) failed += 1;
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label);
}

// --- normalizeStatus ---
check('normalize delivered', (() => {
  const n = msgStatus.normalizeStatus({ id: 'wamid.1', status: 'delivered', recipient_id: '16475275802', timestamp: '1' });
  return n && n.waId === 'wamid.1' && n.status === 'delivered' && n.recipient === '16475275802' && n.error === null;
})());
check('normalize failed captures error', (() => {
  const n = msgStatus.normalizeStatus({
    id: 'wamid.2', status: 'failed', recipient_id: '16475275802',
    errors: [{ code: 131026, title: 'Message undeliverable' }],
  });
  return n && n.status === 'failed' && n.error === '131026: Message undeliverable';
})());
check('normalize rejects unknown status', msgStatus.normalizeStatus({ id: 'wamid.3', status: 'deleted' }) === null);
check('normalize rejects missing id', msgStatus.normalizeStatus({ status: 'read' }) === null);
check('normalize rejects garbage', msgStatus.normalizeStatus(null) === null && msgStatus.normalizeStatus('x') === null);

// --- store: addMessage returns index, tracks waId ---
const phone = '16475275802';
const idx = store.addMessage(phone, 'out', 'text', 'Hello test');
check('addMessage returns index', idx === 0);
store.updateMessage(phone, idx, { waId: 'wamid.abc', status: 'sent' });
const found = store.findMessageByWaId('wamid.abc');
check('findMessageByWaId finds it', !!found && found.phone === phone && found.index === 0);
check('findMessageByWaId misses unknown', store.findMessageByWaId('wamid.nope') === null);

// --- applyStatus: forward progression, no downgrade on out-of-order ---
const events = [];
const logEvent = (o) => events.push(o);
msgStatus.applyStatus(store, logEvent, msgStatus.normalizeStatus({ id: 'wamid.abc', status: 'delivered', recipient_id: phone }));
check('delivered applied', store.findMessageByWaId('wamid.abc').message.status === 'delivered');
msgStatus.applyStatus(store, logEvent, msgStatus.normalizeStatus({ id: 'wamid.abc', status: 'sent', recipient_id: phone }));
check('out-of-order sent does not downgrade delivered', store.findMessageByWaId('wamid.abc').message.status === 'delivered');
msgStatus.applyStatus(store, logEvent, msgStatus.normalizeStatus({ id: 'wamid.abc', status: 'read', recipient_id: phone }));
check('read applied', store.findMessageByWaId('wamid.abc').message.status === 'read');

// --- applyStatus: failed flags conversation and stores error ---
const idx2 = store.addMessage(phone, 'out', 'text', 'Second test');
store.updateMessage(phone, idx2, { waId: 'wamid.def', status: 'sent' });
const ret = msgStatus.applyStatus(store, logEvent, msgStatus.normalizeStatus({
  id: 'wamid.def', status: 'failed', recipient_id: phone,
  errors: [{ code: 131026, title: 'Message undeliverable' }],
}));
const failedMsg = store.findMessageByWaId('wamid.def').message;
check('failed applied', failedMsg.status === 'failed');
check('failed stores error', failedMsg.statusError === '131026: Message undeliverable');
check('failed flags needsHuman', store.getConversation(phone).needsHuman === true);
check('applyStatus returns phone', ret === phone);

// --- applyStatus: onFailed callback fires on failure ---
const idx3 = store.addMessage(phone, 'out', 'text', 'Third test');
store.updateMessage(phone, idx3, { waId: 'wamid.ghi', status: 'sent' });
let cbArgs = null;
msgStatus.applyStatus(store, logEvent, msgStatus.normalizeStatus({
  id: 'wamid.ghi', status: 'failed', recipient_id: phone,
  errors: [{ code: 131047, title: 'Re-engagement required' }],
}), (p, e) => { cbArgs = { p, e }; });
check('onFailed callback fires with phone and error',
  !!cbArgs && cbArgs.p === phone && cbArgs.e === '131047: Re-engagement required');
check('failed still flags needsHuman with callback', store.getConversation(phone).needsHuman === true);
const before = events.length;
const ret2 = msgStatus.applyStatus(store, logEvent, msgStatus.normalizeStatus({ id: 'wamid.ghost', status: 'read' }));
check('unknown waId returns null', ret2 === null);
check('unknown waId logged as unmatched', events.length === before + 1 && events[events.length - 1].matched === false);

// --- applyStatus: null norm is a safe no-op ---
check('null norm is no-op', msgStatus.applyStatus(store, logEvent, null) === null);

console.log(failed === 0 ? '\nAll status tests passed.' : '\n' + failed + ' test(s) FAILED.');
process.exit(failed === 0 ? 0 : 1);
