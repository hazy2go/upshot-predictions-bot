// ── NVIDIA NIM AI rater ─────────────────────────────────────
//
// OpenAI-compatible endpoint at https://integrate.api.nvidia.com/v1
// Uses nvidia/nemotron-3-super-120b-a12b, a reasoning model. SSE streaming;
// reasoning_content deltas are discarded and only `content` deltas are kept.
//
// Requires NVIDIA_NIM_API_KEY in .env.

const BASE = 'https://integrate.api.nvidia.com/v1';
const MODEL = 'nvidia/nemotron-3-super-120b-a12b';

// Nemotron thinks before answering; cap the reasoning budget so a single rating
// can't run away, but leave enough room for the short JSON answer after it.
const REASONING_BUDGET = 4096;
const MAX_TOKENS = REASONING_BUDGET + 256;

const RUBRIC = `You are a STRICT prediction-market analyst rating the quality of a user-submitted prediction on a 1-3 star scale. Be harsh: most submissions are low effort and should get 1 star. Reserve 2 and 3 stars for submissions that genuinely earn them.

RUBRIC:
- 1 star (DEFAULT) — Vague, low-effort, off-topic, or no real thesis. Generic or obvious claim, a question, a single line with no reasoning, an emotional take ("they will win!"), or anything that doesn't state WHAT will happen AND give a REASON why. When in doubt, it's 1 star.
- 2 stars — Makes a clear, specific prediction AND gives at least one concrete supporting reason that actually engages with the real outcome. The argument may be thin or under-evidenced, but a real thesis is present.
- 3 stars — Specific prediction backed by concrete evidence, data, or a strong mechanistic thesis. Shows real domain knowledge and clear logic. Rare.

HARD RULES — these are ALWAYS 1 star, no exceptions:
- A question (e.g. "who else should win?", "will it pump?") — a question is not a prediction.
- A bare opinion, hope, or hype with no reasoning ("X to the moon", "they got this", "easy win").
- Off-topic, joke, spam, or text that doesn't engage with the actual event being predicted.
- Anything under ~10 meaningful words that lacks a stated reason.

To award 2 or 3 stars, the text MUST contain BOTH (a) a specific claim about the outcome and (b) reasoning for it. If either is missing, it is 1 star.

Rate PREDICTION QUALITY (clarity, thesis, evidence, specificity) — NOT whether you think it will hit or fail. Use the Upshot card / event context to judge whether the user's reasoning actually engages with the real outcome being predicted.

Respond with ONLY a JSON object, no markdown fences, no prose:
{"stars": 1, "reason": "one short sentence"}`;

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
    if (![1, 2, 3].includes(stars)) return null;
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
      const content = await callNim(apiKey, body, 60_000);
      const parsed = parseRating(content);
      if (!parsed) throw new Error(`AI returned unparseable response: ${content.slice(0, 200)}`);
      return parsed;
    } catch (err) {
      lastErr = err;
      const transient = /timeout|terminated|fetch failed|NVIDIA NIM 5\d\d/i.test(err.message);
      if (!transient || attempt === 3) throw err;
      console.warn(`rateWithAI [${MODEL}] attempt ${attempt} failed (${err.message}) — retrying`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}
