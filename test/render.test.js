'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { renderTrunks, renderProcesses, renderDialplan, peerConfig } = require('../src/asterisk/render');

const trunk = { id: 1, name: 'airtel1', host: '10.1.1.1', port: 5060, transport: 'udp', username: 'u1', password: 'p1',
  register: true, max_channels: 30, prefix: '0', strip_digits: 2, codecs: 'ulaw,alaw', dial_timeout: 45, active: true };
const proc = { id: 1, code: 'acme', name: 'Acme Dialer', trunk_id: 1, channel_limit: 10, auth_type: 'password',
  sip_username: 'acme', sip_password: 'secret123', allowed_ips: '', cli_mode: 'dummy', dummy_cli: '9876543210',
  codecs: 'ulaw', active: true };

test('trunk renders aor, auth, endpoint, identify, registration', () => {
  const t = renderTrunks([trunk]);
  for (const s of ['[t_airtel1]\ntype=aor', '[t_airtel1-auth]', 'type=endpoint', '[t_airtel1-identify]', '[t_airtel1-reg]', 'contact=sip:10.1.1.1:5060'])
    assert.ok(t.includes(s), s);
});

test('inactive trunk is not rendered', () => {
  assert.ok(!renderTrunks([{ ...trunk, active: false }]).includes('[t_airtel1]'));
});

test('password process uses auth_username identification', () => {
  const p = renderProcesses([proc]);
  assert.ok(p.includes('identify_by=auth_username,username'));
  assert.ok(p.includes('[p_acme-auth]') && p.includes('password=secret123'));
});

test('ip process renders identify with every IP', () => {
  const p = renderProcesses([{ ...proc, auth_type: 'ip', allowed_ips: '1.2.3.4,5.6.7.0/24' }]);
  assert.ok(p.includes('match=1.2.3.4') && p.includes('match=5.6.7.0/24') && !p.includes('-auth]'));
});

test('dialplan enforces process + trunk limits with join-then-check', () => {
  const d = renderDialplan([proc], [trunk]);
  assert.ok(d.includes('Set(GROUP(sdproc)=acme)'));
  assert.ok(d.includes('GROUP_COUNT(acme@sdproc)} > 10]?plimit'));
  assert.ok(d.includes('GROUP_COUNT(airtel1@sdtrunk)} > 30]?tlimit'));
  assert.ok(d.includes('Set(SD_DEST=${SD_CNUM})') && d.includes('Set(SD_OUT=0${SD_DEST:2})'));
  assert.ok(d.includes('Dial(PJSIP/${SD_OUT}@t_airtel1,45)'));
  assert.ok(d.indexOf('Set(GROUP(sdproc)') < d.indexOf('GROUP_COUNT(acme'), 'join before count');
});

test('inactive process -> BLOCKED, no trunk -> NO_ROUTE', () => {
  assert.ok(renderDialplan([{ ...proc, active: false }], [trunk]).includes('SD_DISP=BLOCKED'));
  assert.ok(renderDialplan([{ ...proc, trunk_id: null }], [trunk]).includes('SD_DISP=NO_ROUTE'));
  assert.ok(renderDialplan([proc], [{ ...trunk, active: false }]).includes('SD_DISP=NO_ROUTE'));
});

test('unlimited trunk skips trunk group', () => {
  assert.ok(!renderDialplan([proc], [{ ...trunk, max_channels: 0 }]).includes('sdtrunk'));
});

test('config injection is stripped', () => {
  const out = renderTrunks([{ ...trunk, password: 'x\n[evil]\ntype=endpoint' }]);
  assert.ok(!out.includes('[evil]'));
  assert.throws(() => renderProcesses([{ ...proc, code: 'bad code' }]));
});

test('peer config contains public IP and credentials', () => {
  const c = peerConfig(proc, '203.0.113.10');
  assert.ok(c.pjsip.includes('contact=sip:203.0.113.10:5060') && c.pjsip.includes('password=secret123'));
  assert.ok(c.chan_sip.includes('host=203.0.113.10'));
});

test('inbound DIDs are routed only when the trunk allows inbound', () => {
  const did_ranges = [{ first_did: '912240001000', last_did: '912240001099', process_id: 1, use_as_cli: true }];
  const on = { ...trunk, did_ranges };
  const off = { ...trunk, did_ranges, allow_inbound: false };
  assert.ok(renderTrunks([on]).includes('context=sd-in-airtel1'));
  assert.ok(renderDialplan([proc], [on]).includes('[sd-in-airtel1]'));
  assert.ok(renderTrunks([off]).includes('context=sd-from-trunk'));
  const dp = renderDialplan([{ ...proc, cli_mode: 'trunk_did' }], [off]);
  assert.ok(!dp.includes('[sd-in-airtel1]'), 'no inbound context');
  assert.ok(dp.includes('[sd-cli-airtel1]'), 'DIDs still used as caller ID');
});

test('outbound disabled -> BLOCKED; working time -> GotoIfTime + OFF_HOURS', () => {
  assert.ok(renderDialplan([{ ...proc, allow_outbound: false }], [trunk]).includes('Set(SD_DISP=BLOCKED)'));
  const dp = renderDialplan([{ ...proc, out_hours: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '18:00' } }], [trunk], 'Asia/Kolkata');
  assert.ok(dp.includes('GotoIfTime(09:00-18:00,mon&tue&wed&thu&fri,*,*,Asia/Kolkata?open)'));
  assert.ok(dp.includes('Set(SD_DISP=OFF_HOURS)') && dp.includes('n(open),'));
  const all = renderDialplan([{ ...proc, out_hours: { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '22:00', to: '06:00' } }], [trunk]);
  assert.ok(all.includes('GotoIfTime(22:00-06:00,*,*,*?open)'));
  assert.ok(!renderDialplan([proc], [trunk]).includes('GotoIfTime'), 'no gate when any time');
});

test('inbound DID: disabled -> BLOCKED, working time gate per process', () => {
  const did_ranges = [{ first_did: '912240001000', last_did: '912240001099', process_id: 1, use_as_cli: false }];
  const ip = { ...proc, auth_type: 'ip', allowed_ips: '1.2.3.4' };
  const t = { ...trunk, did_ranges };
  const off = renderDialplan([{ ...ip, allow_inbound: false }], [t]);
  assert.ok(/n\(in_acme\)[\s\S]*inbound calls disabled[\s\S]*SD_DISP=BLOCKED/.test(off) && !off.includes('@p_acme,'));
  const on = renderDialplan([{ ...ip, in_hours: { days: ['sat', 'sun'], from: '10:00', to: '14:00' } }], [t], 'Asia/Kolkata');
  assert.ok(on.includes('GotoIfTime(10:00-14:00,sat&sun,*,*,Asia/Kolkata?in_acme_open)') && on.includes('@p_acme,45,'));
});

test('inbound DID: app lookup, then assigned process; customer number dialed with the DID as caller ID', () => {
  const t = { ...trunk, did_ranges: [{ first_did: '1234', last_did: '1256', process_id: 1, use_as_cli: true }, { first_did: '23456', last_did: '23489', process_id: null, use_as_cli: true }] };
  const ip = { ...proc, auth_type: 'ip', allowed_ips: '1.2.3.4' };
  const dp = renderDialplan([ip], [t], 'Asia/Kolkata', 'http://127.0.0.1:3000/internal/did-route');
  assert.ok(dp.includes('CURL(http://127.0.0.1:3000/internal/did-route?did=${SD_DIDM}&from=${SD_CUST})'), 'asks the app');
  assert.ok(dp.includes('Set(SD_ASG=acme)') && dp.includes('Set(SD_ASG=)'), 'assigned fallback per range');
  assert.ok(dp.includes('ExecIf($["${SD_INPROC}" = ""]?Set(SD_INPROC=${SD_ASG}))'));
  assert.ok(dp.includes('GotoIf($["${SD_INPROC}" = "acme"]?in_acme)'));
  assert.ok(dp.includes('Set(CALLERID(all)=${SD_DIDM} <${SD_DIDM}>)'), 'caller ID = DID');
  assert.ok(dp.includes('Dial(PJSIP/${SD_OUT}@p_acme,45,b(sd-inhdr^s^1(${SD_DIDM},${SD_CUST})))'), 'customer number + headers');
  assert.ok(dp.includes('[sd-inhdr]') && dp.includes('PJSIP_HEADER(add,X-DID)'));
  assert.ok(!renderDialplan([ip], [t]).includes('CURL('), 'no lookup URL -> assigned only');
});

test('outbound: only the dummy number with X-DID + X-Number; DID checked against trunk; everything else rejected', () => {
  const t = { ...trunk, did_ranges: [{ first_did: '912240001000', last_did: '912240001099', use_as_cli: true }] };
  const dp = renderDialplan([proc], [t]);
  assert.ok(dp.includes('exten => 9876543210,1,'), 'dummy number extension');
  assert.ok(!dp.includes('exten => _[+0-9]X.'), 'no generic dialing');
  assert.ok(/exten => _\.,1,NoOp\(dialed number is not the dummy number[\s\S]*SD_DISP=INVALID/.test(dp), 'other numbers -> INVALID');
  assert.ok(dp.includes('PJSIP_HEADER(read,X-DID)') && dp.includes('PJSIP_HEADER(read,X-Number)'));
  assert.ok(!dp.includes('?plain'), 'headers are mandatory');
  assert.ok(dp.includes('Set(CALLERID(all)=${SD_DID} <${SD_DID}>)'));
  assert.ok(dp.includes('Gosub(sd-didok-airtel1,s,1)') && dp.includes('[sd-didok-airtel1]'));
  assert.ok(dp.includes('Set(SD_DISP=NO_HEADER)') && dp.includes('Set(SD_DISP=INVALID_DID)'));
  assert.ok(renderDialplan([proc], [trunk]).includes('Set(SD_DIDOK=0)'), 'trunk without caller-ID DIDs rejects every call');
  const none = renderDialplan([{ ...proc, dummy_cli: '' }], [t]);
  assert.ok(none.includes('no valid dummy number') && !none.includes('PJSIP_HEADER(read'), 'no dummy number -> all rejected');
});

test("contexts with a catch-all '_.' have an explicit h extension", () => {
  const dp = renderDialplan([proc, { ...proc, id: 2, code: 'off', active: false }], [trunk]);
  for (const ctx of dp.split(/\n(?=\[)/).filter((c) => c.includes('exten => _.,1')))
    assert.ok(ctx.includes('exten => h,1,Hangup()'), ctx.split('\n')[0]);
});
