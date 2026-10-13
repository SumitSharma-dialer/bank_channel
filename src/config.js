'use strict';
const env = process.env;

module.exports = {
  http: { host: env.HTTP_HOST || '0.0.0.0', port: +(env.HTTP_PORT || 3000) },
  adminPassword: env.ADMIN_PASSWORD || '',
  publicIp: env.PUBLIC_IP || '127.0.0.1',
  sipPort: +(env.SIP_PORT || 5060),
  ari: {
    url: (env.ARI_URL || 'http://127.0.0.1:8088').replace(/\/$/, ''),
    user: env.ARI_USER || 'channel_ari',
    pass: env.ARI_PASS || '',
    app: env.ARI_APP || 'sipdist',
  },
  asterisk: {
    confDir: env.ASTERISK_CONF_DIR || '/etc/asterisk/sipdist',
    reload: env.ASTERISK_RELOAD !== '0',
    log: env.ASTERISK_LOG || '/var/log/asterisk/full',   // logger.conf full => notice,warning,error,verbose(3),dtmf (= CLI output)
  },
  // second SIP engine (System page → SIP engine). Only one of Asterisk / Kamailio runs at a time.
  kamailio: {
    confDir: env.KAMAILIO_CONF_DIR || '/etc/kamailio/sipdist',
    listenIp: env.KAMAILIO_LISTEN_IP || '',        // '' = this server's main IPv4 address
    advertiseIp: env.KAMAILIO_ADVERTISE_IP || '',  // set only when SIP / RTP must show another (public) address
    rpcPort: +(env.KAMAILIO_RPC_PORT || 5065),     // JSON-RPC over HTTP on 127.0.0.1
    ngPort: +(env.RTPENGINE_NG_PORT || 2223),      // rtpengine control port on 127.0.0.1
    children: +(env.KAMAILIO_CHILDREN || 16),
    evKey: env.KAMAILIO_EVENT_KEY || 'sd:kam:ev',  // Redis list: call events Kamailio -> src/tracker.js
    sizesKey: env.KAMAILIO_SIZES_KEY || 'sd:kam:sizes',
    reload: env.KAMAILIO_RELOAD !== '0',
  },
  // engine switch requests for the root helper (deploy/sipdist-engine.sh)
  stateDir: env.SIPDIST_STATE_DIR || '/var/lib/sipdist',
  // RTP port range of rtp.conf (used by the Diagnostics RTP capture)
  rtp: { start: +(env.RTP_START || 10000), end: +(env.RTP_END || 30000) },
  db: {
    host: env.DB_HOST || '127.0.0.1',
    port: +(env.DB_PORT || 5432),
    database: env.DB_NAME || 'channel_bank',
    user: env.DB_USER || 'channel_bank',
    password: env.DB_PASS || '',
    max: 10,
  },
  // REDIS_URL wins; otherwise built from REDIS_HOST / REDIS_PORT / REDIS_PASS
  redisUrl: env.REDIS_URL ||
    `redis://${env.REDIS_PASS ? ':' + encodeURIComponent(env.REDIS_PASS) + '@' : ''}${env.REDIS_HOST || '127.0.0.1'}:${env.REDIS_PORT || 6379}/0`,
  statsTz: env.STATS_TZ || 'Asia/Kolkata',
};
