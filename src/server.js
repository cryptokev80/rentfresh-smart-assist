'use strict';

/**
 * RentFresh Smart Assist — concierge MVP.
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
const store = require('./store');
const wa = require('./whatsapp');
const triage = require('./triage');

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
        }
      }
    } catch (err) {
      console.error('webhook error:', err.message);
    }
  })();
});

async function reply(to, text) {
  store.addMessage(to, 'out', 'text', text);
  try {
    const result = await wa.sendText(to, text);
    logEvent({ event: 'outbound', to, ok: true, dryRun: !!(result && result.dryRun) });
  } catch (err) {
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

  if (msg.type === 'text' && msg.text && msg.text.body) {
    store.addMessage(from, 'in', 'text', msg.text.body);
    await handleText(from, convo, msg.text.body);
  } else if (msg.type === 'image' && msg.image) {
    await handleImage(from, convo, msg);
  } else {
    store.addMessage(from, 'in', msg.type || 'unknown', '');
    await reply(from, 'Thanks for messaging RentFresh. Could you describe that in a text message? A photo helps too if it is a maintenance issue.');
  }
}

async function handleText(from, convo, text) {
  // 1. Emergency always wins, regardless of intent.
  const result = triage.classify(text);
  logEvent({
    event: 'inbound', from, kind: 'text',
    trade: result.trade, urgency: result.urgency,
    emergency: !!result.emergency, rule: result.ruleId || null,
  });
  if (result.emergency) {
    await reply(from, result.advice);
    const ticket = store.createTicket({
      phone: from, tenantName: convo.name, kind: 'maintenance',
      trade: result.trade, urgency: 'emergency',
      summary: result.summary, emergencyRule: result.ruleId,
    });
    await reply(from, 'Emergency ticket ' + ticket.id + ' created. The team has been notified.');
    store.updateConversation(from, { state: 'idle', issue: null, lead: null, exchanges: 0, needsHuman: true });
    return;
  }

  // 2. Landlord replying to a summary we sent (approve / decline).
  // Checked after emergency so a safety report from a landlord still wins.
  const landlordTicket = store.findAwaitingLandlordTicket(from);
  if (landlordTicket) {
    await handleLandlordReply(from, convo, text, landlordTicket);
    return;
  }

  // 3. Explicit human handoff.
  if (triage.wantsHuman(text)) {
    await reply(from, "Of course. I've flagged this for Kevin and he'll pick it up personally.");
    store.updateConversation(from, { needsHuman: true });
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

  // 6. Default: maintenance triage.
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

async function finishTriage(from, convo, text) {
  const issue = convo.issue;
  const combined = issue.firstMessage + '\nTenant added: ' + text;
  const result = triage.classify(combined);
  const ticket = store.createTicket({
    phone: from, tenantName: convo.name, kind: 'maintenance',
    trade: result.trade, urgency: result.urgency,
    summary: result.summary, photoIds: issue.photoIds || [],
  });
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
  store.updateConversation(from, { state: 'idle', lead: null, exchanges: 0, needsHuman: true });
  await reply(
    from,
    "Got it, thanks. I've passed your details to Kevin and he'll reply personally shortly. Your reference is " + ticket.id + '.'
  );
}

async function handleLandlordReply(from, convo, text, ticket) {
  const decision = triage.parseLandlordDecision(text);
  if (decision === 'approved') {
    store.updateTicket(ticket.id, { landlordDecision: 'approved', awaitingLandlord: false });
    store.updateConversation(from, { needsHuman: true }); // Kevin sees it and dispatches
    await reply(from, 'Approved, thanks. Kevin will dispatch the pro and keep you posted. (Ticket ' + ticket.id + ')');
    if (ticket.phone && ticket.phone !== from) {
      await reply(ticket.phone, 'Good news: your landlord approved the repair. We will be in touch shortly to schedule the visit.');
    }
    return;
  }
  if (decision === 'declined') {
    store.updateTicket(ticket.id, { landlordDecision: 'declined', awaitingLandlord: false });
    store.updateConversation(from, { needsHuman: true });
    await reply(from, 'Understood, holding for now. Kevin has been notified. (Ticket ' + ticket.id + ')');
    if (ticket.phone && ticket.phone !== from) {
      await reply(ticket.phone, 'Your landlord asked us to hold for now. Kevin will follow up if anything changes.');
    }
    return;
  }
  // Ambiguous reply: don't guess on money, let Kevin handle it.
  store.updateConversation(from, { needsHuman: true });
  await reply(from, 'Thanks, I have passed your message to Kevin and he will confirm the next step with you shortly.');
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
    store.createTicket({
      phone: from, tenantName: convo.name, kind: 'maintenance',
      trade: analysis.trade || 'general', urgency: 'emergency',
      summary: analysis.summary || 'Photo report with possible safety risk.',
      photoIds: mediaId ? [mediaId] : [],
    });
    store.updateConversation(from, { state: 'idle', issue: null, needsHuman: true });
    return;
  }

  if (analysis) {
    const questions = (analysis.questions || []).slice(0, 2);
    if (questions.length === 0) {
      const ticket = store.createTicket({
        phone: from, tenantName: convo.name, kind: 'maintenance',
        trade: analysis.trade || 'general', urgency: analysis.urgency || 'routine',
        summary: analysis.summary || 'Issue reported by photo.',
        photoIds: mediaId ? [mediaId] : [],
      });
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

// --- Inbox + API ---------------------------------------------------------------

app.get('/', auth, (req, res) => {
  res.sendFile(path.join(__dirname, 'inbox.html'));
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

// Landlord loop: Kevin attaches the landlord to a ticket, previews the
// tenant summary, and sends it to the landlord's own WhatsApp chat.
app.post('/api/tickets/:id/landlord', auth, (req, res) => {
  const body = req.body || {};
  const digits = String(body.landlordPhone || '').replace(/\D/g, '');
  const ticket = store.updateTicket(req.params.id, {
    landlordName: body.landlordName || null,
    landlordPhone: digits || null,
    unit: body.unit || null,
  });
  if (!ticket) return res.status(404).json({ error: 'not found' });
  res.json(ticket);
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

app.listen(PORT, () => {
  console.log('Smart Assist listening on :' + PORT + (wa.dryRun() ? ' (DRY_RUN: messages logged, not sent)' : ''));
  if (!APP_SECRET) console.warn('WARNING: WHATSAPP_APP_SECRET not set — webhook signature verification is DISABLED');
  if (!VERIFY_TOKEN) console.warn('WARNING: WHATSAPP_VERIFY_TOKEN not set — webhook verification will reject all challenges');
  if (COMMIT) console.log('commit: ' + COMMIT);
});
