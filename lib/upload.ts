export function videoFromRequest(raw: Buffer, contentType: string): Buffer | null {
  if (!raw || raw.length < 64) return null;
  const type = String(contentType || '');
  if (/video\/|application\/octet-stream/i.test(type) && !/multipart\//i.test(type)) {
    return raw;
  }
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type);
  if (!match) return null;
  const boundary = Buffer.from(`--${(match[1] || match[2]).trim()}`);
  let cursor = 0;
  let picked: Buffer | null = null;
  while (cursor < raw.length) {
    const start = raw.indexOf(boundary, cursor);
    if (start < 0) break;
    const after = start + boundary.length;
    if (raw.slice(after, after + 2).toString() === '--') break;
    const headerStart = after + (raw.slice(after, after + 2).toString() === '\r\n' ? 2 : 0);
    const split = raw.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (split < 0) break;
    const headers = raw.slice(headerStart, split).toString('utf8');
    const bodyStart = split + 4;
    const next = raw.indexOf(boundary, bodyStart);
    const bodyEnd = next < 0 ? raw.length : next;
    let body = raw.slice(bodyStart, bodyEnd);
    if (body.length >= 2 && body.slice(-2).toString() === '\r\n') body = body.slice(0, -2);
    cursor = bodyEnd;
    const named = /filename=/i.test(headers) || /name="file"/i.test(headers) || /video\//i.test(headers);
    if (named && body.length >= 64) return Buffer.from(body);
    if (body.length > 64 && body.length > (picked ? picked.length : 0)) picked = Buffer.from(body);
  }
  return picked && picked.length >= 64 ? picked : null;
}
