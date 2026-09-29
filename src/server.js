'use strict';

/**
 * ProQue — maintenance triage concierge.
 * One company number, bot handles everything:
 *   emergency  -> safety instructions + emergency ticket + human flagged
 *   lead       -> capture details + lead ticket + Kevin notified
 *   maintenance-> triage questions -> maintenance ticket
 *   human please -> flagged for Kevin
 * Kevin reviews everything in the inbox and dispatches manually.
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const biz = require('./config');
const store = require('./store');
const wa = require('./whatsapp');
const triage = require('./triage');
const msgStatus = require('./status');
const alerts = require('./alerts');
const policies = require('./policies');
const relay = require('./relay');

const app = express();
// Capture the raw body so we can verify Meta's X-Hub-Signature-256.
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';
const PORT = process.env.PORT || 3000;
const COMMIT = process.env.RAILWAY_GIT_COMMIT_SHA || null;

// Structured event log (JSON lines) for Railway logs.
function logEvent(obj) {
  try {
    console.log(JSON.stringify(Object.assign({ ts: new Date().toISOString() }, obj)));
  } catch (e) {
    console.log('[logEvent failed]', e.message);
  }
}

// Flag a conversation for Kevin and email him, but only on the false -> true
// transition: one escalation, one alert. Never throws: alerting must not
// break message handling.
async function flagForKevin(phone, reason) {
  let newly = false;
  try {
    newly = alerts.flagNeedsHuman(store, phone, reason);
  } catch (e) {
    console.error('flag error:', e.message);
    return;
  }
  if (!newly) return;
  try {
    const r = await alerts.sendNeedsHumanAlert(store, phone, reason);
    logEvent({ event: 'alert', kind: 'needs_human', to: phone, reason, sent: r.sent, skipped: r.reason || null });
  } catch (e) {
    console.error('alert error:', e.message);
    logEvent({ event: 'alert', kind: 'needs_human', to: phone, reason, sent: false, error: e.message });
  }
}

// A reply Meta reports as failed: email Kevin. Each failure is distinct,
// so this alerts every time rather than only on transition.
function onMessageFailed(phone, error) {
  alerts
    .sendNeedsHumanAlert(store, phone, 'a reply failed to send (' + (error || 'unknown error') + ')')
    .then((r) => logEvent({ event: 'alert', kind: 'needs_human', to: phone, reason: 'failed_status', sent: r.sent, skipped: r.reason || null }))
    .catch((e) => logEvent({ event: 'alert', kind: 'needs_human', to: phone, reason: 'failed_status', sent: false, error: e.message }));
}

// --- Webhook signature verification (Meta X-Hub-Signature-256) ----------------
function validSignature(req) {
  if (!APP_SECRET) return true; // not configured: enforced once the secret is set
  const sig = req.headers['x-hub-signature-256'] || '';
  if (!sig.startsWith('sha256=')) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody || '').digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- Simple in-memory rate limiter ----------------------------------------------
const buckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) b = { count: 0, reset: now + windowMs };
  b.count += 1;
  buckets.set(key, b);
  if (buckets.size > 5000) buckets.clear(); // safety valve
  return b.count > max;
}

// Optional HTTP Basic Auth for the inbox + API. Set INBOX_USER/INBOX_PASS.
function auth(req, res, next) {
  const user = process.env.INBOX_USER;
  const pass = process.env.INBOX_PASS;
  if (!user || !pass) return next();
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [u, p] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
    if (u === user && p === pass) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="smart-assist"');
  return res.status(401).send('Auth required');
}

// --- Meta webhook verification ------------------------------------------------
app.get('/webhook', (req, res) => {
  if (!VERIFY_TOKEN) {
    console.error('webhook verify attempted but WHATSAPP_VERIFY_TOKEN is not set');
    return res.sendStatus(403);
  }
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- Incoming WhatsApp messages -----------------------------------------------
app.post('/webhook', (req, res) => {
  if (!validSignature(req)) {
    logEvent({ event: 'webhook_rejected', reason: 'bad_signature' });
    return res.sendStatus(403);
  }
  res.sendStatus(200); // ack Meta fast, process after
  (async () => {
    try {
      for (const entry of req.body.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value || {};
          for (const msg of value.messages || []) {
            await handleMessage(value, msg).catch((e) => console.error('handle error:', e.message));
          }
          for (const st of value.statuses || []) {
            try {
              msgStatus.applyStatus(store, logEvent, msgStatus.normalizeStatus(st), onMessageFailed);
            } catch (e) {
              console.error('status error:', e.message);
            }
          }
        }
      }
    } catch (err) {
      console.error('webhook error:', err.message);
    }
  })();
});

async function reply(to, text, opts) {
  // ProQue triages 24/7: every message gets an answer right away, no
  // business-hours note. Emergencies escalate immediately.
  const idx = store.addMessage(to, 'out', 'text', text, opts);
  try {
    const result = await wa.sendText(to, text);
    const waId = result && result.messages && result.messages[0] ? result.messages[0].id : null;
    if (waId) store.updateMessage(to, idx, { waId, status: 'sent' });
    logEvent({ event: 'outbound', to, ok: true, dryRun: !!(result && result.dryRun), waId: waId || null });
    return true;
  } catch (err) {
    store.updateMessage(to, idx, { status: 'failed', statusError: err.message });
    await flagForKevin(to, 'a reply failed to send');
    logEvent({ event: 'outbound', to, ok: false, error: err.message });
    return false;
  }
}

// Outbound photo/video (relay forwards). Mirrors reply(): logs first, then
// sends; on failure the stored message is marked failed and Kevin is
// flagged. Returns true only when Meta accepted the message.
async function replyMedia(to, kind, buffer, mimeType, caption, opts) {
  const idx = store.addMessage(to, 'out', kind, caption ? '[' + kind + '] ' + caption : '[' + kind + ']', opts);
  try {
    const up = await wa.uploadMedia(buffer, mimeType);
    const mediaId = up && up.id;
    if (!mediaId) throw new Error('media upload returned no id');
    const result = kind === 'video'
      ? await wa.sendVideo(to, mediaId, caption || '')
      : await wa.sendImage(to, mediaId, caption || '');
    const waId = result && result.messages && result.messages[0] ? result.messages[0].id : null;
    if (waId) store.updateMessage(to, idx, { waId, status: 'sent' });
    logEvent({ event: 'outbound', to, kind, ok: true, dryRun: !!(result && result.dryRun), waId: waId || null });
    return true;
  } catch (err) {
    store.updateMessage(to, idx, { status: 'failed', statusError: err.message });
    await flagForKevin(to, 'a ' + kind + ' failed to send');
    logEvent({ event: 'outbound', to, kind, ok: false, error: err.message });
    return false;
  }
}

async function handleMessage(value, msg) {
  const from = msg.from;
  if (rateLimited('sender:' + from, 20, 60 * 1000)) {
    logEvent({ event: 'rate_limited', from });
    return;
  }
  const contact = value.contacts && value.contacts[0];
  const name = (contact && contact.profile && contact.profile.name) || 'Unknown';
  const convo = store.getConversation(from, name);
  // ProQue triages 24/7: the bot always answers and collects details.
  // Emergencies escalate immediately.

  if (msg.type === 'text' && msg.text && msg.text.body) {
    store.addMessage(from, 'in', 'text', msg.text.body);
    await handleText(from, convo, msg.text.body);
  } else if ((msg.type === 'image' && msg.image) || (msg.type === 'video' && msg.video)) {
    await handleMedia(from, convo, msg);
  } else {
    store.addMessage(from, 'in', msg.type || 'unknown', '');
    await reply(from, biz.fill(biz.messaging.unknownMedia));
  }
}

async function handleText(from, convo, text) {
  // 0. Operator commands from Kevin's own number (biz.ownerPhone).
  // Authenticated by sender phone; never triaged as a tenant.
  if (isOperator(from)) {
    const handled = await handleOperatorCommand(from, text);
    if (handled) return;
  }

  // 1. Emergency always wins, regardless of intent.
  const result = triage.classify(text);
  logEvent({
    event: 'inbound', from, kind: 'text',
    trade: result.trade, urgency: result.urgency,
    emergency: !!result.emergency, rule: result.ruleId || null,
  });
  if (result.emergency) {
    await reply(from, result.advice);
    let ticket = store.createTicket({
      phone: from, tenantName: convo.name, kind: 'maintenance',
      trade: result.trade, urgency: 'emergency',
      summary: result.summary, emergencyRule: result.ruleId,
    });
    ticket = enrichTicketFromProperty(ticket) || ticket;
    await reply(from, biz.fill(biz.messaging.emergencyTicketCreated, { ticketId: ticket.id }));
    store.updateConversation(from, { state: 'idle', issue: null, lead: null, exchanges: 0 });
    await flagForKevin(from, 'emergency ticket ' + ticket.id + ' created');
    policies.startEmergencyDispatch(store, ticket);
    return;
  }

  // 1b. A known trade replying (e.g. to a job card): never triage a pro as
  // a tenant. Confirmations and status updates go to Kevin, as today;
  // questions and detail requests relay to the tenant on the active ticket.
  const proProfile = policies.findProByPhone(store, from);
  if (proProfile) {
    const relayTicket = store.findRelayTicketByProPhone(from);
    if (relayTicket && relay.tradeTargetsTenant(text)) {
      const ok = await forwardRelayText('pro', relayTicket, proProfile, from, text);
      if (ok) await reply(from, relay.relayAck('pro', proProfile));
      return;
    }
    await flagForKevin(from, proProfile.name + ' replied: ' + String(text).slice(0, 140));
    const firstName = String(proProfile.name || '').split(' ')[0] || 'there';
    await reply(from, 'Thanks ' + firstName + ', Kevin has your message and will confirm shortly.');
    return;
  }

  // 1c. A bare greeting ("hi", "hello") opens the conversation. It must
  // never be mistaken for a landlord decision or anything else: answer
  // warmly, and nudge about a pending quote decision if they have one.
  if (triage.isGreeting(text)) {
    const awaiting = store.findAwaitingLandlordTicketsByLandlord(from) || [];
    let msg = biz.fill(biz.messaging.greeting);
    if (awaiting.length) {
      const t0 = awaiting[0];
      const q = t0.quote || {};
      msg += ' You have a quote' + (q.total ? ' of ' + triage.fmtCAD(q.total) : '') +
        ' awaiting your decision on ticket ' + t0.id + '. Reply APPROVE or DECLINE.';
    }
    store.updateConversation(from, { state: 'idle', issue: null, lead: null, exchanges: 0 });
    await reply(from, msg);
    return;
  }

  // 2. Landlord changing their NTE cap by text ("set my cap to 500").
  // Only known landlords; everyone else falls through to normal handling.
  // Checked before the approve/decline flow so a cap change never gets
  // misread as a decision on an awaiting ticket.
  const capChange = triage.parseCapChange(text);
  if (capChange && store.isKnownLandlord(from)) {
    await handleCapChange(from, capChange);
    return;
  }

  // 3. Landlord replying to a summary we sent (approve / decline).
  // Checked after emergency so a safety report from a landlord still wins.
  const landlordTicket = store.findAwaitingLandlordTicket(from);
  if (landlordTicket) {
    await handleLandlordReply(from, convo, text, landlordTicket);
    return;
  }

  // 4. Explicit human handoff.
  if (triage.wantsHuman(text)) {
    await reply(from, biz.fill(biz.messaging.humanHandoff));
    await flagForKevin(from, 'human handoff requested');
    return;
  }

  // 4. Continuing an in-progress flow.
  if (convo.state === 'awaiting_info' && convo.issue) {
    // A question mid-flow ("will the plumber contact me?") is not the
    // timing answer: answer it conversationally, then re-ask the timing
    // question without advancing the flow.
    if (triage.isFollowupOnTicket(text)) {
      await reply(from, triage.midFlowQuestionReply(convo.issue.trade));
      return;
    }
    return finishTriage(from, convo, text);
  }
  if (convo.state === 'awaiting_lead' && convo.lead) return finishLead(from, convo, text);
  if (convo.state === 'awaiting_address' && convo.ticketId) {
    // The tenant was asked for the property address. If this looks like a
    // brand-new issue instead, drop the address wait and handle it fresh.
    const cls = triage.classify(text);
    const looksNew = /[?]/.test(text) || triage.isLeadInquiry(text) ||
      cls.trade !== 'general' || !!cls.emergency;
    if (!looksNew) return finishAddress(from, convo, text);
    store.updateConversation(from, { state: 'idle', ticketId: null, issue: null, lead: null, exchanges: 0 });
  }

  // 4b. Simple acknowledgment ("ok", "thanks") with no active flow:
  // close politely instead of starting a brand-new triage.
  if (triage.isAcknowledgment(text)) {
    await reply(from, "You're welcome. If anything else comes up, just message me here.");
    return;
  }

  // 5. New conversation: route by intent.
  if (triage.isLeadInquiry(text)) {
    store.updateConversation(from, {
      state: 'awaiting_lead', exchanges: 1,
      lead: { firstMessage: text },
    });
    await reply(from, triage.leadQuestionsMessage());
    return;
  }

  // 6. General business inquiry (greeting, "what do you do", hours,
  // contact info): proper reply, no ticket. Anything unrecognized still
  // falls through to maintenance triage below, which is the safer default
  // for a maintenance bot since Kevin reviews every conversation anyway.
  if (triage.isGeneralInquiry(text)) {
    store.updateConversation(from, { state: 'idle', issue: null, lead: null, exchanges: 0 });
    await reply(from, triage.generalReplyMessage());
    return;
  }

  // 6b. Follow-up on an open ticket: the tenant asks a question or checks
  // status instead of reporting something new. On an actively dispatched
  // ticket the pro gets it directly through the relay; otherwise answer in
  // the ticket's context instead of starting a fresh triage.
  const openTicket = store.findOpenTicketByPhone(from);
  if (openTicket && triage.isFollowupOnTicket(text)) {
    const relayTicket = store.findRelayTicketByTenantPhone(from);
    if (relayTicket) {
      const pro = policies.findProByPhone(store, relayTicket.assignedProPhone);
      if (pro) {
        const ok = await forwardRelayText('tenant', relayTicket, pro, from, text);
        if (ok) await reply(from, relay.relayAck('tenant', pro));
        return;
      }
    }
    await handleTicketFollowup(from, openTicket, text);
    return;
  }

  // 7. Default: maintenance triage.
  store.updateConversation(from, {
    state: 'awaiting_info', exchanges: 1,
    issue: {
      trade: result.trade, urgency: result.urgency, title: result.title,
      summary: result.summary, questions: result.questions,
      firstMessage: text, photoIds: [],
    },
  });
  await reply(from, triage.questionsMessage(result));
}

function ticketStatusLabel(ticket) {
  if (ticket.status === 'dispatched') return 'assigned to a pro';
  if (ticket.awaitingLandlord) return "waiting on the landlord's approval";
  return 'logged and being scheduled';
}

async function handleTicketFollowup(from, ticket, text) {
  const lower = String(text || '').toLowerCase();
  // "Will the plumber contact me?" Answer from the ticket's actual state.
  if (/contact me|call me|called me|get in touch|reach out|someone coming|is coming/.test(lower)) {
    const person = triage.tradePersonLabel(ticket.trade);
    if (ticket.status === 'dispatched' && ticket.assignedProPhone) {
      const pro = policies.findProByPhone(store, ticket.assignedProPhone);
      const who = pro ? relay.proLabel(pro) : 'The ' + person;
      await reply(from, 'Yes. ' + who + ' has ticket ' + ticket.id + ' and will contact you to schedule the visit.');
    } else {
      await reply(
        from,
        'Not yet. Ticket ' + ticket.id + ' is ' + ticketStatusLabel(ticket) +
          '. Once the quote is approved, the ' + person + ' will contact you to schedule the visit.'
      );
    }
    return;
  }
  if (/any update|status|when will|when is|has anyone|did anyone/.test(lower)) {
    await reply(
      from,
      'Ticket ' + ticket.id + ' is ' + ticketStatusLabel(ticket) +
        '. The pro will confirm a time with you.'
    );
    return;
  }
  await reply(
    from,
    'Noted on ticket ' + ticket.id + '. ' +
      triage.interimAdviceFor(ticket.trade) +
      ' The pro will confirm a time with you.'
  );
}

async function finishTriage(from, convo, text) {
  const issue = convo.issue;
  const combined = issue.firstMessage + '\nTenant added: ' + text;
  const result = triage.classify(combined);
  // The tenant just answered the timing question (ASAP vs scheduled):
  // their answer refines the urgency.
  const urgency = triage.parseUrgencyAnswer(text) || result.urgency;
  let ticket = store.createTicket({
    phone: from, tenantName: convo.name, kind: 'maintenance',
    trade: result.trade, urgency,
    summary: result.summary, photoIds: issue.photoIds || [],
  });
  ticket = enrichTicketFromProperty(ticket) || ticket;
  let msg = triage.confirmationMessage(ticket, !ticket.address);
  if (result.diyTip) msg += '\n\nSafe to try in the meantime: ' + result.diyTip;
  if (!ticket.address) {
    // No address on file (unknown tenant, no landlord property match):
    // ask for it now so dispatch can match the right service area.
    store.updateConversation(from, { state: 'awaiting_address', ticketId: ticket.id, issue: null, exchanges: 0 });
    msg += '\n\nOne more thing: what is the property address?';
  } else {
    store.updateConversation(from, { state: 'idle', issue: null, exchanges: 0 });
  }
  await reply(from, msg);
}

async function finishAddress(from, convo, text) {
  const ticket = store.getTicket(convo.ticketId);
  const addr = String(text || '').trim().slice(0, 200);
  if (ticket && addr) store.updateTicket(ticket.id, { address: addr });
  store.updateConversation(from, { state: 'idle', ticketId: null, exchanges: 0 });
  await reply(
    from,
    'Got it, ' + addr + ' is noted on ticket ' + (ticket ? ticket.id : '') +
      '. We will be in touch shortly to schedule the visit.'
  );
}

async function finishLead(from, convo, text) {
  const ticket = store.createTicket({
    phone: from, tenantName: convo.name, kind: 'lead',
    trade: 'general', urgency: 'routine',
    summary: 'New lead: "' + convo.lead.firstMessage + '" Details: "' + text + '"',
  });
  store.updateConversation(from, { state: 'idle', lead: null, exchanges: 0 });
  await flagForKevin(from, 'new landlord lead (' + ticket.id + ')');
  await reply(
    from,
    biz.fill(biz.messaging.leadReceived, { ticketId: ticket.id })
  );
}

/**
 * Match the ticket's tenant phone against landlord signup properties.
 * When matched, the ticket picks up the unit address (for location-based
 * dispatch), the landlord link, and the landlord's NTE cap automatically.
 */
function enrichTicketFromProperty(ticket) {
  if (!ticket || ticket.address) return ticket;
  const prop = store.findPropertyByTenantPhone(ticket.phone);
  if (!prop) return ticket;
  return store.updateTicket(ticket.id, {
    address: prop.address,
    unit: prop.unit || ticket.unit,
    landlordPhone: prop.landlordPhone || ticket.landlordPhone,
    landlordName: prop.landlordName || ticket.landlordName,
    autoApproveLimit: prop.autoApproveLimit || ticket.autoApproveLimit,
    tenantName:
      ticket.tenantName && ticket.tenantName !== 'Unknown'
        ? ticket.tenantName
        : prop.tenantName || ticket.tenantName,
  });
}

/** Landlord texted a new NTE cap. Update it, confirm, and re-evaluate any
 *  awaiting tickets that now fit under the raised cap. */
async function handleCapChange(from, newCap) {
  const digits = String(from).replace(/\D/g, '');
  store.setLandlordPolicy(digits, { autoApproveLimit: newCap });
  logEvent({ event: 'cap_change', from, newCap });
  await reply(from, biz.fill(biz.messaging.capUpdated, { limit: triage.fmtCAD(newCap) }));
  await flagForKevin(from, 'landlord set NTE cap to $' + newCap);
  const awaiting = store.findAwaitingLandlordTicketsByLandlord(digits);
  for (const t of awaiting) {
    const total = t.quote && t.quote.total;
    if (!total || total > newCap) continue;
    store.updateTicket(t.id, {
      landlordDecision: 'auto-approved',
      awaitingLandlord: false,
      autoApproveLimit: newCap,
    });
    await flagForKevin(from, 'cap raised to $' + newCap + ': ' + t.id + ' auto-approved');
    if (t.phone && t.phone !== from) {
      await reply(t.phone, biz.fill(biz.messaging.capRaisedTenantNote));
    }
  }
}

function parseMoney(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

// Pro dispatch: once a quote is approved (landlord sign-off or auto-approved
// under the NTE cap), the best-matching trade gets the job card on WhatsApp.
// Matching is by trade, ranked by service-area coverage of the tenant's
// address. Kevin still gets his alert; the pro replying is routed to Kevin,
// never triaged as a tenant.
async function dispatchApprovedTicket(ticket) {
  const flow = ticket.landlordDecision === 'auto-approved' ? 'nte-auto' : 'nte-approved';
  // Never send a trade out blind. The job card must carry the property
  // address and tenant contact; without them the trade cannot accept the
  // job informed. Hold the dispatch and tell Kevin what's missing instead
  // of sending a half-empty card. Kevin re-runs dispatch by setting the
  // quote again once the info is on file.
  const missing = [];
  if (!ticket.address) missing.push('property address');
  if (!ticket.phone) missing.push('tenant phone');
  if (missing.length) {
    const record = {
      flow,
      candidates: [],
      status: 'blocked',
      dispatchedAt: new Date().toISOString(),
      proId: null,
      proName: null,
      reason: 'missing ' + missing.join(' and '),
    };
    store.updateTicket(ticket.id, { dispatch: record });
    await flagForKevin(
      ticket.phone || 'inbox',
      'cannot dispatch ' + ticket.id + ': missing ' + missing.join(' and ') +
        ' - job card held, nothing sent to any trade'
    );
    return record;
  }
  const candidates = policies.findCandidateTrades(store, ticket);
  const pro = candidates[0] || null;
  const record = {
    flow,
    candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
    status: pro ? 'sending' : 'no-trade',
    dispatchedAt: new Date().toISOString(),
    proId: pro ? pro.id : null,
    proName: pro ? pro.name : null,
  };
  if (pro && pro.phone) {
    store.getConversation(pro.phone, pro.name);
    const sent = await reply(pro.phone, triage.proJobCardMessage(ticket, pro));
    // Only mark dispatched when Meta actually accepted the message. A
    // failure (e.g. 131047 outside the 24h window) must not show as
    // dispatched in the inbox.
    record.status = sent ? 'dispatched' : 'failed';
    if (!sent) record.error = 'WhatsApp send failed; see alert email for the Meta error';
    store.updateTicket(ticket.id, {
      dispatch: record,
      status: sent ? 'dispatched' : ticket.status,
      // Link the trade to the ticket so the trade<->tenant relay knows who
      // is on the job. The relay itself only goes live on a real dispatch.
      assignedProPhone: pro.phone,
      assignedProId: pro.id || null,
      assignedProName: pro.name || null,
    });
    await flagForKevin(
      pro.phone,
      (sent ? 'dispatched ' : 'FAILED to dispatch ') + ticket.id + ' to ' + pro.name
    );
  } else {
    await flagForKevin(
      ticket.phone || 'inbox',
      'no trade on file for ' + ticket.id + ' (' + ticket.trade + '): Kevin dispatches manually'
    );
  }
  return record;
}

// ---------------------------------------------------------------------------
// Trade <-> tenant relay: forward a text message from one side of an
// actively dispatched ticket to the other. Returns true only when Meta
// accepted the forward. On failure the sender is told honestly; Kevin is
// flagged by reply()'s failure path. No relayed state is marked on the
// ticket on failure.
// ---------------------------------------------------------------------------
async function forwardRelayText(fromRole, ticket, pro, senderPhone, text) {
  if (!relay.isRelayActive(ticket, pro.phone)) return false;
  const to = relay.relayRecipient(fromRole, ticket, pro);
  if (!to) {
    logEvent({ event: 'relay', ticket: ticket.id, from: fromRole, kind: 'text', ok: false, reason: 'no_recipient' });
    return false;
  }
  const body = relay.buildRelayText(fromRole, ticket, pro, text);
  const ok = await reply(to, body, { relay: relay.relayTag(fromRole, ticket) });
  logEvent({ event: 'relay', ticket: ticket.id, from: fromRole, to, kind: 'text', ok });
  if (!ok) await reply(senderPhone, relay.relayFailureNotice('text'));
  return ok;
}

// Forward a photo/video across the relay. The media is downloaded from
// Meta, re-uploaded, and sent to the other side with a prefixed caption.
async function forwardRelayMedia(fromRole, ticket, pro, senderPhone, kind, buffer, mimeType, caption) {
  if (!relay.isRelayActive(ticket, pro.phone)) return false;
  const to = relay.relayRecipient(fromRole, ticket, pro);
  if (!to || !buffer || !buffer.length) {
    logEvent({ event: 'relay', ticket: ticket.id, from: fromRole, kind, ok: false, reason: !to ? 'no_recipient' : 'empty_media' });
    return false;
  }
  const cap = relay.buildRelayCaption(fromRole, ticket, pro, kind, caption);
  const ok = await replyMedia(to, kind, buffer, mimeType, cap, { relay: relay.relayTag(fromRole, ticket) });
  logEvent({ event: 'relay', ticket: ticket.id, from: fromRole, to, kind, ok });
  if (!ok) await reply(senderPhone, relay.relayFailureNotice(kind));
  return ok;
}

async function handleLandlordReply(from, convo, text, ticket) {
  const decision = triage.parseLandlordDecision(text);
  if (decision === 'approved') {
    store.updateTicket(ticket.id, { landlordDecision: 'approved', awaitingLandlord: false });
    await flagForKevin(from, 'landlord approved ' + ticket.id); // Kevin sees it and dispatches
    await reply(from, biz.fill(biz.messaging.landlordApproved, { ticketId: ticket.id }));
    if (ticket.phone && ticket.phone !== from) {
      await reply(ticket.phone, 'Good news: your landlord approved the repair. We will be in touch shortly to schedule the visit.');
    }
    await dispatchApprovedTicket(store.getTicket(ticket.id));
    return;
  }
  if (decision === 'declined') {
    store.updateTicket(ticket.id, { landlordDecision: 'declined', awaitingLandlord: false });
    await flagForKevin(from, 'landlord declined ' + ticket.id);
    await reply(from, biz.fill(biz.messaging.landlordDeclined, { ticketId: ticket.id }));
    if (ticket.phone && ticket.phone !== from) {
      await reply(ticket.phone, 'Your landlord asked us to hold for now. Kevin will follow up if anything changes.');
    }
    return;
  }
  // Ambiguous reply: don't guess on money, let Kevin handle it.
  await flagForKevin(from, 'landlord reply needs review (' + ticket.id + ')');
  await reply(from, biz.fill(biz.messaging.landlordAmbiguous));
}

// Photos and videos. On an actively dispatched ticket the media belongs to
// the other side of the job and is forwarded through the relay. Otherwise
// photos keep today's AI-triage behavior; video outside a relay is still
// unsupported (same unknownMedia reply as before).
async function handleMedia(from, convo, msg) {
  const kind = msg.type === 'video' ? 'video' : 'image';
  const media = msg.image || msg.video || {};
  const caption = media.caption || '';
  const label = '[' + kind + ']' + (caption ? ' ' + caption : '');
  const mimeType = media.mime_type || (kind === 'video' ? 'video/mp4' : 'image/jpeg');

  // Trade sending media on their active ticket -> forward to the tenant.
  const proProfile = policies.findProByPhone(store, from);
  if (proProfile) {
    const relayTicket = store.findRelayTicketByProPhone(from);
    if (relayTicket) {
      store.addMessage(from, 'in', kind, label);
      const buffer = await wa.downloadMedia(media.id);
      if (!buffer) {
        await reply(from, 'I could not fetch that ' + (kind === 'video' ? 'video' : 'photo') + '. Please try sending it again.');
        return;
      }
      const ok = await forwardRelayMedia('pro', relayTicket, proProfile, from, kind, buffer, mimeType, caption);
      if (ok) await reply(from, relay.relayAck('pro', proProfile));
      return;
    }
  } else {
    // Tenant sending media on their actively dispatched ticket -> the pro.
    const relayTicket = store.findRelayTicketByTenantPhone(from);
    if (relayTicket) {
      const pro = policies.findProByPhone(store, relayTicket.assignedProPhone);
      if (pro) {
        store.addMessage(from, 'in', kind, label);
        const buffer = await wa.downloadMedia(media.id);
        if (!buffer) {
          await reply(from, 'I could not fetch that ' + (kind === 'video' ? 'video' : 'photo') + '. Please try sending it again.');
          return;
        }
        const ok = await forwardRelayMedia('tenant', relayTicket, pro, from, kind, buffer, mimeType, caption);
        if (ok) await reply(from, relay.relayAck('tenant', pro));
        return;
      }
    }
  }

  // No active relay: photos keep today's behavior; video was never handled.
  if (kind === 'video') {
    store.addMessage(from, 'in', 'video', label);
    await reply(from, biz.fill(biz.messaging.unknownMedia));
    return;
  }
  await handleImage(from, convo, msg);
}

async function handleImage(from, convo, msg) {
  const caption = (msg.image && msg.image.caption) || '';
  const mediaId = msg.image && msg.image.id;
  store.addMessage(from, 'in', 'image', caption ? '[photo] ' + caption : '[photo]');

  const buffer = await wa.downloadMedia(mediaId);
  const analysis = buffer ? await triage.analyzeImageWithAI(buffer, caption) : null;

  if (analysis && analysis.safety_risk) {
    await reply(
      from,
      'Thanks for the photo. If there is any immediate danger (gas smell, smoke, active flooding), call 911 first. I have flagged this as urgent and the team has been notified.'
    );
    let ticket = store.createTicket({
      phone: from, tenantName: convo.name, kind: 'maintenance',
      trade: analysis.trade || 'general', urgency: 'emergency',
      summary: analysis.summary || 'Photo report with possible safety risk.',
      photoIds: mediaId ? [mediaId] : [],
    });
    ticket = enrichTicketFromProperty(ticket) || ticket;
    store.updateConversation(from, { state: 'idle', issue: null });
    await flagForKevin(from, 'photo flagged as possible safety risk');
    return;
  }

  if (analysis) {
    store.updateConversation(from, {
      state: 'awaiting_info', exchanges: 1,
      issue: {
        trade: analysis.trade || 'general', urgency: analysis.urgency || 'routine',
        title: analysis.likely_issue || 'Issue from photo',
        summary: analysis.summary || 'Issue reported by photo.',
        firstMessage: caption || 'Photo sent by tenant.',
        photoIds: mediaId ? [mediaId] : [],
      },
    });
    let m = 'Thanks for the photo. ';
    if (analysis.likely_issue) m += 'This looks like ' + analysis.likely_issue + '. ';
    m += 'Do you need someone out as soon as possible, or can this be scheduled for a regular visit?';
    await reply(from, m);
    return;
  }

  // No AI configured: keep the photo on file, ask for a one-line description.
  store.updateConversation(from, {
    state: 'awaiting_info', exchanges: 1,
    issue: {
      trade: 'general', urgency: 'routine', title: 'Photo report',
      summary: 'Tenant sent a photo.', questions: [],
      firstMessage: caption || 'Photo sent by tenant.',
      photoIds: mediaId ? [mediaId] : [],
    },
  });
  await reply(from, "Thanks for the photo, I've attached it to your file. In one sentence, what's the problem?");
}

// --- Operator commands -------------------------------------------------------
// Kevin manages trades by texting the bot from his own number. The sender
// phone must match biz.ownerPhone, so these never get triaged as a tenant.

function isOperator(from) {
  const owner = String((biz && biz.ownerPhone) || '').replace(/\D/g, '');
  return !!owner && String(from || '').replace(/\D/g, '') === owner;
}

function fmtTradeLine(p, i) {
  const bits = [p.name, p.trade, '+' + p.phone];
  if (p.company) bits.push(p.company);
  return (i != null ? (i + 1) + '. ' : '') + bits.join(' - ');
}

async function handleOperatorCommand(from, text) {
  const t = String(text || '').trim();
  const m = t.match(/^(add trade|list trades)\b/i);
  if (!m) return false;
  const cmd = m[1].toLowerCase();
  if (cmd === 'list trades') {
    const trades = store.getTradeProfiles();
    await reply(from, trades.length
      ? 'Trades on file:\n' + trades.map((p, i) => fmtTradeLine(p, i)).join('\n')
      : 'No trades on file yet. Text ADD TRADE to add one.');
    return true;
  }
  // ADD TRADE name | trade | phone | company | email | hourly | minHours | areas
  const parts = t.slice(m[0].length).split('|').map((s) => s.trim());
  const [name, trade, phone, company, email, hourly, minimumHours, areas] = parts;
  if (!name || !trade || !phone) {
    await reply(from, 'Usage:\nADD TRADE name | trade | phone | company | email | hourly | min hours | areas\nOnly name, trade and phone are required. Example:\nADD TRADE Joe Locker | plumbing | 6473337087 | JSL Plumbing | jslplumbing25@gmail.com | 70 | 1.5 | Toronto, Mississauga, Etobicoke');
    return true;
  }
  const rates = {};
  const h = Number(hourly), mh = Number(minimumHours);
  if (isFinite(h) && h > 0) rates.hourly = h;
  if (isFinite(mh) && mh > 0) rates.minimumHours = mh;
  const profile = store.saveTradeProfile({
    name: String(name).slice(0, 120),
    trade: String(trade).toLowerCase().slice(0, 40),
    phone: String(phone).replace(/\D/g, ''),
    company: company || undefined,
    email: email || undefined,
    rates: Object.keys(rates).length ? rates : undefined,
    serviceAreas: areas ? areas.split(',').map((a) => a.trim()).filter(Boolean).map((a) => a.slice(0, 80)) : [],
  });
  let line = 'Saved: ' + fmtTradeLine(profile);
  if (profile.rates && profile.rates.hourly) line += ' - $' + profile.rates.hourly + '/hr';
  if (profile.rates && profile.rates.minimumHours) line += ', ' + profile.rates.minimumHours + ' hr min';
  if (profile.serviceAreas && profile.serviceAreas.length) line += '\nAreas: ' + profile.serviceAreas.join(', ');
  await reply(from, line);
  return true;
}

// --- Inbox + API ---------------------------------------------------------------

// Serve the inbox with business identity tokens filled in, so the UI carries
// the configured brand without a rebuild per client.
const INBOX_TOKENS = {
  '{{BUSINESS_NAME}}': () => biz.businessName,
  '{{ASSISTANT_NAME}}': () => biz.assistantName,
  '{{OWNER_NAME}}': () => biz.ownerName,
};

app.get('/', auth, (req, res) => {
  try {
    let html = fs.readFileSync(path.join(__dirname, 'inbox.html'), 'utf8');
    for (const [token, fn] of Object.entries(INBOX_TOKENS)) {
      html = html.split(token).join(fn());
    }
    res.type('html').send(html);
  } catch (e) {
    console.error('inbox render failed:', e.message);
    res.sendStatus(500);
  }
});

app.get('/api/conversations', auth, (req, res) => {
  res.json(store.listConversations());
});

app.get('/api/conversations/:phone', auth, (req, res) => {
  res.json({ phone: req.params.phone, messages: store.getMessages(req.params.phone) });
});

app.post('/api/conversations/:phone/reply', auth, async (req, res) => {
  const text = req.body && req.body.text;
  if (!text) return res.status(400).json({ error: 'text required' });
  await reply(req.params.phone, text);
  store.updateConversation(req.params.phone, { needsHuman: false });
  res.json({ ok: true });
});

app.get('/api/tickets', auth, (req, res) => {
  res.json(store.listTickets());
});

app.post('/api/tickets/:id', auth, (req, res) => {
  const ticket = store.setTicketStatus(req.params.id, req.body && req.body.status);
  if (!ticket) return res.status(404).json({ error: 'not found' });
  res.json(ticket);
});

// One-shot test-data cleanup before real tenants. Basic-auth protected.
app.post('/api/admin/clear-test-data', auth, (req, res) => {
  const cleared = store.clearAllData();
  logEvent({ event: 'admin', action: 'clear_test_data', conversations: cleared.conversations, tickets: cleared.tickets });
  res.json({ ok: true, cleared });
});

// Landlord loop: Kevin attaches the landlord to a ticket, previews the
// tenant summary, and sends it to the landlord's own WhatsApp chat.
// Accepts an optional autoApproveLimit (per-landlord spending policy;
// defaults to the policy default and is remembered for that landlord).
app.post('/api/tickets/:id/landlord', auth, (req, res) => {
  const body = req.body || {};
  const digits = String(body.landlordPhone || '').replace(/\D/g, '');
  const ticket = store.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'not found' });
  let limit = null;
  if (digits) {
    if (body.autoApproveLimit !== undefined && body.autoApproveLimit !== null && body.autoApproveLimit !== '') {
      const n = parseInt(body.autoApproveLimit, 10);
      if (!isNaN(n) && n > 0) {
        store.setLandlordPolicy(digits, { autoApproveLimit: n });
        limit = n;
      }
    }
    if (limit === null) limit = store.getLandlordPolicy(digits).autoApproveLimit;
  }
  const updated = store.updateTicket(req.params.id, {
    landlordName: body.landlordName || null,
    landlordPhone: digits || null,
    unit: body.unit || null,
    autoApproveLimit: limit,
  });
  res.json(updated);
});

app.get('/api/tickets/:id/landlord-summary', auth, (req, res) => {
  const ticket = store.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'not found' });
  res.json({ id: ticket.id, text: triage.landlordSummaryMessage(ticket) });
});

app.post('/api/tickets/:id/send-to-landlord', auth, async (req, res) => {
  const ticket = store.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'not found' });
  if (!ticket.landlordPhone) return res.status(400).json({ error: 'landlordPhone not set' });
  const text = triage.landlordSummaryMessage(ticket);
  store.getConversation(ticket.landlordPhone, ticket.landlordName || 'Landlord');
  await reply(ticket.landlordPhone, text);
  if (ticket.phone && ticket.phone !== ticket.landlordPhone) {
    await reply(ticket.phone, 'I have sent the details to your landlord for approval. I will update you once they respond.');
  }
  store.updateTicket(ticket.id, {
    landlordNotifiedAt: new Date().toISOString(),
    awaitingLandlord: true,
    landlordDecision: null,
  });
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ ok: true, dryRun: wa.dryRun(), commit: COMMIT }));

// NTE quote flow: Kevin enters the trade's quote (labor + materials). At or
// under the landlord's cap the ticket auto-approves and the tenant is told a
// pro is being lined up. Over the cap, the landlord gets the summary with
// the breakdown and the tenant is told it is awaiting sign-off.
app.post('/api/tickets/:id/quote', auth, async (req, res) => {
  const ticket = store.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'not found' });
  const labor = parseMoney(req.body && req.body.labor);
  const materials = parseMoney(req.body && req.body.materials);
  if (labor === null || materials === null) {
    return res.status(400).json({ error: 'labor and materials must be non-negative numbers' });
  }
  const total = Math.round((labor + materials) * 100) / 100;
  const limit = ticket.autoApproveLimit ||
    store.getLandlordPolicy(ticket.landlordPhone || '').autoApproveLimit;
  const check = policies.evaluateQuote(limit, total);
  let updated = store.updateTicket(ticket.id, {
    quote: { labor, materials, total },
    autoApproveLimit: check.limit,
  });
  if (check.withinCap) {
    updated = store.updateTicket(ticket.id, {
      landlordDecision: 'auto-approved',
      awaitingLandlord: false,
    });
    if (ticket.phone) await reply(ticket.phone, triage.tenantQuoteMessage(updated, true));
    const dispatch = await dispatchApprovedTicket(updated);
    await flagForKevin(
      ticket.phone || 'inbox',
      'quote ' + triage.fmtCAD(total) + ' within ' + triage.fmtCAD(check.limit) +
        ' cap: ' + ticket.id + ' auto-approved' +
        (dispatch.status === 'blocked'
          ? ', dispatch BLOCKED: ' + (dispatch.reason || 'missing info')
          : (dispatch.proName ? ', dispatched to ' + dispatch.proName : ', no trade on file'))
    );
    return res.json({ id: ticket.id, decision: 'auto-approved', total, limit: check.limit });
  }
  if (ticket.landlordPhone) {
    const text = triage.landlordSummaryMessage(updated);
    store.getConversation(ticket.landlordPhone, ticket.landlordName || 'Landlord');
    await reply(ticket.landlordPhone, text);
    if (ticket.phone && ticket.phone !== ticket.landlordPhone) {
      await reply(ticket.phone, triage.tenantQuoteMessage(updated, false));
    }
    store.updateTicket(ticket.id, {
      landlordNotifiedAt: new Date().toISOString(),
      awaitingLandlord: true,
      landlordDecision: null,
    });
    return res.json({ id: ticket.id, decision: 'sent-to-landlord', total, limit: check.limit });
  }
  await flagForKevin(
    ticket.phone || 'inbox',
    'quote ' + triage.fmtCAD(total) + ' over ' + triage.fmtCAD(check.limit) +
      ' cap but no landlord on ' + ticket.id
  );
  return res.json({ id: ticket.id, decision: 'needs-landlord', total, limit: check.limit });
});

// Landlord profiles (signup data): name, NTE cap, and properties. Each
// property: { unit, address, tenantName, tenantPhone }. Tenants are matched
// to their property by phone when they message in.
app.get('/api/landlords', auth, (req, res) => {
  res.json(store.listLandlords());
});

app.post('/api/landlords/:phone', auth, (req, res) => {
  const digits = String(req.params.phone || '').replace(/\D/g, '');
  if (!digits) return res.status(400).json({ error: 'phone required' });
  const body = req.body || {};
  const patch = {};
  if (body.name !== undefined) patch.name = String(body.name || '').slice(0, 120);
  if (body.autoApproveLimit !== undefined && body.autoApproveLimit !== null && body.autoApproveLimit !== '') {
    const n = parseInt(body.autoApproveLimit, 10);
    if (isNaN(n) || n <= 0) return res.status(400).json({ error: 'autoApproveLimit must be positive' });
    patch.autoApproveLimit = n;
  }
  if (body.properties !== undefined) {
    if (!Array.isArray(body.properties)) return res.status(400).json({ error: 'properties must be an array' });
    patch.properties = body.properties.map((p) => ({
      unit: String((p && p.unit) || '').slice(0, 120),
      address: String((p && p.address) || '').slice(0, 240),
      tenantName: String((p && p.tenantName) || '').slice(0, 120),
      tenantPhone: String((p && p.tenantPhone) || '').replace(/\D/g, ''),
    }));
  }
  const profile = store.setLandlordPolicy(digits, patch);
  res.json(Object.assign({ phone: digits }, profile));
});

// Trade profiles for location-based dispatch:
// { id?, name, trade, phone, email?, company?, rates?, serviceAreas: ['Toronto', 'M4B'] }.
// rates: { hourly?, minimumHours? } — informational, landlord-facing only.
app.get('/api/trades', auth, (req, res) => {
  res.json(store.getTradeProfiles());
});

function parseRates(v) {
  if (!v || typeof v !== 'object') return undefined;
  const rates = {};
  const hourly = Number(v.hourly);
  if (isFinite(hourly) && hourly > 0) rates.hourly = hourly;
  const minimumHours = Number(v.minimumHours);
  if (isFinite(minimumHours) && minimumHours > 0) rates.minimumHours = minimumHours;
  return Object.keys(rates).length ? rates : undefined;
}

app.post('/api/trades', auth, (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.trade) return res.status(400).json({ error: 'name and trade required' });
  const profile = store.saveTradeProfile({
    id: body.id,
    name: String(body.name).slice(0, 120),
    trade: String(body.trade).slice(0, 40),
    phone: String(body.phone || '').replace(/\D/g, ''),
    email: String(body.email || '').slice(0, 120) || undefined,
    company: String(body.company || '').slice(0, 120) || undefined,
    rates: parseRates(body.rates),
    serviceAreas: Array.isArray(body.serviceAreas)
      ? body.serviceAreas.map((a) => String(a).slice(0, 80))
      : [],
  });
  res.json(profile);
});

// Refuse to serve production traffic without webhook signature verification.
// Railway sets RAILWAY_ENVIRONMENT; local dev/test are unaffected.
if (!APP_SECRET && process.env.RAILWAY_ENVIRONMENT && process.env.ALLOW_INSECURE_STARTUP !== 'true') {
  console.error('FATAL: WHATSAPP_APP_SECRET is not set on Railway — refusing to start without webhook signature verification.');
  process.exit(1);
}

app.listen(PORT, () => {
  console.log('Smart Assist listening on :' + PORT + (wa.dryRun() ? ' (DRY_RUN: messages logged, not sent)' : ''));
  if (!APP_SECRET) console.warn('WARNING: WHATSAPP_APP_SECRET not set — webhook signature verification is DISABLED');
  if (!VERIFY_TOKEN) console.warn('WARNING: WHATSAPP_VERIFY_TOKEN not set — webhook verification will reject all challenges');
  if (COMMIT) console.log('commit: ' + COMMIT);
});
