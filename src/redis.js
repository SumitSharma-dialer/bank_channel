'use strict';
const Redis = require('ioredis');
const cfg = require('./config');

const redis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: true });
redis.on('error', (e) => console.error('[redis]', e.message));

// Atomic: +1 live counter and raise today's peak if needed.
redis.defineCommand('sdIncr', {
  numberOfKeys: 2,
  lua: `
    local v = redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
    local p = tonumber(redis.call('HGET', KEYS[2], ARGV[1]) or '0')
    if v > p then redis.call('HSET', KEYS[2], ARGV[1], v) end
    redis.call('EXPIRE', KEYS[2], 259200)
    return v`,
});
// Atomic: -1 live counter, never below zero.
redis.defineCommand('sdDecr', {
  numberOfKeys: 1,
  lua: `
    local v = redis.call('HINCRBY', KEYS[1], ARGV[1], -1)
    if v < 0 then redis.call('HSET', KEYS[1], ARGV[1], 0) v = 0 end
    return v`,
});

/* Key layout
   sd:live:proc            hash  code  -> live channels
   sd:live:trunk           hash  name  -> live channels
   sd:peak:proc:<day>      hash  code  -> peak today   (field "__all" = whole box)
   sd:peak:trunk:<day>     hash  name  -> peak today
   sd:hits:<code>:<t10>    int   hits in a 10 s bucket (TTL 1h)
   sd:hitsday:<day>        hash  code  -> hits today
   sd:ch:<channelId>       str   "p:code" | "t:name" (which counter this channel holds)
*/
module.exports = redis;
