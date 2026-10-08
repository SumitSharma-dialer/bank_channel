'use strict';
const env = process.env;

module.exports = {
  http: { host: env.HTTP_HOST || '0.0.0.0', port: +(env.HTTP_PORT || 3000) },
  sessionSecret: env.SESSION_SECRET || 'dev-secret-change-me',
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
    log: env.ASTERISK_LOG || '/var/log/asterisk/messages.log',
  },
  // RTP port range of rtp.conf (used by the Diagnostics RTP capture)
  rtp: { start: +(env.RTP_START || 10000), end: +(env.RTP_END || 20000) },
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
