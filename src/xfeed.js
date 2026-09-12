// ── X (Twitter) feed fetcher ─────────────────────────────────
//
// Reads a public profile timeline from Twitter's syndication endpoint — the one
// that serves embedded timelines. No API key, no auth, no paid tier.
//
// Ported from the Telegram tg-feed-bot, with one hard-won difference: the
// endpoint is rate limited PER IP and it is *tight*. Measured from the Pi on
// 2026-09-12, five requests spaced 20s apart all returned a bare 429
// ("Rate limit exceeded"), while the Telegram bot on the same host records
// occasional successes hours apart. So 429 is the NORMAL response, not an
// exception: treat a cycle that fetches nothing as routine, keep the dedup
// window wide enough that a late success still catches up, and never let a
// quiet failure look like "no new posts".

const PROFILE_URL = 'https://syndication.twitter.com/srv/timeline-profile/screen-name';
const LIST_URL = 'https://syndication.twitter.com/srv/timeline-list/list-id';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 20_000;

/** A 429 is expected often enough to deserve its own type, so callers can treat
 *  "throttled" differently from "this handle is broken". */
export class XRateLimited extends Error {
  constructor() { super('X syndication rate limited (429)'); this.name = 'XRateLimited'; this.rateLimited = true; }
}

/** The handle itself is gone / suspended / protected — retrying won't help. */
export class XAccountUnavailable extends Error {
  constructor(status) {
    super(`X profile unavailable (${status}) — suspended, renamed, protected or deleted?`);
    this.name = 'XAccountUnavailable';
    this.permanent = true;
  }
}

/**
 * Fetch a handle's recent posts, newest first. Throws XRateLimited on 429,
 * XAccountUnavailable on 404/403, and a plain Error on anything else.
 *
 * Returns [{ id, text, url, date, author, photos[], isRetweet, isThreadReply,
 *            isReply, quoted }]
 */
export async function fetchPosts(handle) {
  return fetchTimeline(`${PROFILE_URL}/${encodeURIComponent(handle)}`, handle);
}

/**
 * Fetch a PUBLIC X list's timeline: every member's posts in ONE request.
 *
 * This is the endpoint that makes the feed practical. Measured on 2026-09-12,
 * while /timeline-profile was returning 429 to every request, this returned 200
 * with 70 entries covering both tracked accounts — it is a separate rate-limit
 * bucket, and it scales to any number of accounts for the same single request.
 *
 * The list must be public; a private one reads as empty rather than erroring.
 */
export async function fetchListPosts(listId) {
  return fetchTimeline(`${LIST_URL}/${encodeURIComponent(listId)}`, null);
}

async function fetchTimeline(url, fallbackHandle) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (res.status === 429) throw new XRateLimited();
  if (res.status === 404 || res.status === 403) throw new XAccountUnavailable(res.status);
  if (!res.ok) throw new Error(`X syndication ${res.status}`);

  const html = await res.text();

  // The timeline arrives as a Next.js page with its data in a script tag.
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>({.+?})<\/script>/);
  if (!match) {
    // Either the page shape changed or we got an interstitial. Both mean "no
    // data", and the caller surfaces a long streak of these rather than
    // pretending the account has simply gone quiet.
    throw new Error('Could not parse X syndication response (page shape changed?)');
  }

  const data = JSON.parse(match[1]);
  const entries = data?.props?.pageProps?.timeline?.entries || [];

  return entries
    .filter(e => e.type === 'tweet')
    .map(e => normalize(e.content?.tweet, fallbackHandle))
    .filter(Boolean);
}

/** Group a list timeline by author handle (lowercased). */
export function groupByAuthor(posts) {
  const out = new Map();
  for (const p of posts) {
    const key = (p.author || '').toLowerCase();
    if (!key) continue;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(p);
  }
  return out;
}

function normalize(t, handle) {
  if (!t?.id_str) return null;
  // In list mode there is no single handle to fall back to, so a post without a
  // resolvable author is dropped rather than mis-attributed.
  const screenName = t.user?.screen_name || handle;
  if (!screenName) return null;
  const lower = screenName.toLowerCase();
  const replyTo = t.in_reply_to_screen_name?.toLowerCase() || null;

  // Media field names are defensive: the payload is undocumented, so anything
  // missing simply means "no image" rather than a crash.
  const photos = (Array.isArray(t.photos) ? t.photos : [])
    .map(p => p?.url)
    .filter(u => typeof u === 'string' && u.startsWith('http'));

  return {
    id: t.id_str,
    text: t.text || '',
    url: `https://x.com/${screenName}/status/${t.id_str}`,
    date: t.created_at ? new Date(t.created_at).toISOString() : null,
    author: screenName,
    photos,
    // A retweet is someone else's post; a thread reply is the author replying to
    // themselves (a continued thread), which is worth posting. A reply to
    // somebody ELSE is conversation noise.
    isRetweet: !!t.retweeted_status || (t.text || '').startsWith('RT @'),
    isThreadReply: !!replyTo && replyTo === lower,
    isReply: !!t.in_reply_to_status_id_str,
    quoted: t.quoted_tweet ? {
      author: t.quoted_tweet.user?.screen_name || null,
      text: t.quoted_tweet.text || '',
    } : null,
  };
}

/**
 * What we actually mirror: the account's own posts. Retweets are someone else's
 * content and replies to other people are half a conversation; a self-reply is
 * the author continuing their own thread, so it stays.
 */
export function isOwnPost(p) {
  return !p.isRetweet && !(p.isReply && !p.isThreadReply);
}
