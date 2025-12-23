# Telegram Daily Check-In Bot

## Overview
A robust Telegram bot for daily user check-ins with Ethereum wallet integration and pactswap API connectivity. Designed for production use with reliability and performance optimizations.

## Project Structure
```
├── src/
│   ├── index.js           # Main bot entry point
│   └── utils/
│       └── retryLogic.js  # Retry mechanism with exponential backoff
├── package.json
├── .env.example
├── .gitignore
└── replit.md
```

## Features Implemented

### ✅ IPv4-Only Forcing
- Uses `dns.setDefaultResultOrder('ipv4first')` to avoid IPv6 timeout issues
- Ensures reliable connectivity in restricted network environments

### ✅ Keep-Alive HTTPS Agent
- Custom HTTPS agent with `keepAlive: true`
- 30-second timeout for all API requests
- Maintains persistent connections to reduce reconnect overhead

### ✅ Telegraf Library
- Modern, stable Telegram bot framework
- Better polling configuration with proper timeout/limit settings
- Cleaner API than node-telegram-bot-api

### ✅ Retry Logic with Exponential Backoff
- 3x automatic retry attempts for failed API calls
- Exponential backoff: 2s → 4s → 8s delays
- Prevents API spam and handles transient failures gracefully

### ✅ Cloudflare Protection Bypass
- Uses `cloudscraper` library to handle Cloudflare-protected APIs
- Automatic fallback to axios if cloudscraper fails
- Proper user-agent headers for better compatibility
- Works with PactSwap API and similar Cloudflare-protected endpoints

### ✅ Daily Check-In Menu (Button-Based)
Single command:
- `/start` - Show main menu with buttons

Main Menu Buttons:
- ✅ Check-In Harian - Perform daily check-in
- 👤 Profil Saya - View user profile and stats
- 📊 Status Check-In - Check latest check-in status
- ❓ Bantuan - Help and information

All navigation is done through inline buttons - no additional commands needed!

### ✅ Wallet Management
- Automatic wallet initialization from `ETHEREUM_PRIVATE_KEY`
- Uses ethers.js v6 for Ethereum operations
- Ready for blockchain transactions

### ✅ Authentication
- Token generation for each user
- Auth token storage (in-memory, upgrade to DB for production)

## Environment Variables

```
TELEGRAM_BOT_TOKEN       # Required: From @BotFather on Telegram
ETHEREUM_PRIVATE_KEY     # Required: 64-char hex string (with or without 0x prefix)
PACTSWAP_API_URL        # Optional: Default = https://hub.pactswap.io/api
PACTSWAP_AUTH_TOKEN     # Optional: For authenticated API calls
NODE_ENV                 # Optional: development/production
```

## Installation & Running

### Local Development (Home Server)
```bash
npm install
cp .env.example .env
# Edit .env with your tokens
npm run dev
```

### Replit
1. Secrets are auto-managed via Replit secrets tab
2. Bot workflow configured: `npm start`
3. Just type `/start` in Telegram to activate the menu

Usage:
```bash
npm install
npm start
```

## API Integration Points

The bot currently supports mock API responses. For production, integrate with:
- User profile: `GET /api/user/{userId}`
- Check-in submission: `POST /api/checkin`
- Loyalty status: `GET /api/loyalty/status`

## Dependencies
- `telegraf` v4.16.3 - Telegram bot framework
- `axios` v1.13.2 - HTTP client with retry support
- `cloudscraper` v4.6.0 - Cloudflare protection bypass
- `ethers` v6.10.0 - Ethereum wallet operations
- `dotenv` v16.3.1 - Environment management

## Network Configuration
- **DNS**: IPv4-only (ipv4first)
- **HTTP Timeout**: 30 seconds
- **Polling Timeout**: 30 seconds
- **Keep-Alive**: Enabled
- **Connection Pool**: Persistent

## Error Handling
- Automatic retry on API failures
- Graceful shutdown on SIGINT/SIGTERM
- User-friendly error messages in Indonesian
- Comprehensive console logging

## Real API Integration Complete ✅

### Authentication System:
- **Session Management** - `GET /api/auth/session`
  - Fetches authenticated user session on `/start`
  - Maps Telegram ID → PactSwap User ID + Wallet Address
  - Stores session in memory (upgrade to DB for production)

### Endpoints Implemented:

1. **Check-In** - `POST /api/loyalty/rules/{loyaltyRuleId}/complete`
   - Uses authenticated PactSwap user ID
   - Submits empty JSON `{}` to mark weekly check-in
   - Response: `{"message":"Completion request added to queue","data":{}}`

2. **Check-In Status** - `GET /api/loyalty/rules/status`
   - Query params: websiteId, organizationId, userId (PactSwap)
   - Returns: Array of check-in records with status

3. **Loyalty Currencies** - `GET /api/loyalty/currencies`
   - Query params: limit, websiteId, organizationId
   - Returns: Currency data (PACT Points = Pact Points token)

4. **Transaction Entries** - `GET /api/loyalty/transaction_entries`
   - Query params: websiteId, organizationId, userId (PactSwap), limit
   - Returns: Credit/debit transactions to calculate point balance

### Features:
- ✅ **Telegram → PactSwap Mapping** - Each user linked to their PactSwap account
- ✅ **Wallet Address Display** - Shows connected Ethereum wallet
- ✅ **Real Pact Points Balance** - Calculated from actual transactions
- ✅ **Weekly Check-In System** - Submit once per week for rewards
- ✅ **Quests Display** - Shows all available loyalty quests with rewards (Main Quests group)
- ✅ **Session Persistence** - Stores user session for subsequent requests
- ✅ **Cloudflare Protection** - Browser headers + IPv4-only DNS

### Available Quests (via API):
- GET /api/loyalty/rule_groups - Fetches all active loyalty rule groups
- Displays quest name, reward amount (PACT points), and grouping
- Example quests: Refer a Friend, Follow Pact Swap, Join Discord, Set Reward Wallet

## Bot Menu Structure (Button-Only Navigation)
```
/start → Main Menu
├── ✅ Check-In Harian (Weekly Check-In)
├── 👤 Profil Saya (Profile + Points Balance)
├── 🎯 Quests (Available Loyalty Quests)
├── ⭐ Exclusive Access (Special Loyalty Rules) ← NEW
├── 📊 Status Check-In (Check-In History)
└── ❓ Bantuan (Help Info)
```

All navigation via buttons - no additional commands required.

## Latest Addition (Dec 23)
- **Exclusive Access Feature** - Shows special/exclusive loyalty rules
  - Fetches via `GET /api/loyalty/rules?isSpecial=true`
  - Displays rule name, description, and reward amount
  - Example: "Special Access Rule" → +1 PACT bonus
  - Auto-claimed exclusive bonuses for special members

## ✅ Quick Setup (1 Step Only)

The bot uses **Ethereum wallet-based authentication** with automatic token refresh.

### Step 1: Get Your User ID
1. Sign in to https://hub.pactswap.io
2. Find your User ID (example: `8da036a6-f24e-44f1-9609-62a77a3224ba`)
   - Check in loyalty dashboard or account settings

### Step 2: Add to Replit Secrets
1. Click **Secrets** (lock icon) in sidebar
2. Add ONE secret:
   - **Name**: `PACTSWAP_USER_ID`
   - **Value**: Your User ID from step 1
3. Bot restarts automatically ✅

### How It Works
```
ETHEREUM_PRIVATE_KEY (already set)
         ↓
    Wallet Initialized
    (0x01f780e1...)
         ↓
  PACTSWAP_USER_ID (you provide)
         ↓
Bot Authenticated ✅
         ↓
Token Auto-Refresh Every 6 Days
```

### Verification
Logs will show:
```
✅ Auth token refreshed for wallet 0x01f780e1...
✅ Auto-refresh enabled (every 6 days)
```

### Troubleshooting
- **"Wallet not initialized"** → Check `ETHEREUM_PRIVATE_KEY` is valid
- **Token refresh fails** → Verify `ETHEREUM_PRIVATE_KEY` is correct Ethereum format
- **Missing auth** → Ensure `PACTSWAP_USER_ID` is set in Secrets

## Next Steps for Production
1. ✅ Real API endpoints integrated
2. ✅ Authentication system with session handling
3. Implement database for persistent user-to-PactSwap mapping (currently in-memory)
3. Add session token management for authenticated endpoints
4. Implement scheduled check-in reminders (every 7 days)
5. Add payment/reward distribution via Ethereum
6. Set up monitoring and alerting

## Deployment Notes
- Bot uses polling (recommended for Replit's environment)
- No webhook setup required
- Auto-restarts on code changes when using `npm run dev`
- Gracefully handles connection interruptions

## Bot Menu Structure
```
/start
├── ✅ Check-In Harian
│   └── Shows points earned, total, streak
│   └── 🏠 Back to Menu
├── 👤 Profil Saya
│   ├── Name, ID, points, streak, level
│   ├── 🔄 Refresh
│   └── 🏠 Back to Menu
├── 📊 Status Check-In
│   ├── Last check-in time
│   ├── Next reward points
│   ├── Consecutive days streak
│   ├── 🔄 Refresh
│   └── 🏠 Back to Menu
└── ❓ Bantuan
    ├── Features explanation
    ├── How it works
    ├── Bonus information
    └── 🏠 Back to Menu
```

## Created: 2025-12-23
## Last Updated: 2025-12-23 - Menu restructured to button-only navigation
