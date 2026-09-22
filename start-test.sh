#!/bin/bash
# Local test runner. Real credentials live in hosting secrets or a local .env file.
# Never commit real tokens to this file.
export PORT=3000
export WHATSAPP_VERIFY_TOKEN="${WHATSAPP_VERIFY_TOKEN:-rentfresh-verify-change-me}"
export WHATSAPP_PHONE_NUMBER_ID="${WHATSAPP_PHONE_NUMBER_ID:-1278204592050941}"
export WHATSAPP_ACCESS_TOKEN="${WHATSAPP_ACCESS_TOKEN:-}"
export INBOX_USER="${INBOX_USER:-rentfresh}"
export INBOX_PASS="${INBOX_PASS:-}"
cd ~/workspace/smart-assist
exec node src/server.js
