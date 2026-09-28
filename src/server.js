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

async function reply(to, text) {
  // ProQue triages 24/7: every message gets an answer right away, no
  // business-hours note. Emergencies escalate immediately.
  const idx = store.addMessage(to, 'out', 'text', text);
  try {
    const result = await wa.sendText(to, text);
    const waId = result && result.messages && result.messages[0] ? result.messages[0].id : null;
    if (waId) store.updateMessage(to, idx, { waId, status: 'sent' });
    logEvent({ event: 'outbound', to, ok: true, dryRun: !!(result && result.dryRun), waId: waId || null });
  } catch (err) {
    store.updateMessage(to, idx, { status: 'failed', statusError: err.message });
    await flagForKevin(to, 'a reply failed to send');
    logEvent({ event: 'outbound', to, ok: false, error: err.message });
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
  } else if (msg.type === 'image' && msg.image) {
    await handleImage(from, convo, msg);
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
  // a tenant. Their reply goes straight to Kevin.
  const proProfile = policies.findProByPhone(store, from);
  if (proProfile) {
    await flagForKevin(from, proProfile.name + ' replied: ' + String(text).slice(0, 140));
    const firstName = String(proProfile.name || '').split(' ')[0] || 'there';
    await reply(from, 'Thanks ' + firstName + ', Kevin has your message and will confirm shortly.');
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
  if (convo.state === 'awaiting_info' && convo.issue) return finishTriage(from, convo, text);
  if (convo.state === 'awaiting_lead' && convo.lead) return finishLead(from, convo, text);

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
  // status instead of reporting something new. Answer in the ticket's
  // context instead of starting a fresh triage.
  const openTicket = store.findOpenTicketByPhone(from);
  if (openTicket && triage.isFollowupOnTicket(text)) {
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
  if (/any update|status|when will|when is|has anyone|did anyone|someone coming/.test(lower)) {
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
  let ticket = store.createTicket({
    phone: from, tenantName: convo.name, kind: 'maintenance',
    trade: result.trade, urgency: result.urgency,
    summary: result.summary, photoIds: issue.photoIds || [],
  });
  ticket = enrichTicketFromProperty(ticket) || ticket;
  store.updateConversation(from, { state: 'idle', issue: null, exchanges: 0 });
  let msg = triage.confirmationMessage(ticket);
  if (result.diyTip) msg += '\n\nSafe to try in the meantime: ' + result.diyTip;
  await reply(from, msg);
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
  const candidates = policies.findCandidateTrades(store, ticket);
  const pro = candidates[0] || null;
  const record = {
    flow: ticket.landlordDecision === 'auto-approved' ? 'nte-auto' : 'nte-approved',
    candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
    status: pro ? 'dispatched' : 'no-trade',
    dispatchedAt: new Date().toISOString(),
    proId: pro ? pro.id : null,
    proName: pro ? pro.name : null,
  };
  store.updateTicket(ticket.id, {
    dispatch: record,
    status: pro ? 'dispatched' : ticket.status,
  });
  if (pro && pro.phone) {
    store.getConversation(pro.phone, pro.name);
    await reply(pro.phone, triage.proJobCardMessage(ticket, pro));
    await flagForKevin(pro.phone, 'dispatched ' + ticket.id + ' to ' + pro.name);
  } else {
    await flagForKevin(
      ticket.phone || 'inbox',
      'no trade on file for ' + ticket.id + ' (' + ticket.trade + '): Kevin dispatches manually'
    );
  }
  return record;
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
    const questions = (analysis.questions || []).slice(0, 2);
    if (questions.length === 0) {
      let ticket = store.createTicket({
        phone: from, tenantName: convo.name, kind: 'maintenance',
        trade: analysis.trade || 'general', urgency: analysis.urgency || 'routine',
        summary: analysis.summary || 'Issue reported by photo.',
        photoIds: mediaId ? [mediaId] : [],
      });
      ticket = enrichTicketFromProperty(ticket) || ticket;
      store.updateConversation(from, { state: 'idle', issue: null });
      await reply(from, 'Thanks for the photo. ' + (analysis.likely_issue ? 'This looks like ' + analysis.likely_issue + '. ' : '') + triage.confirmationMessage(ticket));
      return;
    }
    store.updateConversation(from, {
      state: 'awaiting_info', exchanges: 1,
      issue: {
        trade: analysis.trade || 'general', urgency: analysis.urgency || 'routine',
        title: analysis.likely_issue || 'Issue from photo',
        summary: analysis.summary || 'Issue reported by photo.',
        questions, firstMessage: caption || 'Photo sent by tenant.',
        photoIds: mediaId ? [mediaId] : [],
      },
    });
    let m = 'Thanks for the photo. ';
    if (analysis.likely_issue) m += 'This looks like ' + analysis.likely_issue + '. ';
    m += 'Two quick questions:\n' + questions.map((q, i) => (i + 1) + '. ' + q).join('\n');
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
        (dispatch.proName ? ', dispatched to ' + dispatch.proName : ', no trade on file')
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
