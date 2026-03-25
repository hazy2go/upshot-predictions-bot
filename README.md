# Upshot Predictions Bot

A Discord bot that lets community members submit predictions backed by their [Upshot](https://upshot.cards) card holdings. Admins verify and rate predictions — outcomes are resolved automatically via the Upshot API. The best predictors climb a monthly leaderboard.

## How It Works

### For Users

1. **Link your Upshot profile** — Use `/predict` or click "Make a Prediction" on a panel. If it's your first time, you'll be prompted to paste your profile URL. Go to [upshot.cards](https://upshot.cards), click **View Profile**, then copy the URL or click **Share Profile**.

2. **Submit a prediction** — Fill out the modal:
   - **Title** — A short, clear prediction
   - **Description** — Your thesis, evidence, reasoning
   - **Card URL/ID** *(required)* — The Upshot card backing your prediction. Click any card you own on [upshot.cards](https://upshot.cards), copy the URL or click **Share**
   - **Tweet URL** *(optional)* — Link a tweet for +1 bonus point if your prediction hits

   The bot automatically pulls the card image, deadline, and verifies you own the card. Cards with past or same-day deadlines are rejected.

3. **Track your stats** — Use `/mystats` to see your points, hit rate, and rank for the current month.

### For Admins

Predictions flow through a review pipeline in the admin channel:

```
Submitted  →  Verify Ownership  →  Assign Stars (1-3)  →  Auto/Manual Resolve
```

Each step has a button on the admin review card. The bot runs an **automatic API pre-check** on submission — you'll see one of:
- **User owns this card** — wallet holds the card
- **Card in user's active contest lineup** — card is entered in a contest
- **Card NOT found in user's wallet** — flag for closer review
- **Could not verify (API error)** — API was down, check manually

### Auto-Resolution

The bot automatically resolves predictions by checking if a card's event has settled on Upshot:

- **Every 12 hours**, the bot scans all rated (unresolved) predictions
- Checks each card's event status via the API (`outcomeId` vs `winningOutcomeId`)
- If resolved: auto-marks as **hit** or **fail**, updates embeds, leaderboard, and notifies in admin channel
- Admins can also click **Check Resolution** on any rated prediction to trigger an immediate check
- Manual **Mark Hit / Mark Fail** buttons remain available as fallback

### Prediction Panels

Admins can post prediction panels to any channel using `/panel`. These are styled Components v2 cards with a title, description, optional banner image, and two buttons:
- **Make a Prediction** — opens the submission modal
- **How It Works** — opens a paginated guide explaining the system

### Error Notifications

All errors, API issues, and crashes are automatically reported to the admin channel. The bot handles failures gracefully — predictions still submit when the API is down.

## Points & Scoring

| Component | Points | When |
|-----------|--------|------|
| 1-Star quality | 1 pt | Always (after admin rates) |
| 2-Star quality | 3 pts | Always |
| 3-Star quality | 5 pts | Always |
| Hit bonus | +10 pts | Prediction outcome is correct |
| Tweet bonus | +1 pt | Prediction has a linked tweet AND hits |

**Total = quality points + hit bonus + tweet bonus**

Example: 3-star prediction with tweet that hits = 5 + 10 + 1 = **16 pts**

## Prediction Lifecycle

| Status | Meaning |
|--------|---------|
| Pending Verification | Submitted, awaiting admin ownership verification |
| Pending Review | Ownership verified, awaiting star rating |
| Rated | Stars assigned, awaiting outcome (auto-checked every 12h) |
| Hit | Prediction was correct (auto or manual) |
| Fail | Prediction was incorrect (auto or manual) |

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
| `/panel` | Post a prediction panel with Predict + Help buttons |
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
| `/setup view` | View config, auto-resolve timer, and prediction stats |

## Limits

- **Daily prediction limit** — Configurable per server (default: 3 per day)
- **Edit window** — 1 hour from submission
- **Description** — Up to 2,000 characters
- **Title** — Up to 100 characters
- **Deadline** — Auto-filled from card's event date via API
- **Past events** — Cards with deadlines on or before today are rejected

## Upshot API Integration

The bot uses the [Upshot public API](https://api-mainnet.upshotcards.net/api/v1) to:

- **Auto-check card ownership** — Verifies the card exists in the user's wallet, including cards entered in active contests
- **Fetch card images** — Card images are loaded from Arweave or assets.upshotcards.net and displayed in prediction posts
- **Auto-fill deadlines** — Event dates are pulled from the card's event data
- **Reject past events** — Cards with expired event dates cannot be submitted
- **Auto-resolve predictions** — Every 12h, checks if card events have settled and auto-marks hit/fail based on `outcomeId` vs `winningOutcomeId`
- **Extract wallet addresses** — Parsed automatically from Upshot profile URLs during linking

API failures are handled gracefully — if the API is down, predictions still submit normally. Admins can always verify and resolve manually. Errors are reported to the admin channel.

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
/setup max-daily 1
```

### Running with PM2

```bash
pm2 start ecosystem.config.cjs
```

## Tech Stack

- **Runtime** — Node.js (ESM)
- **Discord** — discord.js v14 with Components v2
- **Database** — SQLite via better-sqlite3 (WAL mode)
- **API** — Upshot public API (card details, ownership, resolution)
- **Auto-resolve** — 12h interval, checks card event outcomes via API
