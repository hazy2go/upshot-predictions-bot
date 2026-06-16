// ── NVIDIA NIM AI rater ─────────────────────────────────────
//
// OpenAI-compatible endpoint at https://integrate.api.nvidia.com/v1
// Uses nvidia/nemotron-3-super-120b-a12b, a reasoning model. SSE streaming;
// reasoning_content deltas are discarded and only `content` deltas are kept.
//
// Requires NVIDIA_NIM_API_KEY in .env.

const BASE = 'https://integrate.api.nvidia.com/v1';
export const MODEL = 'nvidia/nemotron-3-super-120b-a12b';

// Nemotron thinks before answering, and every reasoning token is streamed — so
// latency scales with this budget. A 0-3 star call with a one-sentence reason
// needs very little deliberation, so keep it tight: a big budget (e.g. 4096)
// blows past the request timeout on the free tier and every call times out.
const REASONING_BUDGET = 1024;
const MAX_TOKENS = REASONING_BUDGET + 256;
const REQUEST_TIMEOUT_MS = 120_000;

const RUBRIC = `You are a STRICT prediction-market analyst rating the quality of a user-submitted prediction on a 0-3 star scale. Be harsh: most submissions are low effort. A submission that is not a genuine, original prediction gets 0 stars and earns the user NOTHING.

IMPORTANT — stating the outcome is EXPECTED, not a penalty: every real prediction names the specific outcome it is betting on, and that outcome will naturally resemble the card/event. Restating the outcome is ONLY a problem when the submission does NOTHING ELSE. If the user states the outcome AND adds ANY reasoning, evidence, timing, probability view, or thesis, it is NOT low-effort — rate it 1 star or higher. When unsure whether something counts as reasoning, give the benefit of the doubt and award at least 1 star.

RUBRIC:
- 0 stars — NOT a genuine prediction / zero effort. ONLY use this when the submission adds nothing beyond restating the outcome or is plainly not a prediction. This includes: text that only echoes the card title / outcome with no reasoning whatsoever, a question ("who else should win?", "will it pump?"), bare hype or emotion ("to the moon", "easy win", "LFG"), off-topic / joke / spam / gibberish, or an empty / near-empty submission. 0 stars means zero points — no rewards even if a tweet is attached.
- 1 star — A genuine prediction with at least a little substance: states the outcome plus some rationale, context, or specificity, even if vague or thin.
- 2 stars — Makes a clear, specific prediction AND gives at least one concrete supporting reason that engages with the real outcome. The argument may be thin, but a real thesis is present.
- 3 stars — Specific prediction backed by concrete evidence, data, or a strong mechanistic thesis. Shows real domain knowledge and clear logic.

HARD RULES — these are ALWAYS 0 stars, no exceptions:
- The submission ONLY restates the card/outcome and contains no reasoning, evidence, or thesis of any kind. (If there is ANY supporting reasoning, it is NOT 0 stars.)
- A question — a question is not a prediction.
- Bare opinion, hope, or hype with no reasoning.
- Off-topic, joke, spam, gibberish, or empty text.

To earn 1+ stars the submission must be a genuine prediction that adds at least some reasoning, context, or specificity beyond the bare outcome. To earn 2 or 3 stars it must contain clear supporting reasoning. Naming dates, levels, data points, probabilities, or a mechanism all count as reasoning.

Rate PREDICTION QUALITY (clarity, thesis, evidence, specificity) — NOT whether you think it will hit or fail, and NOT merely whether it resembles the card. A detailed, well-argued prediction that happens to align closely with the outcome is HIGH quality, not low.

Respond with ONLY a JSON object, no markdown fences, no prose (the example value below is illustrative, not a default — choose the rating the rubric warrants):
{"stars": 2, "reason": "one short sentence"}`;

function buildUserPrompt(ctx) {
  const lines = [
    `TITLE: ${ctx.title}`,
    `CATEGORY: ${ctx.category || 'n/a'}`,
    `DEADLINE: ${ctx.deadline || 'n/a'}`,
    '',
    'DESCRIPTION:',
    ctx.description || '(none)',
  ];
  if (ctx.cardName || ctx.eventName || ctx.eventDescription || ctx.outcomeName) {
    lines.push('', '--- UPSHOT CARD CONTEXT (what the user is actually predicting) ---');
    if (ctx.cardName) lines.push(`Card: ${ctx.cardName}`);
    if (ctx.eventName) lines.push(`Event: ${ctx.eventName}`);
    if (ctx.eventDescription) lines.push(`Event description: ${ctx.eventDescription}`);
    if (ctx.outcomeName) lines.push(`User is betting this outcome will occur: ${ctx.outcomeName}`);
  }
  return lines.join('\n');
}

function parseRating(text) {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    const stars = Number(obj.stars);
    if (![0, 1, 2, 3].includes(stars)) return null;
    const reason = String(obj.reason || '').trim().slice(0, 300);
    return { stars, reason };
  } catch {
    return null;
  }
}

async function callNim(apiKey, body, timeoutMs) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`NVIDIA NIM ${res.status}: ${errText.slice(0, 300)}`);
  }

  let content = '';
  let buffer = '';
  const decoder = new TextDecoder();

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const evt = JSON.parse(payload);
        const delta = evt?.choices?.[0]?.delta;
        if (delta && typeof delta.content === 'string') content += delta.content;
        // delta.reasoning_content intentionally discarded — Nemotron's thinking stream
      } catch { /* skip malformed SSE line */ }
    }
  }

  return content;
}

export async function rateWithAI(ctx) {
  const apiKey = process.env.NVIDIA_NIM_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_NIM_API_KEY not set in .env');

  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: RUBRIC },
      { role: 'user', content: buildUserPrompt(ctx) },
    ],
    temperature: 1,
    top_p: 0.95,
    max_tokens: MAX_TOKENS,
    stream: true,
    // The OpenAI Python SDK's `extra_body` is flattened into the request body;
    // posting raw JSON, these go at the top level instead.
    chat_template_kwargs: { enable_thinking: true },
    reasoning_budget: REASONING_BUDGET,
  };

  // NIM free tier latency is variable; a quick retry usually clears transient errors.
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const content = await callNim(apiKey, body, REQUEST_TIMEOUT_MS);
      const parsed = parseRating(content);
      if (!parsed) throw new Error(`AI returned unparseable response: ${content.slice(0, 200)}`);
      return parsed;
    } catch (err) {
      lastErr = err;
      // Retry timeouts, dropped connections, 5xx, and 429 rate-limits.
      const transient = /timeout|terminated|fetch failed|NVIDIA NIM (?:5\d\d|429)/i.test(err.message);
      if (!transient || attempt === 3) throw err;
      console.warn(`rateWithAI [${MODEL}] attempt ${attempt} failed (${err.message}) — retrying`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}
