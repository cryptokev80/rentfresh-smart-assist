# Smart Assist setup path (verified against Meta docs, Sept 2026)

Decision (2026-09-22): one number, bot handles everything. The RentFresh company line
(second phone, WhatsApp Business number on rentfresh.ca) stays the public number.

## The question: keep the Business app, or move fully to the API?

Meta supports running the SAME number on the WhatsApp Business app AND the Cloud API
simultaneously. It is called Coexistence:
https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users

What stays: chats and contacts stay on the phone; app replies stay free; 1:1 messages
mirror between the app and the API both ways; voice/video calls and groups keep working
in the app (not synced to the API).

What changes: disappearing messages, view-once, and live location get turned off for
1:1 chats; broadcast lists become read-only; the app must be opened regularly (pairing
drops after ~14 days of inactivity; reinstalling or re-registering the number offboards
the API side); app replies do NOT open or extend the API's 24-hour customer service
window; the API side is subject to Cloud API conversation pricing.

## Wrinkle for a DIY build

Onboarding an existing Business-app number into coexistence must go through Meta's
Embedded Signup as a Solution Partner or Tech Provider. A plain developer clicking
through App Dashboard > API Setup must DELETE the WhatsApp account on the number
first. So there are two real paths:

### Path A: Coexistence (keeps the app on the second phone)
- Kevin goes through a WhatsApp Business Solution Provider (BSP) that supports
  coexistence. Typical cost is a monthly fee plus per-message, on top of Meta rates.
- Kevin keeps using the Business app on the second phone exactly as today. The bot
  works in the background via the API; anything it replies also shows up in the app.
- Setup is the BSP's embedded-signup flow: enter the number, get a code from the
  official Facebook Business chat in the app, tap Connect to the Business Platform,
  paste the code, done. Up to 6 months of 1:1 chat history can sync once (within
  24 hours of onboarding).
- Bot code needs to digest smb_message_echoes webhooks so Kevin's manual app replies
  show in the browser inbox thread.

### Path B: DIY migration (free, app is gone)
- Back up/export important chats from the Business app first (history stays only as
  an archive; it cannot move into the Cloud API).
- Delete the WhatsApp Business account on the number, then register it in App
  Dashboard > WhatsApp > API Setup and add it to a WhatsApp Business Account.
- Bot runs on the API; Kevin reads and replies only through the Smart Assist browser
  inbox. The second phone no longer runs WhatsApp Business.

Meta API costs (direct, no BSP): inbound messages free; free-form replies inside the
24-hour user-initiated window free; business-initiated template messages billed per
Meta's conversation rate card.

## Recommendation

Path A if keeping the phone workflow and existing chats on the device matters.
Path B if cost and simplicity matter (matches the current prototype, which calls the
Graph API directly).

## Pre-launch fixes still owed (prototype limitations)

1. inbox.html renders an em dash through an HTML entity. Remove it (zero em dash rule).
2. Unknown intents currently default to maintenance triage. Add a real general-business
   route.
3. NEEDS YOU is an inbox flag only. Add real push/email/SMS alerting for Kevin.
4. Add webhook signature verification (x-hub-signature-256) and rate limiting.
5. Move JSON file store to a managed database for production.
6. Verify the current supported Graph API version (prototype pins v21.0).
7. Kevin must review safety/urgency triage rules and choose a photo-retention policy
   before real tenants use it.

Nothing deploys, registers, or connects externally without Kevin's explicit approval.
