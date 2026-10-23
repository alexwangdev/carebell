import { describesDoorRule, sanitizeRule } from './rules';
import type { Rule } from './types';

const MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash'];
export const OUT_OF_SCOPE = 'That is outside the door watch. Pick a time, what happens at the door, and whether to alert.';

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    inScope: { type: 'BOOLEAN' },
    kind: { type: 'STRING', enum: ['by', 'between', 'stay'] },
    time: { type: 'STRING' },
    end: { type: 'STRING' },
    minutes: { type: 'INTEGER' },
    days: { type: 'STRING', enum: ['every', 'weekdays', 'weekends'] },
    condition: { type: 'STRING', enum: ['doorbell', 'person', 'familiar', 'vehicle', 'motion', 'activity'] },
    action: { type: 'STRING', enum: ['alert', 'contact'] }
  },
    required: ['inScope', 'kind', 'time', 'end', 'minutes', 'days', 'condition', 'action']
};

function promptFor(sentence: string): string {
  return [
    'Turn one household sentence into one CareBell door rule.',
    'CareBell only watches a Ring door: a doorbell press, a person, a familiar person the household named, a car, movement, or any activity.',
    'It can show an alert, and it can tell the emergency contact.',
    'It cannot control lights, locks, sirens, cameras, music, shopping, medicine, or anything away from the door.',
    'If the sentence is outside that, set inScope to false and use empty strings for the other fields.',
    'kind "by" means: at that time, alert if it has not happened yet.',
    'kind "between" means: while the clock is inside the range, alert when it happens. Use 24-hour HH:MM. A range may cross midnight.',
    'kind "stay" means: the same person keeps appearing at the door for minutes (1 to 60). Compare saved door photos. Do not name a stranger.',
    'days is every, weekdays, or weekends. Default every.',
    'action is alert, or contact when they want the emergency contact told.',
    `Sentence: ${sentence}`
  ].join('\n');
}

function readText(body: any): string {
  const parts = body && body.candidates && body.candidates[0] && body.candidates[0].content && body.candidates[0].content.parts;
  if (!Array.isArray(parts)) return '';
  const texts = parts.map((part) => String(part.text || '').trim()).filter(Boolean);
  return texts.length ? texts[texts.length - 1] : '';
}

function parseModelJson(raw: unknown): any {
  const cleaned = String(raw || '').replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

async function askModel(model: string, sentence: string, key: string) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': key
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: promptFor(sentence) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: SCHEMA
      }
    }),
    signal: AbortSignal.timeout(20000)
  });
  return response;
}

export async function suggestRule(sentence: unknown): Promise<{ ok: true; rule: Rule } | { ok: false; error: string }> {
  const text = String(sentence || '').trim().slice(0, 240);
  if (!text) return { ok: false, error: 'Describe the time and what should alert.' };
  if (!describesDoorRule(text)) return { ok: false, error: OUT_OF_SCOPE };
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { ok: false, error: 'A Gemini key is not set on this server. Build the rule from the choices.' };
  const models = [process.env.GEMINI_MODEL, ...MODELS].filter((model, index, list): model is string => Boolean(model) && list.indexOf(model) === index);
  let lastStatus = 0;
  for (const model of models) {
    let response;
    try {
      response = await askModel(model, text, key);
    } catch {
      continue;
    }
    lastStatus = response.status;
    if (response.status === 404) continue;
    if (!response.ok) break;
    const body = await response.json().catch(() => ({}));
    const parsed = parseModelJson(readText(body));
    if (!parsed) return { ok: false, error: 'Gemini could not fill the form. Build the rule from the choices.' };
    if (parsed.inScope === false || parsed.inScope === 'false') return { ok: false, error: OUT_OF_SCOPE };
    const rule = sanitizeRule(parsed);
    if (!rule) return { ok: false, error: 'That sentence did not fit a door rule. Use the choices below.' };
    return { ok: true, rule };
  }
  if (lastStatus === 401 || lastStatus === 403) {
    return { ok: false, error: 'Gemini did not accept the key. Build the rule from the choices.' };
  }
  return { ok: false, error: 'Gemini could not fill the form. Build the rule from the choices.' };
}
