# RentFresh Smart Assist — concierge MVP

One WhatsApp number (the RentFresh company line). The bot handles everything:

| Incoming message | Bot does |
|---|---|
| Gas smell, sparking, flooding, CO alarm | Sends safety instructions immediately, creates an **emergency** ticket, flags you |
| Quote / service inquiry ("how much for a turnover?") | Asks for name, address, what + when. Creates a **lead** ticket, flags you |
| Maintenance problem ("water under sink") | Asks 2 clarifying questions, creates a triaged **maintenance** ticket |
| "Talk to a real person" | Flags the conversation for you, replies politely |
| Photo of an issue | Attaches to the ticket; with AI vision configured, pre-diagnoses from the photo |

You review everything in the inbox and dispatch manually. The AI triages; you keep the judgment.

## Project layout

```
smart-assist/
  src/server.js     Express app: Meta webhook + inbox + API
  src/triage.js     Triage engine: safety escalation, intent routing, trade classification
  src/whatsapp.js   WhatsApp Cloud API client (send text, download media)
  src/store.js      JSON file store (data.json)
  src/inbox.html    Your inbox UI: conversations, reply box, tickets
  .env.example      Copy to .env and fill in
```

## Setup

### 1. Create the Meta app (you do this, ~10 min)

1. developers.facebook.com → log in → create a free developer account.
2. My Apps → Create App → type **Business**, name it `RentFresh Assist`.
3. Add the **WhatsApp** product. Meta gives you a free test number immediately.

### 2. Migrate the company line to the API

Your RentFresh number is currently on the WhatsApp Business app. A number can only live in one place.

1. On the company phone: WhatsApp Business → Settings → Chats → **Chat backup** (keep your history).
2. Settings → Account → **Delete my account**. This frees the number.
3. Wait a few minutes.
4. In the Meta dashboard: WhatsApp → API Setup → **Add phone number** → enter the company number → verify with the SMS/voice OTP.
5. Set the display name to `RentFresh` (goes through Meta approval).

After this, the phone app can no longer use that number. The inbox in this project replaces it.

### 3. Tokens

- **Phone Number ID**: WhatsApp → API Setup (this is the ID, not the phone number).
- **Permanent access token**: business.facebook.com → Settings → Business settings → Users → System users → Add → attach your app → Generate new token → expiry **Never** → tick `whatsapp_business_messaging` and `whatsapp_business_management`. (The token on the API Setup page expires in 24h. Don't use it.)
- **App Secret**: app Settings → Basic.
- **Verify token**: any random string you invent. It must match `WHATSAPP_VERIFY_TOKEN` in `.env`.

### 4. Deploy

This server needs a public HTTPS URL so Meta can reach the webhook. Easiest options: Railway, Render, or fly.io. Any VPS with Node 18+ works too.

```bash
npm install
cp .env.example .env   # fill in your values
npm start
```

### 5. Connect the webhook

In the Meta dashboard: WhatsApp → Configuration → Webhook → Edit.

- Callback URL: `https://your-domain/webhook`
- Verify token: the string from step 3
- Subscribe to the `messages` field.

Meta will call the URL once to verify. Then message the company number from your personal phone to test.

## Environment variables

| Var | Required | What |
|---|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | yes (prod) | From WhatsApp → API Setup |
| `WHATSAPP_ACCESS_TOKEN` | yes (prod) | Permanent system-user token |
| `WHATSAPP_VERIFY_TOKEN` | yes | Must match the Meta dashboard value |
| `WHATSAPP_APP_SECRET` | no | Reserved for signature verification |
| `DRY_RUN` | no | `true` = log outgoing messages instead of sending |
| `PORT` | no | Default 3000 |
| `INBOX_USER` / `INBOX_PASS` | recommended | HTTP Basic Auth for the inbox |
| `AI_API_KEY` | no | Enables photo triage via any OpenAI-compatible endpoint |
| `AI_API_BASE` | no | Default `https://api.openai.com/v1` |
| `AI_VISION_MODEL` | no | Default `gpt-4o-mini` |

## Testing without Meta (dry run)

```bash
DRY_RUN=true WHATSAPP_VERIFY_TOKEN=test123 npm start
```

Verify the webhook handshake:

```bash
curl "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=test123&hub.challenge=HELLO"
# -> HELLO
```

Simulate a tenant reporting a leak (save as `/tmp/msg.json` and POST it):

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "contacts": [{ "profile": { "name": "Test Tenant" }, "wa_id": "14165550123" }],
        "messages": [{
          "from": "14165550123", "id": "wamid.test1",
          "timestamp": "1727000000", "type": "text",
          "text": { "body": "water under the kitchen sink" }
        }]
      },
      "field": "messages"
    }]
  }]
}
```

```bash
curl -X POST http://localhost:3000/webhook -H 'Content-Type: application/json' -d @/tmp/msg.json
```

Watch the server log for the bot's reply, then answer the questions with a second POST to see the ticket get created. Check `http://localhost:3000/` for the inbox and `GET /api/tickets` for tickets.

## Triage rules (tune these in `src/triage.js`)

- **Emergency** is keyword-based and checked first: gas, carbon monoxide, sparking/smoke/fire, active flooding. Never add DIY advice here.
- **Lead vs maintenance**: messages with commercial asks (quote, price, availability, turnover, renovation) route to lead capture, unless they also describe a problem (leak, broken, not working), which stays in triage.
- **Trade classification** is keyword scoring across plumbing, electrical, HVAC, appliance, general.
- **Urgency**: emergency > urgent (no heat, sewage, can't lock, fridge out, ceiling leak) > routine. Active water flow bumps plumbing to urgent.
- **DIY tips** are allow-listed only (breaker reset, plunger). Everything else goes to a pro.
- Tenant-facing language always says "likely / possible", never a certain diagnosis.

## Costs

- Meta: tenant-initiated conversations are free inside the 24h window; outbound utility ~$0.0034/message in North America. Expect near zero at pilot scale.
- Optional AI vision: ~$0.01–0.02 per photo analyzed.
- Hosting: free tier on Railway/Render is enough for the pilot.

## Roadmap

- Phase 2: pro dispatch (ping matching ProQue pros, first to accept), landlord notifications, spend-threshold approvals.
- Phase 3: per-unit history, landlord dashboard, sensor alerts feeding triage.
- Hardening before scale: webhook signature verification, rate limiting, Postgres instead of JSON, French-language templates.

## Security notes

- Never commit `.env`. Rotate the access token if it leaks.
- Set `INBOX_USER`/`INBOX_PASS` on any public deployment.
- Tenant photos land in Meta's media URLs transiently; the JSON store keeps message text. Decide a retention policy and say it plainly to tenants.
