'use strict';

/**
 * Business config loader — the heart of the Spark Digital spin-out plan.
 *
 * Every business-specific string, name, hour, and policy lives in
 * config/business.json (overridable via BUSINESS_CONFIG env var pointing at
 * another JSON file). The engine code must never hardcode a business name,
 * owner name, phone, email, timezone, or hours: it reads them from here.
 *
 * RentFresh is client #1. A second business is a second JSON file, not a
 * second codebase.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  businessName: 'Business',
  assistantName: 'Smart Assist',
  ownerName: 'the owner',
  serviceArea: 'the area',
  timezone: 'America/Toronto',
  timezoneLabel: 'local time',
  businessHours: { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], open: '09:00', close: '18:00' },
  contact: { phone: '', email: '' },
  alertEmail: '',
  alertFrom: 'Smart Assist Alerts <onboarding@resend.dev>',
  vertical: 'general',
  customerNoun: 'customer',
  approverNoun: 'manager',
  autoApproveDefault: 300,
  emergency: { priorityTrade: 'general', examples: 'an urgent safety issue', gasUtilityName: '', gasUtilityEmergencyNumber: '' },
  vision: { context: 'a customer-service triage assistant for a local business' },
  messaging: {},
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  const out = Object.assign({}, base);
  for (const k of Object.keys(over || {})) {
    if (isPlainObject(base[k]) && isPlainObject(over[k])) out[k] = deepMerge(base[k], over[k]);
    else out[k] = over[k];
  }
  return out;
}

function load() {
  const explicit = process.env.BUSINESS_CONFIG;
  const candidate = explicit || path.join(__dirname, '..', 'config', 'business.json');
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(candidate, 'utf8'));
  } catch (e) {
    if (explicit) console.warn('BUSINESS_CONFIG points at unreadable file, using defaults:', e.message);
  }
  return deepMerge(DEFAULTS, file);
}

const biz = load();

/** Fill {placeholders} in a template string. Unknown keys are left as-is. */
function fill(template, vars) {
  const all = Object.assign(
    {
      businessName: biz.businessName,
      assistantName: biz.assistantName,
      ownerName: biz.ownerName,
      serviceArea: biz.serviceArea,
      customerNoun: biz.customerNoun,
      approverNoun: biz.approverNoun,
      timezoneLabel: biz.timezoneLabel,
    },
    vars || {}
  );
  return String(template || '').replace(/\{(\w+)\}/g, (m, k) => (all[k] !== undefined ? all[k] : m));
}

module.exports = Object.assign({ fill }, biz);
