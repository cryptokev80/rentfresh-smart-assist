'use strict';

/**
 * Tiny JSON file store. Zero dependencies, good enough for the concierge MVP.
 * Data file: $DATA_DIR/data.json (defaults to the repo root). On Railway,
 * mount a volume and set DATA_DIR to its path so tickets survive redeploys.
 */

const fs = require('fs');
const path = require('path');
const biz = require('./config');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

function blank() {
  return { conversations: {}, tickets: [], ticketSeq: 1000, landlordPolicies: {}, tradeProfiles: {} };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    return blank();
  }
}

function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function getConversation(phone, name) {
  const data = load();
  if (!data.conversations[phone]) {
    data.conversations[phone] = {
      phone,
      name: name || 'Unknown',
      state: 'idle', // idle | awaiting_info
      issue: null, // { trade, urgency, title, summary, questions, firstMessage, photoIds }
      exchanges: 0,
      messages: [],
      updatedAt: new Date().toISOString(),
    };
    save(data);
  } else if (name && data.conversations[phone].name === 'Unknown') {
    data.conversations[phone].name = name;
    save(data);
  }
  return data.conversations[phone];
}

function updateConversation(phone, patch) {
  const data = load();
  const convo = data.conversations[phone];
  if (!convo) return null;
  Object.assign(convo, patch, { updatedAt: new Date().toISOString() });
  save(data);
  return convo;
}

function addMessage(phone, direction, type, body, opts) {
  const data = load();
  const convo = data.conversations[phone] || {
    phone, name: 'Unknown', state: 'idle', issue: null, exchanges: 0, messages: [],
  };
  const msg = {
    direction, // 'in' | 'out'
    type, // 'text' | 'image' | 'note'
    body: body || '',
    at: new Date().toISOString(),
    // Outbound tracking (set when we send via WhatsApp):
    waId: (opts && opts.waId) || null, // WhatsApp message id (wamid.*)
    status: (opts && opts.status) || null, // sent | delivered | read | failed
    statusError: (opts && opts.statusError) || null,
  };
  convo.messages.push(msg);
  if (convo.messages.length > 200) convo.messages = convo.messages.slice(-200);
  convo.updatedAt = new Date().toISOString();
  data.conversations[phone] = convo;
  save(data);
  return convo.messages.length - 1; // index of the stored message
}

function updateMessage(phone, index, patch) {
  const data = load();
  const convo = data.conversations[phone];
  if (!convo || !convo.messages[index]) return null;
  Object.assign(convo.messages[index], patch);
  convo.updatedAt = new Date().toISOString();
  save(data);
  return convo.messages[index];
}

function findMessageByWaId(waId) {
  if (!waId) return null;
  const data = load();
  for (const phone of Object.keys(data.conversations)) {
    const messages = data.conversations[phone].messages || [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].waId === waId) return { phone, index: i, message: messages[i] };
    }
  }
  return null;
}

function createTicket(fields) {
  const data = load();
  data.ticketSeq += 1;
  const ticket = {
    id: 'RF-' + data.ticketSeq,
    status: 'new', // new | dispatched | closed
    kind: fields.kind || 'maintenance', // maintenance | lead
    createdAt: new Date().toISOString(),
    phone: fields.phone,
    tenantName: fields.tenantName || 'Unknown',
    trade: fields.trade || 'general',
    urgency: fields.urgency || 'routine',
    summary: fields.summary || '',
    photoIds: fields.photoIds || [],
    emergencyRule: fields.emergencyRule || null,
    // Landlord loop (Smart Membership): landlord pays, tenant reports.
    landlordName: fields.landlordName || null,
    landlordPhone: fields.landlordPhone || null,
    unit: fields.unit || null,
    landlordNotifiedAt: null,
    landlordDecision: null, // approved | declined | auto-approved
    awaitingLandlord: false,
    quote: fields.quote || null, // { labor, materials, total }
    address: fields.address || null, // tenant property address for dispatch
  };
  data.tickets.unshift(ticket);
  save(data);
  return ticket;
}

function listTickets() {
  return load().tickets;
}

function getTicket(id) {
  return load().tickets.find((t) => t.id === id) || null;
}

function updateTicket(id, patch) {
  const data = load();
  const ticket = data.tickets.find((t) => t.id === id);
  if (!ticket) return null;
  Object.assign(ticket, patch);
  save(data);
  return ticket;
}

function findAwaitingLandlordTicket(landlordPhone) {
  return (
    load().tickets.find((t) => t.awaitingLandlord && t.landlordPhone === landlordPhone) ||
    null
  );
}

/** All tickets awaiting this landlord's decision (digits-normalized match). */
function findAwaitingLandlordTicketsByLandlord(landlordPhone) {
  const digits = String(landlordPhone || '').replace(/\D/g, '');
  if (!digits) return [];
  return load().tickets.filter(
    (t) => t.awaitingLandlord && String(t.landlordPhone || '').replace(/\D/g, '') === digits
  );
}

/** True when the sender is a landlord we know: has a policy, or is attached to a ticket. */
function isKnownLandlord(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return false;
  const data = load();
  if (data.landlordPolicies && data.landlordPolicies[digits]) return true;
  return (data.tickets || []).some(
    (t) => String(t.landlordPhone || '').replace(/\D/g, '') === digits
  );
}

// Landlord properties come from signup: each unit lists its address and the
// tenant's name/phone. Match an incoming tenant phone to its property so the
// ticket gets the address (for location-based dispatch) automatically.
function findPropertyByTenantPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const data = load();
  const policies = data.landlordPolicies || {};
  for (const [llPhone, pol] of Object.entries(policies)) {
    for (const p of (pol.properties || [])) {
      if (String(p.tenantPhone || '').replace(/\D/g, '') === digits) {
        return {
          landlordPhone: llPhone,
          landlordName: pol.name || null,
          autoApproveLimit: pol.autoApproveLimit || biz.autoApproveDefault,
          unit: p.unit || null,
          address: p.address || null,
          tenantName: p.tenantName || null,
        };
      }
    }
  }
  return null;
}

function findOpenTicketByPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  return (
    load().tickets.find(
      (t) =>
        (t.status === 'new' || t.status === 'dispatched') &&
        (String(t.phone || '').replace(/\D/g, '') === digits ||
          String(t.landlordPhone || '').replace(/\D/g, '') === digits)
    ) || null
  );
}

function listLandlords() {
  const data = load();
  return Object.entries(data.landlordPolicies || {}).map(([phone, pol]) => ({
    phone,
    name: pol.name || null,
    autoApproveLimit: pol.autoApproveLimit || biz.autoApproveDefault,
    properties: pol.properties || [],
  }));
}

function setTicketStatus(id, status) {
  const data = load();
  const ticket = data.tickets.find((t) => t.id === id);
  if (!ticket) return null;
  if (!['new', 'dispatched', 'closed'].includes(status)) return null;
  ticket.status = status;
  save(data);
  return ticket;
}

function listConversations() {
  const data = load();
  return Object.values(data.conversations)
    .map((c) => ({
      phone: c.phone,
      name: c.name,
      state: c.state,
      needsHuman: !!c.needsHuman,
      updatedAt: c.updatedAt,
      lastMessage: c.messages.length ? c.messages[c.messages.length - 1] : null,
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

function getMessages(phone) {
  const data = load();
  const convo = data.conversations[phone];
  return convo ? convo.messages : [];
}

// Per-landlord spending policy. Default comes from config (ProQue: $350);
// individual landlords can override. Keyed by landlord phone (digits only).
function getLandlordPolicy(phone) {
  const data = load();
  const all = data.landlordPolicies || {};
  return Object.assign({ autoApproveLimit: biz.autoApproveDefault }, all[String(phone || '')] || {});
}

function setLandlordPolicy(phone, patch) {
  const data = load();
  data.landlordPolicies = data.landlordPolicies || {};
  const key = String(phone || '');
  data.landlordPolicies[key] = Object.assign({}, data.landlordPolicies[key], patch);
  save(data);
  return getLandlordPolicy(key);
}

// Trade profiles for location-based dispatch. Each profile:
// { id, name, trade, phone, serviceAreas: ['Toronto', 'M4B', ...] }.
// Keyed by id.
function getTradeProfiles() {
  const data = load();
  return Object.values(data.tradeProfiles || {});
}

function saveTradeProfile(profile) {
  const data = load();
  data.tradeProfiles = data.tradeProfiles || {};
  const p = Object.assign({}, profile);
  if (!p.id) p.id = 'trade-' + Date.now().toString(36);
  if (!Array.isArray(p.serviceAreas)) p.serviceAreas = [];
  data.tradeProfiles[p.id] = p;
  save(data);
  return p;
}

// One-shot test-data cleanup (used before real tenants go live).
// Returns counts of what was removed. Landlord policies are business config,
// not test data, so they survive the wipe.
function clearAllData() {
  const data = load();
  const cleared = {
    conversations: Object.keys(data.conversations).length,
    tickets: data.tickets.length,
  };
  const kept = blank();
  kept.landlordPolicies = data.landlordPolicies || {};
  save(kept);
  return cleared;
}

module.exports = {
  getConversation,
  updateConversation,
  addMessage,
  updateMessage,
  findMessageByWaId,
  createTicket,
  listTickets,
  getTicket,
  updateTicket,
  findAwaitingLandlordTicket,
  findAwaitingLandlordTicketsByLandlord,
  findOpenTicketByPhone,
  findPropertyByTenantPhone,
  listLandlords,
  isKnownLandlord,
  setTicketStatus,
  listConversations,
  getMessages,
  getLandlordPolicy,
  setLandlordPolicy,
  getTradeProfiles,
  saveTradeProfile,
  clearAllData,
};
