import { randomBytes } from 'node:crypto';
import { config } from './config.js';

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** YYYY-MM-DD in the configured timezone */
export const dateKey = (d = new Date()) => dayFmt.format(d);

const B62 = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export function genPassword(len = 20) {
  const bytes = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += B62[bytes[i] % B62.length];
  return s;
}

/** ARI timestamps look like 2026-10-06T13:10:00.123+0530 - make them ISO */
export function parseAriTime(s) {
  if (!s) return new Date();
  const d = new Date(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
