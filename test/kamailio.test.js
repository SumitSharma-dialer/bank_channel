'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../src/kamailio/render');
const { kamCall } = require('../src/kamailio/events');
const { parseDispatcher, parseUacReg, parseUsrloc } = require('../src/kamailio/status');
const { kamLine } = require('../src/enginelog');

const trunk = { id: 1, name: 'airtel1', host: '10.1.1.1', port: 5061, transport: 'udp', username: 'u1', password: 'p:1', register: true,
  max_channels: 30, cps: 5, prefix: '0', strip_digits: 2, cli_prefix: '0091', codecs: 'ulaw,alaw,g729', dial_timeout: 45, active: true, allow_inbound: true,
  did_ranges: [{ first_did: '8064258401', last_did: '8064258550', process_id: 1, use_as_cli: true }, { first_did: '8064258551', last_did: '8064258600', process_id: null, use_as_cli: false }] };
const ipProc = { id: 1, code: 'acme', name: 'Acme', trunk_id: 1, channel_limit: 10, auth_type: 'ip', allowed_ips: '1.2.3.4, 5.6.7.0/24', sip_port: 5080,
  dummy_cli: '9876543210', codecs: 'ulaw', active: true, out_hours: { days: ['mon', 'sun'], from: '09:45', to: '19:00' } };
const pwProc = { id: 2, code: 'pw', name: 'Pw', trunk_id: 1, channel_limit: 5, auth_type: 'password', sip_username: 'pwuser', sip_password: 'se"cr\\et',
  allowed_ips: '9.9.9.9', dummy_cli: '1234567890', codecs: 'ulaw', active: true, allow_inbound: false };
const o = { selfIp: '10.0.0.5', sipPort: 5060, rpcPort: 5065, ngPort: 2223, dir: '/etc/kamailio/sipdist', rpcKey: 'k', evKey: 'sd:kam:ev', sizesKey: 'sd:kam:sizes',
  routeUrl: 'http://127.0.0.1:3000/internal/did-route', rejectCodes: { CHANNEL_LIMIT: 486, BLOCKED: 999 }, redis: { host: '127.0.0.1', port: 6379, pass: 'x' }, rtpStart: 10000, rtpEnd: 30000 };

test('data: processes, trunks and who is identified by which IP', () => {
  const D = R.buildData([trunk], [ipProc, pwProc], o);
  assert.deepStrictEqual(D.ip2proc, { '1.2.3.4': 'acme', '9.9.9.9': 'pw' });
  assert.deepStrictEqual(D.cidr2proc, [[...R.cidr('5.6.7.0/24'), 'acme']]);
  assert.deepStrictEqual(D.user2proc, { pwuser: 'pw' });
  assert.deepStrictEqual(D.ip2trunk, { '10.1.1.1': 'airtel1' });
  assert.strictEqual(D.procs.acme.dst, 'sip:1.2.3.4:5080');
  assert.strictEqual(D.procs.pw.dst, null);
  assert.strictEqual(D.procs.pw.inb, false);
  assert.deepStrictEqual(D.procs.acme.out_hours, { days: { 1: true, 2: true }, from: 585, to: 1140 });
  const t = D.trunks.airtel1;
  assert.deepStrictEqual([t.port, t.max, t.cps, t.prefix, t.strip, t.cli_prefix, t.timeout], [5061, 30, 5, '0', 2, '0091', 45]);
  assert.deepStrictEqual(t.codecs, ['PCMU', 'PCMA', 'G729']);
  assert.strictEqual(t.cli_ranges.length, 1);
  assert.deepStrictEqual(t.in_ranges.map((r) => r.proc), ['acme', null]);
});

test('data: reject codes from the Dispositions page, unknown codes keep the default', () => {
  const D = R.buildData([trunk], [ipProc], o);
  assert.strictEqual(D.reject.CHANNEL_LIMIT, 486);
  assert.strictEqual(D.reject.BLOCKED, 403);
});

test('data: inactive trunk is left out, its processes have no route', () => {
  const D = R.buildData([{ ...trunk, active: false }], [ipProc], o);
  assert.deepStrictEqual(D.trunks, {});
  assert.strictEqual(D.procs.acme.trunk, null);
  assert.strictEqual(D.procs.acme.trunk_name, 'airtel1');
});

test('data: trunk host given as a name is identified by its resolved IPs', () => {
  const D = R.buildData([{ ...trunk, host: 'sip.carrier.example' }], [], { ...o, hostIps: { 'sip.carrier.example': ['20.0.0.1', '20.0.0.2'] } });
  assert.deepStrictEqual(D.ip2trunk, { '20.0.0.1': 'airtel1', '20.0.0.2': 'airtel1' });
});

test('cidr: network / divisor pairs for Lua', () => {
  const [net, div] = R.cidr('10.23.0.0/16');
  const n = (ip) => ip.split('.').reduce((a, x) => a * 256 + +x, 0);
  assert.strictEqual(Math.floor(n('10.23.200.7') / div), net);
  assert.notStrictEqual(Math.floor(n('10.24.0.1') / div), net);
  assert.strictEqual(R.cidr('1.2.3.4'), null);
});

test('lua literal: quotes and backslashes are escaped, control characters dropped', () => {
  assert.strictEqual(R.lua('a"b\\c\nd'), '"a\\"b\\\\cd"');
  assert.strictEqual(R.lua({ a: [1, true, null] }), '{\n  ["a"] = {\n    1,\n    true,\n    nil\n  }\n}');
});

test('data.lua is valid Lua', { skip: (() => { try { execFileSync('lua', ['-v'], { stdio: 'ignore' }); return false; } catch { return 'lua not installed'; } })() }, () => {
  const f = path.join(os.tmpdir(), `sipdist-data-${process.pid}.lua`);
  fs.writeFileSync(f, R.renderData([trunk], [ipProc, pwProc], o));
  try {
    const out = execFileSync('lua', ['-e', `local D = dofile("${f}"); io.write(D.procs.pw.pass, "|", D.trunks.airtel1.pass, "|", #D.trunks.airtel1.in_ranges)`]).toString();
    assert.strictEqual(out, 'se"cr\\et|p:1|2');
  } finally { fs.unlinkSync(f); }
});

test('dispatcher: trunks in set 1, fixed IPs of IP processes in set 2', () => {
  const d = R.renderDispatcher([trunk], [ipProc, pwProc]);
  assert.ok(d.includes('1 sip:10.1.1.1:5061 0 0 duid=t_airtel1\n'));
  assert.ok(d.includes('2 sip:1.2.3.4:5080 0 0 duid=p_acme_1.2.3.4\n'));
  assert.ok(!d.includes('5.6.7.0') && !d.includes('9.9.9.9'));
});

test('uacreg: one row per registering trunk, ":" escaped', () => {
  const rows = R.renderUacreg([trunk, { ...trunk, id: 2, name: 'noreg', register: false }], o).trim().split('\n');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1], '1:u1:u1:10.0.0.5:u1:10.1.1.1\\:5061::u1:p\\:1::sip\\:10.1.1.1\\:5061:3600:0:0:10.0.0.5\\:5060:');
});

test('uacreg: IMS username user@domain registers user at the domain via the trunk host', () => {
  const rows = R.renderUacreg([{ ...trunk, host: '10.5.70.19', port: 5060, username: '+91804@ka.ims.airtel.in' }], o).trim().split('\n');
  assert.strictEqual(rows[1], '1:+91804:+91804:10.0.0.5:+91804:ka.ims.airtel.in::+91804@ka.ims.airtel.in:p\\:1::sip\\:10.5.70.19\\:5060:3600:0:0:10.0.0.5\\:5060:');
});

test('carrier on its own port: own socket, rtpengine interface, uacreg contact, dispatcher socket', () => {
  const ims = { ...trunk, name: 'airtel_r', host: '10.5.70.19', port: 5060, username: '+918040102400@ka.ims.airtel.in' };
  const m = { ...o, advertiseIp: '1.1.1.1', trunkSrc: { airtel1: '10.0.0.5', airtel_r: '10.37.101.114' } };
  m.carrierIps = R.carrierIps([trunk, ims], m);
  assert.deepStrictEqual(m.carrierIps, ['10.37.101.114']);
  const D = R.buildData([trunk, ims], [], m);
  assert.strictEqual(D.pub_iface, 'pub');
  assert.deepStrictEqual([D.trunks.airtel_r.sock, D.trunks.airtel_r.iface, D.trunks.airtel_r.domain, D.trunks.airtel_r.from_domain],
    ['udp:10.37.101.114:5060', 'car_10_37_101_114', 'ka.ims.airtel.in', 'ka.ims.airtel.in']);
  assert.deepStrictEqual([D.trunks.airtel1.sock, D.trunks.airtel1.iface, D.trunks.airtel1.domain], [null, 'pub', null]);
  const c = R.renderCfg(m);
  for (const x of ['modparam("rr", "enable_full_lr", 0)', 'listen=udp:10.0.0.5:5060 advertise 1.1.1.1:5060 name "pub_udp"\n', 'listen=udp:10.37.101.114:5060 name "car_10_37_101_114_udp"\n',
    'listen=tcp:10.37.101.114:5060 name "car_10_37_101_114_tcp"\n', 'listen=tcp:127.0.0.1:5065 name "rpc"\n', 'mhomed=1\n', 'modparam("topoh", "mask_ip", "")'])
    assert.ok(c.includes(x), x);
  assert.ok(R.renderRtpengine(m).includes('interface = pub/10.0.0.5!1.1.1.1;car_10_37_101_114/10.37.101.114\n'));
  const u = R.renderUacreg([ims], m).trim().split('\n')[1];
  assert.ok(u.endsWith(':10.37.101.114\\:5060:udp\\:10.37.101.114\\:5060'), u);
  assert.ok(R.renderDispatcher([trunk, ims], [], m).includes('duid=t_airtel_r;socket=udp:10.37.101.114:5060\n'));
  assert.ok(R.renderDispatcher([trunk, ims], [], m).includes('duid=t_airtel1\n'));
  // nothing on another port: config exactly as before
  const one = { ...o, trunkSrc: { airtel1: '10.0.0.5' } };
  one.carrierIps = R.carrierIps([trunk], one);
  assert.ok(R.renderCfg(one).includes('mhomed=0\n') && !R.renderCfg(one).includes(' name "') && R.renderCfg(one).includes('"mask_ip", "10.0.0.5"'));
  assert.ok(R.renderRtpengine(one).includes('interface = 10.0.0.5\n') && R.buildData([trunk], [], one).pub_iface === null);
});

test('regKey: IMS username user@domain matches the uacreg row (user part, auth proxy)', () => {
  const { regKey } = require('../src/kamailio/status');
  assert.strictEqual(regKey({ username: '+918040102400@ka.ims.airtel.in', host: '10.5.70.19', port: 5060 }), '+918040102400@sip:10.5.70.19:5060');
  assert.strictEqual(regKey({ username: 'u1', host: '10.1.1.1', port: 5061 }), 'u1@sip:10.1.1.1:5061');
});

test('kamailio.cfg: listens on the server IP, loads the Lua script, never prints an unknown advertise', () => {
  const c = R.renderCfg(o);
  for (const s of ['listen=udp:10.0.0.5:5060\n', 'listen=tcp:127.0.0.1:5065', 'cfgengine "lua"', 'modparam("app_lua", "load", "/etc/kamailio/sipdist/sipdist.lua")', 'profiles_with_value", "sdproc;sdtrunk"'])
    assert.ok(c.includes(s), s);
  assert.ok(R.renderCfg({ ...o, advertiseIp: '1.1.1.1' }).includes('listen=udp:10.0.0.5:5060 advertise 1.1.1.1:5060'));
  assert.ok(R.renderRtpengine({ ...o, advertiseIp: '1.1.1.1' }).includes('interface = 10.0.0.5!1.1.1.1'));
  assert.ok(R.renderRtpengine(o).includes('port-min = 10000') && R.renderRtpengine(o).includes('interface = 10.0.0.5\n'));
});

test('events: Kamailio results become the same dial status / cause Asterisk reports', () => {
  const base = { id: 'c1', proc: 'acme', trunk: 'airtel1', dir: 'out', num: '9876543210', out: '9876543210', start: 100, end: 130 };
  assert.deepStrictEqual((({ disp, cause, bill, dialed }) => ({ disp, cause, bill, dialed }))(kamCall({ ...base, res: 'answer', ans: 110 })), { disp: 'ANSWER', cause: 16, bill: 20, dialed: 30 });
  assert.deepStrictEqual([kamCall({ ...base, res: 'cancel', ring: 1 }).cause, kamCall({ ...base, res: 'cancel', ring: 0 }).cause], [19, 16]);
  assert.strictEqual(kamCall({ ...base, res: 'timeout', sip: 408 }).disp, 'NOANSWER');
  assert.deepStrictEqual([kamCall({ ...base, res: 'noreply', sip: 408 }).disp, kamCall({ ...base, res: 'noreply' }).cause], ['CHANUNAVAIL', 3]);
  assert.deepStrictEqual([kamCall({ ...base, res: 'fail', sip: 486 }).disp, kamCall({ ...base, res: 'fail', sip: 503 }).disp, kamCall({ ...base, res: 'fail', sip: 404 }).disp], ['BUSY', 'CONGESTION', 'CHANUNAVAIL']);
  const rej = kamCall({ id: 'c2', proc: 'acme', dir: 'out', disp: 'CHANNEL_LIMIT', sip: 503, start: 100, end: 100 });
  assert.deepStrictEqual([rej.disp, rej.cause, rej.dialed, rej.uid], ['CHANNEL_LIMIT', 34, 0, 'c2']);
});

test('status: dispatcher, trunk registrations and customer contacts', () => {
  const ds = parseDispatcher({ RECORDS: [{ SET: { ID: 1, TARGETS: [
    { DEST: { URI: 'sip:10.1.1.1:5061', FLAGS: 'AP', ATTRS: { DUID: 't_airtel1' }, LATENCY: { AVG: 12.34 } } },
    { DEST: { URI: 'sip:10.1.1.2:5060', FLAGS: 'IP', ATTRS: { DUID: 't_down' } } },
    { DEST: { URI: 'sip:10.1.1.3:5060', FLAGS: 'AX', ATTRS: { DUID: 't_new' } } }] } }] });
  assert.deepStrictEqual(ds.map((d) => [d.duid, d.up, d.checked, d.rtt]), [['t_airtel1', true, true, 12.3], ['t_down', false, true, null], ['t_new', true, false, null]]);
  const reg = parseUacReg([{ r_username: 'u1', auth_proxy: 'sip:10.1.1.1:5061', flags: 20, timer_expires: 1100 }, { r_username: 'u2', auth_proxy: 'sip:10.1.1.2:5060', flags: 16 }], 1000);
  assert.deepStrictEqual(reg['u1@sip:10.1.1.1:5061'], { serverUri: 'sip:10.1.1.1:5061', status: 'Registered', expiresIn: 100 });
  assert.strictEqual(reg['u2@sip:10.1.1.2:5060'].status, 'Unregistered');
  const ul = parseUsrloc({ Domains: [{ Domain: { AoRs: [{ Info: { AoR: 'p_pw', Contacts: [{ Contact: { Address: 'sip:pwuser@10.0.0.9:5060', Expires: 120, 'User-Agent': 'Asterisk PBX', Received: 'sip:9.9.9.9:5094' } }] } }] } }] }, 1000);
  assert.deepStrictEqual(ul.pw, [{ uri: 'sip:pwuser@10.0.0.9:5060', ip: '9.9.9.9', port: 5094, userAgent: 'Asterisk PBX', expiresAt: 121000 }]);
});

test('log: journal lines take the Asterisk log layout', () => {
  assert.strictEqual(kamLine('2026-10-13T17:34:34+05:30 host kamailio[123]: WARNING: <core> [x.c:1]: something'), '[2026-10-13 17:34:34] WARNING[123] <core> [x.c:1]: something');
  assert.strictEqual(kamLine('2026-10-13T17:34:34+05:30 host kamailio[123]: CRITICAL: boom'), '[2026-10-13 17:34:34] ERROR[123] boom');
  assert.strictEqual(kamLine('2026-10-13T17:34:34+05:30 host rtpengine[9]: INFO: [core] started'), '[2026-10-13 17:34:34] VERBOSE[9] [core] started');
});
