# Upshot Predictions Bot

A Discord bot that lets community members submit predictions backed by their [Upshot](https://upshot.cards) card holdings. Admins verify and rate predictions, the community votes on quality, and outcomes are resolved automatically via the Upshot API. The best predictors climb a monthly leaderboard.

## How It Works

### For Users

Everything lives on the **prediction panel** an admin posts — no commands to memorize. The panel has buttons for **📇 My Cards**, **🔮 Make a Prediction**, **📊 My Stats**, **🏆 Leaderboard**, **🏅 My Contests**, and **❓ How It Works**.

1. **Link your Upshot profile** — The first time you tap **My Cards** or **Make a Prediction**, you'll be prompted to paste your profile URL. Go to [upshot.cards](https://upshot.cards), click **View Profile**, then copy the URL or click **Share Profile**.

2. **Predict by picking a card (easiest)** — Tap **📇 My Cards** to get a dropdown of every card you can predict on right now — cards in your **wallet** *and* cards in your active **contest lineups**. Cards that already have an open prediction are hidden, so you never pick a dead end. Choose one and a short form opens (no URL needed):
   - **Title** — A short, clear prediction
   - **Description** — Your thesis, evidence, reasoning
   - **Tweet URL** *(optional)* — Link a tweet for +1 bonus point if your prediction hits

   The card, image, and deadline are filled in for you, and ownership is auto-verified.

3. **Or submit manually** — Tap **🔮 Make a Prediction** to paste a card URL/ID yourself. Click any card you own on [upshot.cards](https://upshot.cards), copy the URL or click **Share**. Invalid card URLs and cards with past deadlines are rejected.

4. **Vote on predictions** — Every prediction has star vote buttons (1-3 stars). Rate other members' predictions to influence the quality score. You can't vote on your own predictions, and you can change your vote at any time.

5. **Track your stats** — Tap **📊 My Stats** on the panel (or use `/mystats`) to see your points, hit rate, and rank for the current month. **🏆 Leaderboard** shows the current standings, **🏅 My Contests** lists your active lineups, and `/upshotrank` shows your Upshot season XP.

### For Admins

Predictions flow through a review pipeline in the admin channel:

```
Submitted  →  Verify Ownership  →  Assign Stars (0-3)  →  Auto/Manual Resolve
```

Each step has a button on the admin review card. The bot runs an **automatic API pre-check** on submission — you'll see one of:
- **User owns this card** — wallet holds the card
- **Card in user's active contest lineup** — card is entered in a contest
- **Card NOT found in user's wallet** — flag for closer review
- **Could not verify (API error)** — API was down, check manually

Admins can also **override resolved predictions** by re-clicking Mark Hit / Mark Fail or running `/resolve id:<n> outcome:<hit|fail>`. Points and the leaderboard recalculate automatically.

### AI-Assisted Review

Two `/setup` subcommands let admins clear the review queue in bulk instead of clicking each button:

- **`/setup auto-verify-all`** — Loops every unverified prediction and hits the Upshot API to check ownership. Passing predictions are marked verified (same effect as clicking the button manually — embeds and state update identically). Failing predictions are listed back so you can handle them by hand.

- **`/setup auto-rate-all`** — Uses [NVIDIA NIM](https://build.nvidia.com) (`nvidia/nemotron-3-super-120b-a12b`, a reasoning model) to suggest 0-3 star ratings for every verified-but-unrated prediction. The bot feeds each prediction's title, description, category, **plus the real Upshot card/event context** (card name, event description, the specific outcome the user is betting on) to the model and returns a star rating with a one-sentence reason.

  You get an ephemeral summary listing every suggestion, then two buttons: **Accept All** or **Cancel**. Accept All applies the ratings one by one, re-checking each prediction at apply time so it safely skips anything that got manually rated, deleted, or un-verified in the meantime.

  **Rubric the AI uses:**
  - 0 stars — **Not a genuine prediction.** Restates/paraphrases the card or event description, a question, bare hype, off-topic, or spam. Earns **0 points — no rewards even if a tweet is attached.**
  - 1 star — A genuine, original prediction but vague or thin (little or no reasoning)
  - 2 stars — Clear prediction with some reasoning but limited evidence or shallow analysis
  - 3 stars — Specific, well-researched, backed by concrete evidence, data, or a strong mechanistic thesis

  Rating is based on **prediction quality**, not whether the AI thinks the prediction will hit.

- **`/setup recheck-all-ratings`** — Re-runs the AI rater on every **active (unresolved) prediction that already has a star rating** and shows where its judgement has changed. You get an ephemeral summary listing only the predictions whose rating moved (`old → new`, e.g. `⭐⭐ → 🚫 0★`) with the AI's reason, then an **Apply changes** / **Cancel** pair. Apply re-rates only the changed predictions, re-checking each at apply time so it skips anything that resolved in the meantime. Predictions the AI still agrees with are left untouched. Useful after tightening the rubric, to sweep old ratings without re-rating by hand.

### Community Weighting

Quality stars are determined by a weighted combination of admin and community votes:

- **Admin rating (70%)** — Assigned by admins during review (0-3 stars; 0★ = low-effort, a hard floor community votes can't lift)
- **Community average (30%)** — Average of all community votes on the prediction
- **Final rating** = `round(admin × 0.7 + community × 0.3)`
- If no community votes, admin rating counts as 100%
- Points recalculate in real-time when votes come in

### Auto-Resolution

The bot automatically resolves predictions by checking if a card's event has settled on Upshot:

- **Every 12 hours**, the bot scans all rated (unresolved) predictions
- Checks each card's event status via the API (`outcomeId` vs `winningOutcomeId`)
- If resolved: auto-marks as **hit** or **fail**, updates embeds, leaderboard, and notifies in admin channel
- Admins can also click **Check Resolution** on any rated prediction to trigger an immediate check
- Manual **Mark Hit / Mark Fail** buttons remain available as fallback — and can be re-clicked to override a previous outcome

### Prediction Panels

Admins can post prediction panels to any channel using `/panel`. These are styled Components v2 cards with a title, description, optional banner image, and a full self-serve button hub so members never need to type a command:
- **📇 My Cards** — opens a dropdown of every card you can predict on (wallet + contest lineups), with already-predicted cards hidden. Pick one to submit with no URL.
- **🔮 Make a Prediction** — opens the submission modal where you paste a card URL/ID manually (fallback for power users or >25 cards)
- **📊 My Stats** — your points, hit rate, and rank this month
- **🏆 Leaderboard** — current month standings
- **🏅 My Contests** — your active contest lineups and card IDs
- **❓ How It Works** — a paginated guide explaining the system (profile linking, picking cards, scoring, community voting, rules)

### Error Notifications

All errors, API issues, and crashes are automatically reported to the admin channel. The bot handles failures gracefully — predictions still submit when the API is down.

### Duplicate Detection

If a user tries to link an Upshot profile that's already linked to another account, the attempt is rejected and a detailed notification is sent to the admin channel (who tried, which URL, who it belongs to).

## Points & Scoring

| Component | Points | When |
|-----------|--------|------|
| 0-Star (low-effort) | 0 pts | After rating — earns nothing, no bonuses apply |
| 1-Star quality (weighted) | 1 pt | After admin rates |
| 2-Star quality (weighted) | 3 pts | After admin rates |
| 3-Star quality (weighted) | 5 pts | After admin rates |
| Hit bonus | +10 pts | Prediction outcome is correct (1★+ only) |
| Tweet bonus | +1 pt | Prediction has a linked tweet AND hits (1★+ only) |

**Total = weighted quality points + hit bonus + tweet bonus**

A **0★ low-effort** rating earns **0 points total** — the hit and tweet bonuses do **not** apply, so a low-effort submission gets nothing even if it comes true with a tweet attached.

Quality stars use the weighted rating (70% admin + 30% community). Example: admin gives 3 stars, community averages 2 stars → weighted = 3 → 5 pts quality. With hit + tweet = 5 + 10 + 1 = **16 pts**.

## Prediction Lifecycle

| Status | Meaning |
|--------|---------|
| Pending Verification | Submitted, awaiting admin ownership verification |
| Pending Review | Ownership verified, awaiting star rating |
| Rated | Stars assigned, awaiting outcome (auto-checked every 12h) |
| Hit | Prediction was correct (auto or manual) |
| Fail | Prediction was incorrect (auto or manual) |

Users can edit their predictions (title, description, deadline) within **1 hour** of submission. Edits are logged in the admin channel. Predictions are grouped into monthly leaderboards by their **deadline month**, not their submission date.

## Commands

### User Commands

| Command | Description |
|---------|-------------|
| `/predict` | Submit a new prediction |
| `/link-upshot` | Link your Upshot profile URL |
| `/mystats` | View your personal stats for this month |
| `/upshotrank` | View your Upshot season rank and XP |
| `/mycontests` | View your active contest lineups and card IDs |
| `/pastleaderboard` | View a past month's leaderboard (format: `YYYY-MM`) |

### Admin Commands

| Command | Description |
|---------|-------------|
| `/panel` | Post a prediction panel with Predict + Help buttons |
| `/leaderboard` | Force-refresh the leaderboard |
| `/refresh id:<n>` | Re-sync a prediction's embeds to show the latest buttons/state |
| `/resolve id:<n> outcome:<hit\|fail>` | Set or change the outcome of a prediction |
| `/setup predictions-channel` | Set the public predictions feed channel |
| `/setup admin-channel` | Set the private admin review channel |
| `/setup leaderboard-channel` | Set the leaderboard channel |
| `/setup admin-role` | Set the role that can review predictions |
| `/setup max-daily` | Set max predictions per user per day (1-20) |
| `/setup max-open` | Set max unresolved predictions per user (1-50) |
| `/setup add-category` | Add a prediction category |
| `/setup remove-category` | Remove a prediction category |
| `/setup auto-verify-all` | Auto-verify ownership for every unverified prediction via the Upshot API |
| `/setup auto-rate-all` | Use NVIDIA NIM to suggest star ratings for every unrated prediction (review before applying) |
| `/setup reset-user @user` | Delete all of a user's predictions this month |
| `/setup reset-all` | Delete ALL predictions this month |
| `/setup undo-last @user` | Delete a user's most recent prediction |
| `/setup delete-profile @user` | Remove a user's linked Upshot profile |
| `/setup delete-all-profiles` | Remove all linked profiles |
| `/setup export-db` | Download the full database file |
| `/setup user-info @user` | View a user's profile, stats, and predictions |
| `/setup view` | View config, auto-resolve timer, and prediction stats |

## Limits

- **Daily prediction limit** — Configurable per server (default: 3 per day)
- **Open prediction limit** — Max unresolved predictions per user, configurable (default: 5)
- **Edit window** — 1 hour from submission
- **Description** — Up to 2,000 characters
- **Title** — Up to 100 characters
- **Deadline** — Auto-filled from card's event date via API
- **Past events** — Cards with deadlines on or before today are rejected
- **Card format** — Must be a valid upshot.cards URL or card ID starting with `cm`
- **Community votes** — One vote per user per prediction, can be changed anytime

## Upshot API Integration

The bot uses the [Upshot public API](https://api-mainnet.upshotcards.net/api/v1) to:

- **Validate card URLs** — Rejects invalid card IDs when the API is reachable
- **Auto-check card ownership** — Verifies the card exists in the user's wallet, including cards entered in active contests
- **Fetch card images** — Card images are loaded from Arweave or assets.upshotcards.net and displayed in prediction posts
- **Auto-fill deadlines** — Event dates are pulled from the card's event data
- **Reject past events** — Cards with expired event dates cannot be submitted
- **Auto-resolve predictions** — Every 12h, checks if card events have settled and auto-marks hit/fail based on `outcomeId` vs `winningOutcomeId`
- **Extract wallet addresses** — Parsed automatically from Upshot profile URLs during linking
- **Season rank & contest lineups** — Powers `/upshotrank` and `/mycontests`

API failures are handled gracefully — if the API is down, predictions still submit normally. Admins can always verify and resolve manually. Errors are reported to the admin channel.

## NVIDIA NIM Integration

The `/setup auto-rate-all` and `/setup recheck-all-ratings` commands use [NVIDIA NIM](https://build.nvidia.com) (`nvidia/nemotron-3-super-120b-a12b`, a reasoning model) to suggest admin star ratings. Requires a free API key from build.nvidia.com. The request is streamed and only the final JSON (`{stars, reason}`) is applied; the model's reasoning tokens are discarded. If `NVIDIA_NIM_API_KEY` is missing, the command returns a clear error and no other features are affected.

## Setup

### Prerequisites

- Node.js 18+
- A Discord bot token with the `bot` and `applications.commands` scopes
- Bot permissions: Send Messages, Manage Messages, Embed Links, Attach Files, Use External Emojis
- *(Optional)* NVIDIA NIM API key for AI auto-rating — [build.nvidia.com](https://build.nvidia.com)

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

# Optional — enables /setup auto-rate-all
NVIDIA_NIM_API_KEY=your_nvidia_nim_api_key
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
/setup max-open 5
```

### Running with PM2

```bash
pm2 start ecosystem.config.cjs
```

## Tech Stack

- **Runtime** — Node.js (ESM)
- **Discord** — discord.js v14 with Components v2
- **Database** — SQLite via better-sqlite3 (WAL mode)
- **API** — Upshot public API (card details, ownership, resolution, season rank, contests)
- **AI** — NVIDIA NIM (`nvidia/nemotron-3-super-120b-a12b`) for optional bulk star rating
- **Auto-resolve** — 12h interval, checks card event outcomes via API
