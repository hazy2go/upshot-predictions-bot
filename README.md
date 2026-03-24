# Upshot Predictions Bot

A Discord bot that lets community members submit predictions backed by their [Upshot](https://upshot.cards) card holdings. Admins verify, rate, and resolve predictions — and the best predictors climb a monthly leaderboard.

## How It Works

### For Users

1. **Link your Upshot profile** — Use `/link-upshot` or just click "Predict" and you'll be prompted automatically. Paste your profile URL (e.g. `https://upshot.cards/profile/0x89A8...`). The bot extracts your wallet address for automatic card ownership checks.

2. **Submit a prediction** — Use `/predict` or click the "Make a Prediction" button on any prediction panel posted by an admin. Fill out the modal:
   - **Title** — A short, clear prediction (e.g. "BTC breaks $100K before April 2026")
   - **Category** — One of the configured categories (typo-tolerant fuzzy matching)
   - **Description** — Your thesis, evidence, reasoning
   - **Deadline** — When the prediction should be resolved (DD/MM/YYYY)
   - **Card URL/ID** *(optional)* — Link your Upshot card and the bot will auto-verify ownership via the API and display the card image

3. **Track your stats** — Use `/mystats` to see your points, hit rate, and rank for the current month.

### For Admins

Predictions flow through a review pipeline in the admin channel:

```
Submitted  -->  Verify Ownership  -->  Assign Stars (1-3)  -->  Mark Hit / Fail
```

Each step has a button on the admin review card. The bot also runs an **automatic API pre-check** when a user submits a card URL — you'll see one of:
- **API: card ownership confirmed** — the user's wallet holds this card
- **Card NOT found in user's wallet** — flag for closer review
- **Could not verify (API error)** — API was down, check manually

### Prediction Panels

Admins can post prediction panels to any channel using `/panel`. These are styled Components v2 cards with a title, description, optional banner image, and a "Make a Prediction" button — a clean way to drive engagement without requiring users to remember slash commands.

## Points & Scoring

| Component | Points | When |
|-----------|--------|------|
| 1-Star quality | 1 pt | Always (after admin rates) |
| 2-Star quality | 3 pts | Always |
| 3-Star quality | 5 pts | Always |
| Hit bonus | +10 pts | Prediction outcome is correct |
| Tweet bonus | +1 pt | Prediction has a linked tweet AND hits |

**Total = quality points + hit bonus + tweet bonus**

Points are awarded when an admin assigns stars and resolves the outcome. The leaderboard updates in real-time.

## Prediction Lifecycle

| Status | Meaning |
|--------|---------|
| Pending Verification | Submitted, awaiting admin ownership verification |
| Pending Review | Ownership verified, awaiting star rating |
| Rated | Stars assigned, awaiting outcome resolution |
| Hit | Prediction was correct |
| Fail | Prediction was incorrect |

Users can edit their predictions (title, description, deadline) within **1 hour** of submission. Edits are logged in the admin channel.

## Commands

### User Commands

| Command | Description |
|---------|-------------|
| `/predict` | Submit a new prediction |
| `/link-upshot` | Link your Upshot profile URL |
| `/mystats` | View your personal stats for this month |

### Admin Commands

| Command | Description |
|---------|-------------|
| `/panel` | Post a prediction panel with a Predict button |
| `/leaderboard` | Force-refresh the leaderboard |
| `/setup predictions-channel` | Set the public predictions feed channel |
| `/setup admin-channel` | Set the private admin review channel |
| `/setup leaderboard-channel` | Set the leaderboard channel |
| `/setup admin-role` | Set the role that can review predictions |
| `/setup max-daily` | Set max predictions per user per day (1-20) |
| `/setup add-category` | Add a prediction category |
| `/setup remove-category` | Remove a prediction category |
| `/setup reset-user @user` | Delete all of a user's predictions this month |
| `/setup reset-all` | Delete ALL predictions this month |
| `/setup undo-last @user` | Delete a user's most recent prediction |
| `/setup delete-profile @user` | Remove a user's linked Upshot profile |
| `/setup delete-all-profiles` | Remove all linked profiles |
| `/setup view` | View current bot configuration |

## Limits

- **Daily prediction limit** — Configurable per server (default: 3 per day)
- **Edit window** — 1 hour from submission
- **Categories** — Configurable, defaults: DeFi, NFTs, L1-L2, Gaming, Macro
- **Description** — Up to 2,000 characters
- **Title** — Up to 100 characters
- **Deadline format** — DD/MM/YYYY (also accepts DD-MM-YYYY, DD.MM.YYYY)

## Upshot API Integration

The bot uses the [Upshot public API](https://api-mainnet.upshotcards.net/api/v1) to:

- **Auto-check card ownership** — When a user submits a card URL/ID, the bot queries the API to verify the card exists in their wallet
- **Fetch card images** — Card images are loaded from Arweave and displayed directly in prediction posts
- **Extract wallet addresses** — Parsed automatically from Upshot profile URLs during linking

API failures are handled gracefully — if the API is down, predictions still submit normally without the auto-check or card image. Admins can always verify manually.

## Setup

### Prerequisites

- Node.js 18+
- A Discord bot token with the `bot` and `applications.commands` scopes
- Bot permissions: Send Messages, Manage Messages, Embed Links, Attach Files, Use External Emojis

### Installation

```bash
git clone https://github.com/hazy2go/upshot-predictions-bot.git
cd upshot-predictions-bot
npm install
cp .env.example .env
# Edit .env with your bot token, client ID, and guild ID
```

### Configuration

Edit `.env`:

```env
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_application_client_id
GUILD_ID=your_guild_id
```

Then start the bot:

```bash
npm start
```

On first startup, use `/setup` commands to configure channels and roles:

```
/setup predictions-channel #predictions
/setup admin-channel #admin-review
/setup leaderboard-channel #leaderboard
/setup admin-role @Moderator
```

### Running with PM2

```bash
pm2 start ecosystem.config.cjs
```

## Tech Stack

- **Runtime** — Node.js (ESM)
- **Discord** — discord.js v14 with Components v2
- **Database** — SQLite via better-sqlite3 (WAL mode)
- **Images** — Sharp (compression), Arweave (card images from Upshot API)
- **API** — Upshot public API (no auth required for reads)
