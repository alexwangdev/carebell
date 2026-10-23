import crypto from 'node:crypto';
import { speakTime } from './domain';
import type { DoorEvent } from './types';

export function configured(): boolean {
  return Boolean(process.env.BEDROCK_MODEL_ID && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest();
}

function signedPost({ url, body, region, service }: { url: string; body: string; region: string; service: string }) {
  const parsed = new URL(url);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const headerMap: Record<string, string> = {
    host: parsed.host,
    'content-type': 'application/json',
    'x-amz-date': amzDate
  };
  if (process.env.AWS_SESSION_TOKEN) headerMap['x-amz-security-token'] = process.env.AWS_SESSION_TOKEN;
  const names = Object.keys(headerMap).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headerMap[name]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonical = ['POST', parsed.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  let key = hmac(Buffer.from(`AWS4${process.env.AWS_SECRET_ACCESS_KEY}`, 'utf8'), dateStamp);
  key = hmac(key, region);
  key = hmac(key, service);
  key = hmac(key, 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  const send = { ...headerMap };
  delete send.host;
  send.authorization = `AWS4-HMAC-SHA256 Credential=${process.env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: send };
}

function promptFor(events: DoorEvent[], options: { anomaly?: boolean; contactName?: string }): string {
  const lines = events.map((event) => `${speakTime(event.localTime)} ${event.title}`);
  return [
    'Write one short English peace-of-mind report for the family of an older adult who lives alone.',
    'Use only the door events below.',
    'Start with how many activities happened, then the important times.',
    'A morning person followed later by another person can be described as leaving and coming home.',
    'One short midday visit can be described as a package drop-off.',
    'Mention a doorbell press when one happened.',
    'Do not invent times that are not in the list, and do not use technical terms.',
    options.anomaly ? 'There is an alert: no activity by check-in time. Ask the family to take a look.' : 'If nothing looks wrong, end with All clear.',
    `Emergency contact name: ${options.contactName || 'family'}`,
    'Events:',
    ...lines
  ].join('\n');
}

export async function summarizeWithBedrock(events: DoorEvent[], options: { anomaly?: boolean; contactName?: string } = {}): Promise<string | null> {
  if (!configured() || !events.length) return null;
  const region = process.env.AWS_REGION || 'us-east-1';
  const modelId = process.env.BEDROCK_MODEL_ID;
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(String(modelId))}/converse`;
  const body = JSON.stringify({
    messages: [{ role: 'user', content: [{ text: promptFor(events, options) }] }],
    inferenceConfig: { maxTokens: 180, temperature: 0.2 }
  });
  const { headers } = signedPost({ url, body, region, service: 'bedrock' });
  const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
  if (!response.ok) return null;
  const payload = await response.json() as { output?: { message?: { content?: { text?: string }[] } } };
  const text = payload?.output?.message?.content?.map((part) => part.text || '').join('').replace(/[\r\n]+/g, '').trim();
  if (!text || text.length > 180) return null;
  return text;
}
