'use strict';

/**
 * Smart Assist triage engine — concierge MVP.
 *
 * Rule-based classification plus hard-coded safety escalation.
 * Nothing here replaces a licensed pro: every tenant-facing output uses
 * "likely / possible" language, and emergencies escalate to a human.
 */

const TRADE_LABELS = {
  plumbing: 'Plumbing',
  electrical: 'Electrical',
  hvac: 'Heating / Cooling',
  appliance: 'Appliance',
  general: 'General maintenance',
};

const URGENCY_LABELS = {
  emergency: 'Emergency',
  urgent: 'Urgent',
  routine: 'Routine',
};

// ---------------------------------------------------------------------------
// Safety escalation. Checked BEFORE anything else. These skip the AI chat
// entirely: the tenant gets immediate instructions and a human is flagged.
// ---------------------------------------------------------------------------

const EMERGENCY_RULES = [
  {
    id: 'gas',
    patterns: [
      'gas smell', 'smell gas', 'smells like gas', 'smell like gas',
      'rotten egg', 'rotten eggs', 'sulfur', 'sulphur', 'gas leak',
    ],
    title: 'Possible gas leak',
    advice:
      'This could be a gas leak. Do this right now:\n' +
      '1. Leave the unit immediately. Do not turn lights or appliances on or off.\n' +
      '2. Once you are outside, call 911.\n' +
      '3. Then call Enbridge Gas emergency: 1-866-763-5427.\n' +
      'Do not go back inside until you are cleared. I have flagged this as an emergency and the team has been notified.',
  },
  {
    id: 'carbon-monoxide',
    patterns: ['carbon monoxide', 'co detector', 'co alarm'],
    title: 'Possible carbon monoxide alarm',
    advice:
      'If your CO alarm is sounding, treat it as real. Do this right now:\n' +
      '1. Leave the unit immediately and get into fresh air.\n' +
      '2. Once outside, call 911.\n' +
      'Do not go back inside until cleared. I have flagged this as an emergency and the team has been notified.',
  },
  {
    id: 'fire-electrical',
    patterns: [
      'sparking', 'sparks', 'spark ', 'outlet is hot', 'switch is hot',
      'smoke', 'fire', 'burning smell', 'smells like burning', 'melted',
    ],
    title: 'Possible electrical fire hazard',
    advice:
      'Do not touch the outlet, switch, or breaker panel. If you see smoke or flames, leave the unit and call 911.\n' +
      'If it is safe to do so, turn off the breaker for that area. I have flagged this as an emergency and the team has been notified.',
  },
  {
    id: 'flood',
    patterns: [
      'flooding', 'flooded', 'water pouring', 'burst pipe',
      'gushing', 'water everywhere', 'ceiling collapsing',
      'pouring through', 'pouring from', 'pouring down', 'pouring out',
      'water coming through', 'water coming from', 'water coming down',
      'coming through', 'is pouring', 'is gushing',
      'pipe burst', 'broken pipe', 'pipe broke',
    ],
    title: 'Active flooding',
    advice:
      'If you can do this safely, shut off the main water valve (usually near the water meter or where the main line enters the unit).\n' +
      'Move valuables and electronics off the floor. I have flagged this as an emergency and a plumber is being dispatched.',
  },
];

// Urgent but not life-safety: needs a pro today, not a 911 call.
const URGENT_PATTERNS = [
  'no heat', 'no heating', 'heat is out', 'furnace not working', 'heater not working',
  'sewage', 'sewer backup', 'backing up', 'toilet overflowing', 'toilet keeps running over',
  'no hot water', 'water heater leaking',
  'cannot lock', "can't lock", 'cant lock', 'lock broken', "door won't lock", 'door wont lock',
  'fridge not cooling', 'refrigerator not cooling', 'fridge is warm', 'freezer thawed',
  'power out', 'no power', 'no electricity',
  'water leaking through ceiling', 'ceiling leaking',
];

// ---------------------------------------------------------------------------
// Trade classification
// ---------------------------------------------------------------------------

const TRADE_KEYWORDS = {
  plumbing: [
    'leak', 'leaking', 'drip', 'dripping', 'toilet', 'sink', 'faucet', 'tap',
    'drain', 'clog', 'clogged', 'pipe', 'pipes', 'shower', 'tub', 'bathtub',
    'valve', 'puddle', 'damp', 'water stain', 'water heater', 'hot water',
    'running water', 'low water pressure', 'no water', 'pouring',
  ],
  electrical: [
    'outlet', 'socket', 'plug', 'breaker', 'breakers', 'power', 'electricity',
    'light', 'lights', 'switch', 'flicker', 'flickering', 'buzzing', 'panel',
    'dimmer', 'ceiling fan',
  ],
  hvac: [
    'heat', 'heating', 'furnace', 'thermostat', 'cold', 'freezing',
    'air conditioner', 'a/c', 'ac not', 'radiator', 'baseboard', 'vent',
    'no heat', 'too hot',
  ],
  appliance: [
    'fridge', 'refrigerator', 'stove', 'oven', 'dishwasher', 'washer',
    'washing machine', 'dryer', 'microwave', 'range', 'garbage disposal',
  ],
  general: [
    'door', 'lock', 'key', 'window', 'drywall', 'paint', 'ceiling', 'floor',
    'tile', 'cabinet', 'blinds', 'screen door', 'handle', 'hinge', 'mold', 'mould',
  ],
};

const TRADE_QUESTIONS = {
  plumbing: [
    'Is water actively flowing right now, or is it a slow drip?',
    'Can you see where the water is coming from?',
  ],
  electrical: [
    'Is this affecting one outlet or room, or the whole unit?',
    'Have you checked the breaker panel for a tripped breaker?',
  ],
  hvac: [
    'Is the thermostat display on? What is it set to?',
    'When did you first notice the problem?',
  ],
  appliance: [
    'What is the brand and approximate age of the appliance, if you know?',
    'Is it completely dead, or partly working?',
  ],
  general: [
    'Can you describe the damage in one sentence?',
    'Is it getting worse, or staying the same?',
  ],
};

// Safe, low-risk troubleshooting the bot is allowed to suggest.
// Everything else goes to a pro. This list stays short on purpose.
const DIY_SAFE = [
  {
    patterns: ['breaker tripped', 'tripped breaker', 'breaker keeps'],
    tip: 'You can safely try flipping the breaker fully OFF and then back ON once. If it trips again right away, stop and wait for the pro.',
  },
  {
    patterns: ['toilet clogged', 'clogged toilet', 'toilet is clogged'],
    tip: 'A plunger is safe to try. Do not use chemical drain cleaner.',
  },
];

function scoreTrades(padded) {
  let best = 'general';
  let bestScore = 0;
  for (const [trade, keywords] of Object.entries(TRADE_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (padded.includes(kw)) score += kw.includes(' ') ? 3 : 1; // multi-word matches weigh more
    }
    if (score > bestScore) {
      bestScore = score;
      best = trade;
    }
  }
  return bestScore === 0 ? 'general' : best;
}

function diyTipFor(padded) {
  for (const item of DIY_SAFE) {
    if (item.patterns.some((p) => padded.includes(p))) return item.tip;
  }
  return null;
}

/**
 * Classify a tenant message.
 * Returns { emergency, trade, urgency, title, summary, questions, advice, diyTip }
 */
function classify(text) {
  const padded = ' ' + String(text || '').toLowerCase() + ' ';

  for (const rule of EMERGENCY_RULES) {
    if (rule.patterns.some((p) => padded.includes(p))) {
      return {
        emergency: true,
        ruleId: rule.id,
        trade: scoreTrades(padded),
        urgency: 'emergency',
        title: rule.title,
        summary: rule.title + ' reported by tenant.',
        questions: [],
        advice: rule.advice,
        diyTip: null,
      };
    }
  }

  const trade = scoreTrades(padded);
  let urgency = 'routine';
  if (URGENT_PATTERNS.some((p) => padded.includes(p))) urgency = 'urgent';
  // Active water where it should not be is at least urgent, whatever the trade.
  if (/(actively|pouring|streaming|gushing|spreading)/.test(padded)) {
    urgency = 'urgent';
  }

  const short = String(text || '').trim().split('\n')[0].slice(0, 140);

  return {
    emergency: false,
    ruleId: null,
    trade,
    urgency,
    title: TRADE_LABELS[trade] + ' issue',
    summary: TRADE_LABELS[trade] + ' issue reported: "' + short + '"',
    questions: (TRADE_QUESTIONS[trade] || TRADE_QUESTIONS.general).slice(0, 2),
    advice: null,
    diyTip: diyTipFor(padded),
  };
}

const NEXT_STEP = {
  emergency: 'The team has been notified and a pro is being dispatched now.',
  urgent: 'A pro will confirm a time window shortly.',
  routine: "We'll schedule this and confirm a time with you.",
};

function confirmationMessage(ticket) {
  return (
    'Got it, thanks. I have created ticket ' + ticket.id + ': ' +
    TRADE_LABELS[ticket.trade] + ' - ' + URGENCY_LABELS[ticket.urgency] + '.\n' +
    NEXT_STEP[ticket.urgency] +
    ' You do not need to do anything else.'
  );
}

function questionsMessage(result) {
  let msg = 'Thanks, I want to make sure the right pro comes. Two quick questions:\n';
  result.questions.forEach((q, i) => {
    msg += (i + 1) + '. ' + q + '\n';
  });
  if (result.diyTip) msg += '\nIn the meantime, this is safe to try: ' + result.diyTip;
  return msg.trim();
}

// ---------------------------------------------------------------------------
// Optional AI vision for photo triage (OpenAI-compatible endpoint).
// Returns null when not configured or on any failure — the caller falls back
// to asking the tenant to describe the issue.
// ---------------------------------------------------------------------------

async function analyzeImageWithAI(imageBuffer, caption) {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey || !imageBuffer) return null;
  try {
    const base = (process.env.AI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
    const model = process.env.AI_VISION_MODEL || 'gpt-4o-mini';
    const dataUri = 'data:image/jpeg;base64,' + imageBuffer.toString('base64');
    const prompt =
      'You are a maintenance triage assistant for rental apartments in Toronto, Canada. ' +
      'Look at this photo of a maintenance issue' + (caption ? ' (tenant caption: "' + caption + '")' : '') + '. ' +
      'Respond with ONLY a JSON object, no other text: ' +
      '{"trade": one of plumbing|electrical|hvac|appliance|general, ' +
      '"urgency": one of emergency|urgent|routine, ' +
      '"likely_issue": "short plain-language guess, prefixed with likely/possible", ' +
      '"summary": "one sentence for the work ticket", ' +
      '"questions": ["at most 2 clarifying questions"], ' +
      '"safety_risk": true if gas/fire/flooding/sewage risk is visible}';

    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUri } },
            ],
          },
        ],
        max_tokens: 400,
        temperature: 0.2,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : '';
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) return null;
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    if (!TRADE_LABELS[parsed.trade]) parsed.trade = 'general';
    if (!URGENCY_LABELS[parsed.urgency]) parsed.urgency = 'routine';
    return parsed;
  } catch (err) {
    console.error('AI vision failed, falling back:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Intent routing: one company number handles maintenance AND leads.
// classify() runs first (emergency always wins). isLeadInquiry() is only
// called for non-emergency messages.
// ---------------------------------------------------------------------------

const LEAD_PATTERNS = [
  'quote', 'how much', 'price', 'pricing', 'cost', 'estimate',
  'do you offer', 'do you do', 'do you service', 'are you available',
  'availability', 'looking for', 'need someone', 'need a cleaner',
  'need a painter', 'turnover', 'renovation', 'renovate',
  'move in cleaning', 'move out cleaning', 'move-in cleaning', 'move-out cleaning',
  'interested in', 'hire you', 'book', 'booking', 'schedule a',
  'property manager', 'i manage', 'landlord',
  'partnership', 'work with you', 'service area', 'do you cover',
];

const PROBLEM_GUARD = /(leak|leaking|drip|broken|not working|clogged|mold|mould|no heat|no hot water|flood|sparking|smoke)/;

function isLeadInquiry(text) {
  const padded = ' ' + String(text || '').toLowerCase() + ' ';
  if (PROBLEM_GUARD.test(padded)) return false; // problem reports stay in triage
  return LEAD_PATTERNS.some((p) => padded.includes(p));
}

const HUMAN_PATTERNS = [
  'real person', 'human', 'talk to someone', 'speak to someone',
  'talk to kevin', 'speak to kevin', 'kevin please', 'call me back',
];

function wantsHuman(text) {
  const padded = ' ' + String(text || '').toLowerCase() + ' ';
  return HUMAN_PATTERNS.some((p) => padded.includes(p));
}

// Short closing messages after a flow completes ("ok", "thanks").
// Matched against the whole normalized message so words like "broken",
// "smoke", or "mold" never false-positive on a substring like "ok".
// Words that can appear in a pure acknowledgment ("ok thanks", "thanks so much").
const ACK_FILLER = new Set([
  'ok', 'okay', 'k', 'kk', 'thanks', 'thank', 'thx', 'you',
  'got', 'it', 'great', 'perfect', 'awesome', 'cool',
  'sounds', 'good', 'will', 'do', 'bye',
  'yes', 'yep', 'yup', 'sure', 'alright', 'all', 'right',
  'much', 'very', 'so', 'appreciated', 'cheers',
]);
// Words that on their own carry the acknowledgment meaning.
const ACK_CORE = new Set([
  'ok', 'okay', 'k', 'thanks', 'thank', 'thx',
  'got', 'great', 'perfect', 'awesome', 'cool',
  'sounds', 'bye', 'yes', 'yep', 'sure', 'appreciated', 'cheers',
  'will', 'do',
]);

function isAcknowledgment(text) {
  const t = String(text || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 60) return false;
  const words = t.split(' ');
  return words.some((w) => ACK_CORE.has(w)) && words.every((w) => ACK_FILLER.has(w));
}

function leadQuestionsMessage() {
  return (
    'Thanks for reaching out to RentFresh. So Kevin can give you an accurate quote, could you share:\n' +
    '1. Your name\n' +
    '2. The property address\n' +
    '3. What you need done, and roughly when\n\n' +
    'He quotes every job properly, so no prices over chat.'
  );
}

// ---------------------------------------------------------------------------
// Landlord loop (Smart Membership): the tenant reports, the landlord approves.
// The bot sends the landlord a plain-language summary; Kevin reviews it in
// the inbox before it goes out. No prices in the summary: Kevin confirms the
// quote with the landlord before anything is booked.
// ---------------------------------------------------------------------------

function landlordSummaryMessage(ticket) {
  const lines = [];
  lines.push('RentFresh maintenance update' + (ticket.unit ? ' for ' + ticket.unit : ''));
  lines.push('');
  lines.push('Tenant: ' + (ticket.tenantName || 'Unknown'));
  lines.push('Issue: ' + TRADE_LABELS[ticket.trade] + ' - ' + URGENCY_LABELS[ticket.urgency]);
  lines.push('What was reported: ' + (ticket.summary || 'No details yet.'));
  if (ticket.photoIds && ticket.photoIds.length) {
    lines.push('Photos: ' + ticket.photoIds.length + ' attached to the work file.');
  }
  lines.push('');
  lines.push('Recommended next step: ' + (NEXT_STEP[ticket.urgency] || NEXT_STEP.routine));
  lines.push('Kevin will confirm the quote with you before anything is booked.');
  lines.push('');
  lines.push('Reply APPROVE to go ahead, or DECLINE to hold.');
  return lines.join('\n');
}

const LANDLORD_APPROVE = ['approve', 'approved', 'go ahead', 'proceed'];
const LANDLORD_DECLINE = [
  'decline', 'declined', 'not now', 'hold off',
  'do not proceed', "don't proceed", 'dont proceed',
];

function parseLandlordDecision(text) {
  const padded = ' ' + String(text || '').toLowerCase() + ' ';
  const yes = LANDLORD_APPROVE.some((p) => padded.includes(p));
  const no = LANDLORD_DECLINE.some((p) => padded.includes(p));
  if (yes && !no) return 'approved';
  if (no && !yes) return 'declined';
  return null; // ambiguous: a human (Kevin) decides
}

module.exports = {
  classify,
  confirmationMessage,
  questionsMessage,
  analyzeImageWithAI,
  isLeadInquiry,
  wantsHuman,
  isAcknowledgment,
  leadQuestionsMessage,
  landlordSummaryMessage,
  parseLandlordDecision,
  TRADE_LABELS,
  URGENCY_LABELS,
  NEXT_STEP,
};
