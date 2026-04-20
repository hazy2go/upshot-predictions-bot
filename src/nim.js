// ── NVIDIA NIM AI rater ─────────────────────────────────────
//
// OpenAI-compatible endpoint at https://integrate.api.nvidia.com/v1
// Uses z-ai/glm4.7 with thinking mode. The reasoning_content stream is
// discarded; only the final JSON in `content` is parsed.
//
// Requires NVIDIA_NIM_API_KEY in .env.

const BASE = 'https://integrate.api.nvidia.com/v1';
const MODEL = 'z-ai/glm4.7';

const RUBRIC = `You are an expert prediction-market analyst rating the quality of a user-submitted prediction on a 1-3 star scale.

RUBRIC:
- 1 star — Vague, low-effort, no specific thesis or reasoning. Generic or obvious claim, little more than a guess.
- 2 stars — Clear prediction with some reasoning, but limited evidence or shallow analysis. The reader sees what's predicted and why, but the argument is thin.
- 3 stars — Specific, well-researched, backed by concrete evidence, data, or a strong mechanistic thesis. Shows real domain knowledge and clear logic.

Rate based on PREDICTION QUALITY (clarity, thesis, evidence, specificity) — NOT on whether you think it will hit or fail. Use the Upshot card / event context to judge whether the user's reasoning actually engages with the real outcome being predicted.

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

export async function rateWithAI(ctx) {
  const apiKey = process.env.NVIDIA_NIM_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_NIM_API_KEY not set in .env');

  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: RUBRIC },
      { role: 'user', content: buildUserPrompt(ctx) },
    ],
    temperature: 0.2,
    top_p: 1,
    max_tokens: 256,
    stream: true,
    // Thinking is intentionally OFF — a 1-3 rating doesn't need a reasoning
    // trace and with thinking on the call often takes 30-60s and hits timeouts.
    chat_template_kwargs: { enable_thinking: false },
  };

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
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
        // delta.reasoning_content intentionally discarded — GLM's thinking stream
      } catch { /* skip malformed SSE line */ }
    }
  }

  const parsed = parseRating(content);
  if (!parsed) throw new Error(`AI returned unparseable response: ${content.slice(0, 200)}`);
  return parsed;
}
