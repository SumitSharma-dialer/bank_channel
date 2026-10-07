import { HttpError, genPassword } from './util.js';

const bad = (msg) => { throw new HttpError(400, msg); };

const RX = {
  code: /^[a-z0-9][a-z0-9_]{1,29}$/,
  host: /^(?=.{1,253}$)([a-zA-Z0-9-]{1,63}\.)*[a-zA-Z0-9-]{1,63}$/,
  user: /^[A-Za-z0-9_.+@-]{1,64}$/,
  secret: /^[!-~]{4,128}$/,              // printable ASCII, no spaces
  digits: /^[0-9]{0,20}$/,
  cli: /^\+?[0-9]{3,20}$/,
  codecs: /^[a-z0-9_]+(,[a-z0-9_]+){0,9}$/,
  ipv4: /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/([0-9]|[12]\d|3[0-2]))?$/,
  ipv6: /^[0-9a-fA-F:]{2,39}(\/\d{1,3})?$/,
};

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const bool = (v, def) => (v === undefined || v === null || v === '' ? def : v === true || v === 'true' || v === 1 || v === '1');
function int(v, name, min, max, def) {
  if ((v === undefined || v === null || v === '') && def !== undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) bad(`${name} must be a whole number between ${min} and ${max}`);
  return n;
}
function name(v) {
  const s = str(v);
  if (!s || s.length > 100) bad('Name is required (max 100 characters)');
  return s;
}
function secret(v, label) {
  const s = str(v);
  if (s.includes(';')) bad(`${label} must not contain ";"`);
  if (!RX.secret.test(s)) bad(`${label} must be 4-128 printable characters without spaces`);
  return s;
}

export function validateTrunk(b, existing = null) {
  const out = {};
  if (!existing) {
    out.code = str(b.code).toLowerCase();
    if (!RX.code.test(out.code)) bad('Code: 2-30 chars, lowercase letters, digits, underscore');
  }
  out.name = name(b.name);
  out.host = str(b.host);
  if (!RX.host.test(out.host)) bad('Host must be a valid IP address or hostname');
  out.port = int(b.port, 'Port', 1, 65535, 5060);
  out.transport = str(b.transport) || 'udp';
  if (!['udp', 'tcp'].includes(out.transport)) bad('Transport must be udp or tcp');
  out.username = str(b.username) || null;
  if (out.username && !RX.user.test(out.username)) bad('Username contains invalid characters');
  const pw = str(b.password);
  if (pw) out.password = secret(pw, 'Password');
  else if (!existing) out.password = null;
  else if (!out.username) out.password = null;            // auth removed
  if (out.username && !pw && !existing?.password) bad('Password is required when username is set');
  out.register = bool(b.register, true) && Boolean(out.username);
  out.from_user = str(b.from_user) || null;
  if (out.from_user && !RX.user.test(out.from_user)) bad('From user contains invalid characters');
  out.from_domain = str(b.from_domain) || null;
  if (out.from_domain && !RX.host.test(out.from_domain)) bad('From domain must be a hostname or IP');
  out.total_channels = int(b.total_channels, 'Total channels', 0, 100000);
  out.dial_prefix = str(b.dial_prefix);
  if (!RX.digits.test(out.dial_prefix)) bad('Dial prefix must be digits only');
  out.strip_digits = int(b.strip_digits, 'Strip digits', 0, 10, 0);
  out.dial_timeout = int(b.dial_timeout, 'Dial timeout', 5, 300, 60);
  out.codecs = (str(b.codecs) || 'ulaw,alaw').toLowerCase().replace(/\s+/g, '');
  if (!RX.codecs.test(out.codecs)) bad('Codecs must be a comma list like ulaw,alaw');
  out.active = bool(b.active, true);
  out.notes = str(b.notes) || null;
  return out;
}

export function validateProcess(b, existing = null) {
  const out = {};
  if (!existing) {
    out.code = str(b.code).toLowerCase();
    if (!RX.code.test(out.code)) bad('Code: 2-30 chars, lowercase letters, digits, underscore');
  }
  out.name = name(b.name);
  out.auth_mode = str(b.auth_mode) || 'password';
  if (!['password', 'ip'].includes(out.auth_mode)) bad('Auth mode must be password or ip');

  const ips = (Array.isArray(b.allowed_ips) ? b.allowed_ips : str(b.allowed_ips).split(/[\s,]+/))
    .map((x) => str(x)).filter(Boolean);
  for (const ip of ips) if (!RX.ipv4.test(ip) && !RX.ipv6.test(ip)) bad(`Invalid IP/CIDR: ${ip}`);
  out.allowed_ips = [...new Set(ips)];
  if (out.auth_mode === 'ip' && !out.allowed_ips.length) bad('IP auth mode needs at least one allowed IP');

  const code = existing?.code ?? out.code;
  out.sip_username = str(b.sip_username) || existing?.sip_username || code;
  if (!RX.user.test(out.sip_username)) bad('SIP username contains invalid characters');
  const pw = str(b.sip_password);
  if (pw) out.sip_password = secret(pw, 'SIP password');
  else if (!existing?.sip_password) out.sip_password = genPassword(20);

  out.channel_limit = int(b.channel_limit, 'Channel limit', 0, 100000);
  out.trunk_id = b.trunk_id === '' || b.trunk_id === null || b.trunk_id === undefined ? null : int(b.trunk_id, 'Trunk', 1, 2 ** 31 - 1);
  out.dummy_number = str(b.dummy_number) || null;
  if (out.dummy_number && !RX.cli.test(out.dummy_number)) bad('Dummy number must be 3-20 digits (optional leading +)');
  out.codecs = (str(b.codecs) || 'ulaw,alaw').toLowerCase().replace(/\s+/g, '');
  if (!RX.codecs.test(out.codecs)) bad('Codecs must be a comma list like ulaw,alaw');
  out.active = bool(b.active, true);
  out.notes = str(b.notes) || null;
  return out;
}

export const isId = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) bad('Invalid id');
  return n;
};
