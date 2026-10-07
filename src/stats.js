import { q } from './db.js';
import { redis, K } from './redis.js';
import { state } from './state.js';
import { dateKey, parseAriTime } from './util.js';
import { log } from './log.js';

/** daily_stats column for each disposition (whitelist - used in SQL) */
export const DISPO_COL = {
  ANSWERED: 'answered', BUSY: 'busy', NO_ANSWER: 'no_answer', CANCEL: 'cancelled',
  CONGESTION: 'congestion', FAILED: 'failed', CHANNEL_LIMIT: 'channel_limit',
  TRUNK_LIMIT: 'trunk_limit', BLOCKED: 'blocked', NO_ROUTE: 'no_route', INVALID: 'invalid',
};

export function mapDisposition(result, dialstatus) {
  switch (result) {
    case 'PROC_LIMIT': return 'CHANNEL_LIMIT';
    case 'TRUNK_LIMIT': return 'TRUNK_LIMIT';
    case 'BLOCKED': return 'BLOCKED';
    case 'NO_ROUTE': return 'NO_ROUTE';
    case 'INVALID': return 'INVALID';
    case 'DIAL': break;
    default: return 'CANCEL'; // hung up before routing finished
  }
  switch (dialstatus) {
    case 'ANSWER': return 'ANSWERED';
    case 'BUSY': return 'BUSY';
    case 'NOANSWER': return 'NO_ANSWER';
    case 'CANCEL': case '': case undefined: return 'CANCEL';
    case 'CONGESTION': return 'CONGESTION';
    default: return 'FAILED'; // CHANUNAVAIL, DONTCALL, TORTURE, INVALIDARGS
  }
}

async function bumpDaily(day, type, id, code, disposition, talk) {
  const col = DISPO_COL[disposition];
  if (!col || !id) return;
  await q(
    `INSERT INTO daily_stats (stat_date, entity_type, entity_id, entity_code, total_calls, ${col}, talk_seconds)
     VALUES ($1, $2, $3, $4, 1, 1, $5)
     ON CONFLICT (stat_date, entity_type, entity_id) DO UPDATE SET
       total_calls  = daily_stats.total_calls + 1,
       ${col}       = daily_stats.${col} + 1,
       talk_seconds = daily_stats.talk_seconds + EXCLUDED.talk_seconds,
       entity_code  = EXCLUDED.entity_code,
       updated_at   = now()`,
    [day, type, id, code, talk],
  );
}

/** Called for each SIPDIST_END user event (one per customer call) */
export async function recordCall(ev, d) {
  const proc = state.processByCode.get(d.proc) || null;
  const trunkRef = d.trunk ? state.byEndpoint.get(d.trunk) : null;
  const trunk = trunkRef ? state.trunkById.get(trunkRef.id) : null;

  const started = parseAriTime(ev.channel?.creationtime);
  const ended = parseAriTime(ev.timestamp);
  const total = Math.max(0, Math.round((ended - started) / 1000));
  const talk = Math.max(0, Math.round(parseFloat(d.answered) || 0));
  const dialed = Math.max(0, Math.round(parseFloat(d.dialed) || 0));
  const ring = Math.max(0, dialed - talk);
  const disposition = mapDisposition(d.result, d.dialstatus);
  const day = dateKey(started);
  const answeredAt = talk > 0 ? new Date(ended.getTime() - talk * 1000) : null;

  const ins = await q(
    `INSERT INTO calls (uniqueid, call_date, process_id, trunk_id, process_code, trunk_code, caller_id,
       dialed_number, disposition, dial_status, hangup_cause, ring_sec, talk_sec, total_sec,
       started_at, answered_at, ended_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (uniqueid) DO NOTHING`,
    [ev.channel?.id, day, proc?.id ?? null, trunk?.id ?? null, d.proc || null, trunk?.code ?? null,
      d.clid || null, d.number || null, disposition, d.dialstatus || null,
      Number.parseInt(d.cause, 10) || null, ring, talk, total, started, answeredAt, ended],
  );
  if (ins.rowCount === 0) return; // duplicate event

  await bumpDaily(day, 'process', proc?.id, proc?.code, disposition, talk);
  if (trunk) await bumpDaily(day, 'trunk', trunk.id, trunk.code, disposition, talk);
}

/** Copy today's (and yesterday's) Redis peaks into daily_stats */
export async function flushPeaks() {
  const days = [dateKey(), dateKey(new Date(Date.now() - 86400000))];
  for (const day of days) {
    for (const type of ['process', 'trunk']) {
      const h = await redis.hgetall(K.peak(day, type));
      for (const [code, val] of Object.entries(h)) {
        const ent = type === 'process' ? state.processByCode.get(code) : state.trunkByCode.get(code);
        if (!ent) continue;
        await q(
          `INSERT INTO daily_stats (stat_date, entity_type, entity_id, entity_code, peak_channels)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (stat_date, entity_type, entity_id) DO UPDATE SET
             peak_channels = GREATEST(daily_stats.peak_channels, EXCLUDED.peak_channels), updated_at = now()`,
          [day, type, ent.id, code, Number(val) || 0],
        );
      }
    }
  }
}

export function startStats() {
  setInterval(() => flushPeaks().catch((e) => log.warn('peak flush failed:', e.message)), 30000);
}
