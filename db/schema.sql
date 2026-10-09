-- SIP Channel Distributor — PostgreSQL schema
-- psql -h 127.0.0.1 -U channel_bank -d channel_bank -f db/schema.sql
-- Safe to run more than once.

SET client_min_messages = warning;
BEGIN;

-- An older table whose PRIMARY KEY uses columns this version doesn't have can't be upgraded in place:
-- rename it (with its indexes and sequences) to <name>_legacy_<timestamp>, data kept, and create a fresh one.
CREATE OR REPLACE FUNCTION pg_temp.sd_legacy(t text, cols text[]) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r record; suffix text := '_legacy_' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISS');
BEGIN
  IF to_regclass(t) IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                 WHERE i.indrelid = to_regclass(t) AND i.indisprimary AND NOT (a.attname = ANY(cols))) THEN RETURN; END IF;
  FOR r IN SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = to_regclass(t) LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I', r.relname, left(r.relname, 40) || suffix);
  END LOOP;
  FOR r IN SELECT s.relname FROM pg_class s JOIN pg_depend d ON d.objid = s.oid
           WHERE s.relkind = 'S' AND d.refobjid = to_regclass(t) AND d.deptype IN ('a','i') LOOP
    EXECUTE format('ALTER SEQUENCE %I RENAME TO %I', r.relname, left(r.relname, 40) || suffix);
  END LOOP;
  EXECUTE format('ALTER TABLE %I RENAME TO %I', t, t || suffix);
  RAISE WARNING 'old table % renamed to % (data kept) — incompatible primary key', t, t || suffix;
END $f$;

-- ---------------------------------------------------------------- admins
SELECT pg_temp.sd_legacy('admins', ARRAY['id','username','pass_hash','created_at']);
CREATE TABLE IF NOT EXISTS admins (
  id          SERIAL PRIMARY KEY,
  username    VARCHAR(64) UNIQUE NOT NULL,
  pass_hash   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- upgrade an older table in place
ALTER TABLE admins ADD COLUMN IF NOT EXISTS username    VARCHAR(64);
ALTER TABLE admins ADD COLUMN IF NOT EXISTS pass_hash   TEXT;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ NOT NULL DEFAULT now();
DO $$DECLARE c record; BEGIN  -- leftover NOT NULL columns from an older version must not block inserts
  FOR c IN SELECT column_name FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'admins' AND is_nullable = 'NO'
             AND column_default IS NULL
             AND column_name NOT IN (SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = to_regclass(table_name::text) AND i.indisprimary)
             AND column_name NOT IN ('id','username','pass_hash','created_at') LOOP
    EXECUTE format('ALTER TABLE admins ALTER COLUMN %I DROP NOT NULL', c.column_name);
  END LOOP; END$$;
-- Users page: role 'admin' (everything) or 'viewer' (monitor-only TL: read-only, only the listed processes and tabs)
ALTER TABLE admins ADD COLUMN IF NOT EXISTS role        VARCHAR(12) NOT NULL DEFAULT 'admin';
ALTER TABLE admins ADD COLUMN IF NOT EXISTS full_name   VARCHAR(100);
ALTER TABLE admins ADD COLUMN IF NOT EXISTS processes   TEXT[] NOT NULL DEFAULT '{}';   -- process codes (viewer)
ALTER TABLE admins ADD COLUMN IF NOT EXISTS tabs        TEXT[] NOT NULL DEFAULT '{}';   -- live / cdr / stats (viewer)
ALTER TABLE admins ADD COLUMN IF NOT EXISTS active      BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS last_login  TIMESTAMPTZ;
-- role 'superadmin' (everything + Activity log). Once, when it is introduced: the existing admins become super admins
-- (they already had full access); admins created afterwards are plain admins without the Activity log.
DO $$BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins WHERE role = 'superadmin') THEN
    UPDATE admins SET role = 'superadmin' WHERE role = 'admin';
  END IF; END$$;

-- Login sessions (src/auth.js): the cookie holds a random token, only its sha256 is stored.
-- Revoked on sign-out, from the Users page, or when the user is disabled / gets a new password.
CREATE TABLE IF NOT EXISTS sessions (
  id          BIGSERIAL PRIMARY KEY,
  token_hash  CHAR(64) UNIQUE NOT NULL,
  username    VARCHAR(64) NOT NULL,
  ip          VARCHAR(64),
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  revoked_by  VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(username);
CREATE INDEX IF NOT EXISTS sessions_open_idx ON sessions(expires_at) WHERE revoked_at IS NULL;


-- ---------------------------------------------------------------- trunks
-- One row = one carrier SIP trunk. Rendered into /etc/asterisk/sipdist/trunks.conf
SELECT pg_temp.sd_legacy('trunks', ARRAY['id','name','description','host','port','transport','username','password','register','from_user','from_domain','max_channels','prefix','strip_digits','codecs','dial_timeout','active','created_at','updated_at']);
CREATE TABLE IF NOT EXISTS trunks (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(32) UNIQUE NOT NULL CHECK (name ~ '^[a-z0-9_]{2,32}$'),
  description   TEXT,
  host          VARCHAR(255) NOT NULL,
  port          INT NOT NULL DEFAULT 5060 CHECK (port BETWEEN 1 AND 65535),
  transport     VARCHAR(8) NOT NULL DEFAULT 'udp' CHECK (transport IN ('udp','tcp')),
  username      VARCHAR(128),
  password      VARCHAR(128),
  register      BOOLEAN NOT NULL DEFAULT TRUE,
  from_user     VARCHAR(128),
  from_domain   VARCHAR(255),
  max_channels  INT NOT NULL DEFAULT 30 CHECK (max_channels >= 0),   -- 0 = unlimited
  prefix        VARCHAR(32) NOT NULL DEFAULT '',
  strip_digits  INT NOT NULL DEFAULT 0 CHECK (strip_digits BETWEEN 0 AND 10),
  codecs        VARCHAR(128) NOT NULL DEFAULT 'ulaw,alaw',
  dial_timeout  INT NOT NULL DEFAULT 60 CHECK (dial_timeout BETWEEN 5 AND 300),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- upgrade an older table in place
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS name          VARCHAR(32) CHECK (name ~ '^[a-z0-9_]{2,32}$');
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS description   TEXT;
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS host          VARCHAR(255);
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS port          INT NOT NULL DEFAULT 5060 CHECK (port BETWEEN 1 AND 65535);
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS transport     VARCHAR(8) NOT NULL DEFAULT 'udp' CHECK (transport IN ('udp','tcp'));
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS username      VARCHAR(128);
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS password      VARCHAR(128);
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS register      BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS from_user     VARCHAR(128);
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS from_domain   VARCHAR(255);
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS max_channels  INT NOT NULL DEFAULT 30 CHECK (max_channels >= 0);
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS prefix        VARCHAR(32) NOT NULL DEFAULT '';
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS strip_digits  INT NOT NULL DEFAULT 0 CHECK (strip_digits BETWEEN 0 AND 10);
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS codecs        VARCHAR(128) NOT NULL DEFAULT 'ulaw,alaw';
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS dial_timeout  INT NOT NULL DEFAULT 60 CHECK (dial_timeout BETWEEN 5 AND 300);
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS active        BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT now();
DO $$DECLARE c record; BEGIN  -- leftover NOT NULL columns from an older version must not block inserts
  FOR c IN SELECT column_name FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'trunks' AND is_nullable = 'NO'
             AND column_default IS NULL
             AND column_name NOT IN (SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = to_regclass(table_name::text) AND i.indisprimary)
             AND column_name NOT IN ('id','name','description','host','port','transport','username','password','register','from_user','from_domain','max_channels','prefix','strip_digits','codecs','dial_timeout','active','created_at','updated_at') LOOP
    EXECUTE format('ALTER TABLE trunks ALTER COLUMN %I DROP NOT NULL', c.column_name);
  END LOOP; END$$;


-- ------------------------------------------------------------- processes
-- One row = one customer Asterisk ("process"). Rendered into processes.conf + dialplan.conf
SELECT pg_temp.sd_legacy('processes', ARRAY['id','code','name','trunk_id','channel_limit','auth_type','sip_username','sip_password','allowed_ips','cli_mode','dummy_cli','codecs','active','notes','created_at','updated_at']);
CREATE TABLE IF NOT EXISTS processes (
  id             SERIAL PRIMARY KEY,
  code           VARCHAR(32) UNIQUE NOT NULL CHECK (code ~ '^[a-z0-9_]{2,32}$'),
  name           VARCHAR(128) NOT NULL,
  trunk_id       INT REFERENCES trunks(id) ON DELETE SET NULL,
  channel_limit  INT NOT NULL DEFAULT 10 CHECK (channel_limit >= 1),
  auth_type      VARCHAR(10) NOT NULL DEFAULT 'password' CHECK (auth_type IN ('password','ip')),
  sip_username   VARCHAR(64) UNIQUE,
  sip_password   VARCHAR(128),
  allowed_ips    TEXT NOT NULL DEFAULT '',                 -- comma separated, used when auth_type='ip'
  cli_mode       VARCHAR(12) NOT NULL DEFAULT 'dummy' CHECK (cli_mode IN ('dummy','passthrough')),
  dummy_cli      VARCHAR(32) NOT NULL DEFAULT '',
  codecs         VARCHAR(128) NOT NULL DEFAULT 'ulaw,alaw',
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- upgrade an older table in place
ALTER TABLE processes ADD COLUMN IF NOT EXISTS code           VARCHAR(32) CHECK (code ~ '^[a-z0-9_]{2,32}$');
ALTER TABLE processes ADD COLUMN IF NOT EXISTS name           VARCHAR(128);
ALTER TABLE processes ADD COLUMN IF NOT EXISTS trunk_id       INT;
ALTER TABLE processes ADD COLUMN IF NOT EXISTS channel_limit  INT NOT NULL DEFAULT 10 CHECK (channel_limit >= 1);
ALTER TABLE processes ADD COLUMN IF NOT EXISTS auth_type      VARCHAR(10) NOT NULL DEFAULT 'password' CHECK (auth_type IN ('password','ip'));
ALTER TABLE processes ADD COLUMN IF NOT EXISTS sip_username   VARCHAR(64);
ALTER TABLE processes ADD COLUMN IF NOT EXISTS sip_password   VARCHAR(128);
ALTER TABLE processes ADD COLUMN IF NOT EXISTS allowed_ips    TEXT NOT NULL DEFAULT '';
ALTER TABLE processes ADD COLUMN IF NOT EXISTS cli_mode       VARCHAR(12) NOT NULL DEFAULT 'dummy' CHECK (cli_mode IN ('dummy','passthrough'));
ALTER TABLE processes ADD COLUMN IF NOT EXISTS dummy_cli      VARCHAR(32) NOT NULL DEFAULT '';
ALTER TABLE processes ADD COLUMN IF NOT EXISTS codecs         VARCHAR(128) NOT NULL DEFAULT 'ulaw,alaw';
ALTER TABLE processes ADD COLUMN IF NOT EXISTS active         BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE processes ADD COLUMN IF NOT EXISTS notes          TEXT;
ALTER TABLE processes ADD COLUMN IF NOT EXISTS created_at     TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE processes ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ NOT NULL DEFAULT now();
DO $$BEGIN  -- an older version stored allowed_ips as TEXT[]; this version uses comma separated TEXT
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema()
      AND table_name = 'processes' AND column_name = 'allowed_ips') = 'ARRAY' THEN
    ALTER TABLE processes ALTER COLUMN allowed_ips DROP DEFAULT;
    ALTER TABLE processes ALTER COLUMN allowed_ips TYPE TEXT USING coalesce(array_to_string(allowed_ips, ','), '');
    ALTER TABLE processes ALTER COLUMN allowed_ips SET DEFAULT '';
  END IF; END$$;
DO $$DECLARE c record; BEGIN  -- leftover NOT NULL columns from an older version must not block inserts
  FOR c IN SELECT column_name FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'processes' AND is_nullable = 'NO'
             AND column_default IS NULL
             AND column_name NOT IN (SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = to_regclass(table_name::text) AND i.indisprimary)
             AND column_name NOT IN ('id','code','name','trunk_id','channel_limit','auth_type','sip_username','sip_password','allowed_ips','cli_mode','dummy_cli','codecs','active','notes','created_at','updated_at') LOOP
    EXECUTE format('ALTER TABLE processes ALTER COLUMN %I DROP NOT NULL', c.column_name);
  END LOOP; END$$;

CREATE INDEX IF NOT EXISTS processes_trunk_idx ON processes(trunk_id);

-- ---------------------------------------------------------- dispositions
SELECT pg_temp.sd_legacy('dispositions', ARRAY['code','label','source','sip_code','sort']);
CREATE TABLE IF NOT EXISTS dispositions (
  code        VARCHAR(16) PRIMARY KEY,
  label       VARCHAR(64) NOT NULL,
  source      VARCHAR(12) NOT NULL CHECK (source IN ('trunk','distributor')),
  sip_code    INT,
  sort        INT NOT NULL DEFAULT 0
);
-- upgrade an older table in place
ALTER TABLE dispositions ADD COLUMN IF NOT EXISTS label       VARCHAR(64);
ALTER TABLE dispositions ADD COLUMN IF NOT EXISTS source      VARCHAR(12) CHECK (source IN ('trunk','distributor'));
ALTER TABLE dispositions ADD COLUMN IF NOT EXISTS sip_code    INT;
ALTER TABLE dispositions ADD COLUMN IF NOT EXISTS sort        INT NOT NULL DEFAULT 0;
DO $$DECLARE c record; BEGIN  -- leftover NOT NULL columns from an older version must not block inserts
  FOR c IN SELECT column_name FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'dispositions' AND is_nullable = 'NO'
             AND column_default IS NULL
             AND column_name NOT IN (SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = to_regclass(table_name::text) AND i.indisprimary)
             AND column_name NOT IN ('code','label','source','sip_code','sort') LOOP
    EXECUTE format('ALTER TABLE dispositions ALTER COLUMN %I DROP NOT NULL', c.column_name);
  END LOOP; END$$;


-- ------------------------------------------------------------ cause_rules
-- Q.850 hangup cause -> disposition for unanswered calls, edited on the Dispositions page (src/disposition.js).
-- status = DIALSTATUS the rule applies to; ANY = CANCEL/NOANSWER/BUSY/CONGESTION. Seeded once, when created.
DO $$BEGIN
  IF to_regclass('cause_rules') IS NULL THEN
    CREATE TABLE cause_rules (
      cause        INT NOT NULL CHECK (cause BETWEEN 1 AND 127),
      status       VARCHAR(16) NOT NULL DEFAULT 'ANY' CHECK (status IN ('ANY','CANCEL','NOANSWER','BUSY','CONGESTION','CHANUNAVAIL')),
      disposition  VARCHAR(16) NOT NULL CHECK (disposition IN ('NO_ANSWER','BUSY','CANCEL','CONGESTION','FAILED','SIP_DOWN')),
      PRIMARY KEY (cause, status)
    );
    INSERT INTO cause_rules(cause, status, disposition) VALUES
      (1,'ANY','FAILED'), (3,'ANY','FAILED'), (17,'ANY','BUSY'), (18,'ANY','NO_ANSWER'), (19,'ANY','NO_ANSWER'),
      (20,'ANY','NO_ANSWER'), (21,'ANY','BUSY'), (22,'ANY','FAILED'), (27,'ANY','FAILED'), (28,'ANY','FAILED'),
      (31,'ANY','CANCEL'), (31,'CHANUNAVAIL','CANCEL'), (34,'ANY','CONGESTION'), (38,'ANY','CONGESTION'),
      (41,'ANY','CONGESTION'), (42,'ANY','CONGESTION'), (44,'ANY','CONGESTION'), (47,'ANY','CONGESTION'),
      (58,'ANY','CONGESTION'), (102,'ANY','NO_ANSWER');
  END IF;
END$$;


-- ----------------------------------------------------------------- calls
-- Our own CDR: one row per call, written by the backend from the SIPDIST_END event.
SELECT pg_temp.sd_legacy('calls', ARRAY['id','linkedid','process_id','process_code','trunk_id','trunk_name','src_ip','cli_in','cli_out','dialed','sent_number','disposition','dialstatus','hangup_cause','start_time','answer_time','end_time','ring_sec','bill_sec','duration']);
CREATE TABLE IF NOT EXISTS calls (
  id             BIGSERIAL PRIMARY KEY,
  uniqueid       VARCHAR(64) NOT NULL,
  linkedid       VARCHAR(64),
  process_id     INT,
  process_code   VARCHAR(32),
  trunk_id       INT,
  trunk_name     VARCHAR(32),
  src_ip         VARCHAR(64),
  cli_in         VARCHAR(64),     -- caller-ID sent by the customer
  cli_out        VARCHAR(64),     -- caller-ID we sent to the trunk
  dialed         VARCHAR(64),     -- number received from the customer
  sent_number    VARCHAR(64),     -- number sent to the trunk (after prefix/strip)
  disposition    VARCHAR(16) NOT NULL REFERENCES dispositions(code),
  dialstatus     VARCHAR(16),
  hangup_cause   INT,
  start_time     TIMESTAMPTZ NOT NULL,
  answer_time    TIMESTAMPTZ,
  end_time       TIMESTAMPTZ NOT NULL,
  ring_sec       INT NOT NULL DEFAULT 0,
  bill_sec       INT NOT NULL DEFAULT 0,
  duration       INT NOT NULL DEFAULT 0,
  CONSTRAINT calls_uniqueid_key UNIQUE (uniqueid)
);
-- upgrade an older table in place
ALTER TABLE calls ADD COLUMN IF NOT EXISTS linkedid       VARCHAR(64);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS process_id     INT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS process_code   VARCHAR(32);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS trunk_id       INT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS trunk_name     VARCHAR(32);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS src_ip         VARCHAR(64);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS cli_in         VARCHAR(64);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS cli_out        VARCHAR(64);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS dialed         VARCHAR(64);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS sent_number    VARCHAR(64);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS disposition    VARCHAR(16);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS dialstatus     VARCHAR(16);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS hangup_cause   INT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS start_time     TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS answer_time    TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS end_time       TIMESTAMPTZ;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS ring_sec       INT NOT NULL DEFAULT 0;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS bill_sec       INT NOT NULL DEFAULT 0;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS duration       INT NOT NULL DEFAULT 0;
DO $$DECLARE c record; BEGIN  -- leftover NOT NULL columns from an older version must not block inserts
  FOR c IN SELECT column_name FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'calls' AND is_nullable = 'NO'
             AND column_default IS NULL
             AND column_name NOT IN (SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = to_regclass(table_name::text) AND i.indisprimary)
             AND column_name NOT IN ('id','linkedid','process_id','process_code','trunk_id','trunk_name','src_ip','cli_in','cli_out','dialed','sent_number','disposition','dialstatus','hangup_cause','start_time','answer_time','end_time','ring_sec','bill_sec','duration') LOOP
    EXECUTE format('ALTER TABLE calls ALTER COLUMN %I DROP NOT NULL', c.column_name);
  END LOOP; END$$;

CREATE INDEX IF NOT EXISTS calls_start_brin   ON calls USING brin(start_time);
CREATE INDEX IF NOT EXISTS calls_proc_time    ON calls(process_code, start_time DESC);
CREATE INDEX IF NOT EXISTS calls_trunk_time   ON calls(trunk_name, start_time DESC);
CREATE INDEX IF NOT EXISTS calls_disp_time    ON calls(disposition, start_time DESC);
CREATE INDEX IF NOT EXISTS calls_dialed       ON calls(dialed);

-- ----------------------------------------------------------- daily_stats
-- Day-wise counters per process and per trunk, updated on every call end.
SELECT pg_temp.sd_legacy('daily_stats', ARRAY['day','scope','ref','total','answered','busy','no_answer','cancel','congestion','failed','channel_limit','trunk_limit','blocked','no_route','invalid','talk_sec','peak_channels']);
CREATE TABLE IF NOT EXISTS daily_stats (
  day            DATE NOT NULL,
  scope          VARCHAR(8) NOT NULL CHECK (scope IN ('process','trunk','did')),
  ref            VARCHAR(32) NOT NULL,            -- process code or trunk name
  total          INT NOT NULL DEFAULT 0,
  answered       INT NOT NULL DEFAULT 0,
  busy           INT NOT NULL DEFAULT 0,
  no_answer      INT NOT NULL DEFAULT 0,
  cancel         INT NOT NULL DEFAULT 0,
  congestion     INT NOT NULL DEFAULT 0,
  failed         INT NOT NULL DEFAULT 0,
  channel_limit  INT NOT NULL DEFAULT 0,
  trunk_limit    INT NOT NULL DEFAULT 0,
  blocked        INT NOT NULL DEFAULT 0,
  no_route       INT NOT NULL DEFAULT 0,
  invalid        INT NOT NULL DEFAULT 0,
  talk_sec       BIGINT NOT NULL DEFAULT 0,
  peak_channels  INT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope, ref)
);
-- upgrade an older table in place
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS day            DATE;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS scope          VARCHAR(8) CHECK (scope IN ('process','trunk','did'));
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS ref            VARCHAR(32);
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS total          INT NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS answered       INT NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS busy           INT NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS no_answer      INT NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS cancel         INT NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS congestion     INT NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS failed         INT NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS channel_limit  INT NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS trunk_limit    INT NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS blocked        INT NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS no_route       INT NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS invalid        INT NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS talk_sec       BIGINT NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS peak_channels  INT NOT NULL DEFAULT 0;
DO $$DECLARE c record; BEGIN  -- leftover NOT NULL columns from an older version must not block inserts
  FOR c IN SELECT column_name FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'daily_stats' AND is_nullable = 'NO'
             AND column_default IS NULL
             AND column_name NOT IN (SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = to_regclass(table_name::text) AND i.indisprimary)
             AND column_name NOT IN ('day','scope','ref','total','answered','busy','no_answer','cancel','congestion','failed','channel_limit','trunk_limit','blocked','no_route','invalid','talk_sec','peak_channels') LOOP
    EXECUTE format('ALTER TABLE daily_stats ALTER COLUMN %I DROP NOT NULL', c.column_name);
  END LOOP; END$$;


-- ------------------------------------------------------------- audit_log
SELECT pg_temp.sd_legacy('audit_log', ARRAY['id','at','admin','action','entity','entity_id','details']);
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  admin      VARCHAR(64),
  action     VARCHAR(32) NOT NULL,
  entity     VARCHAR(32),
  entity_id  VARCHAR(64),
  details    JSONB
);
-- upgrade an older table in place
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS at         TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS admin      VARCHAR(64);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS action     VARCHAR(32);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entity     VARCHAR(32);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entity_id  VARCHAR(64);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS details    JSONB;
DO $$DECLARE c record; BEGIN  -- leftover NOT NULL columns from an older version must not block inserts
  FOR c IN SELECT column_name FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'audit_log' AND is_nullable = 'NO'
             AND column_default IS NULL
             AND column_name NOT IN (SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = to_regclass(table_name::text) AND i.indisprimary)
             AND column_name NOT IN ('id','at','admin','action','entity','entity_id','details') LOOP
    EXECUTE format('ALTER TABLE audit_log ALTER COLUMN %I DROP NOT NULL', c.column_name);
  END LOOP; END$$;

CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at DESC);

-- ---------------------------------------------------------- activity_log
-- Every API request of a signed-in user plus failed sign-ins (src/activity.js). Super admins only (Activity page).
CREATE TABLE IF NOT EXISTS activity_log (
  id        BIGSERIAL PRIMARY KEY,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  username  VARCHAR(64),
  role      VARCHAR(12),
  sid       BIGINT,
  ip        VARCHAR(64),
  method    VARCHAR(8) NOT NULL,
  path      VARCHAR(200) NOT NULL,
  query     TEXT,
  status    SMALLINT,
  ms        INTEGER,
  action    VARCHAR(64),                 -- readable name, e.g. 'Searched CDR report', 'Edited trunk'
  detail    TEXT                         -- what was viewed (filters, object) or changed (object, old -> new)
);
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS detail TEXT;
CREATE INDEX IF NOT EXISTS activity_at ON activity_log(at DESC);
CREATE INDEX IF NOT EXISTS activity_user ON activity_log(username, at DESC);

-- ------------------------------------------------------------------ cdr
-- Asterisk's own CDR (cdr_pgsql). Keeps recording even if the Node backend is down.
SELECT pg_temp.sd_legacy('cdr', ARRAY['calldate','clid','src','dst','dcontext','channel','dstchannel','lastapp','lastdata','duration','billsec','disposition','amaflags','accountcode','userfield','peeraccount','linkedid','sequence']);
CREATE TABLE IF NOT EXISTS cdr (
  calldate     TIMESTAMPTZ NOT NULL DEFAULT now(),
  clid         VARCHAR(80)  NOT NULL DEFAULT '',
  src          VARCHAR(80)  NOT NULL DEFAULT '',
  dst          VARCHAR(80)  NOT NULL DEFAULT '',
  dcontext     VARCHAR(80)  NOT NULL DEFAULT '',
  channel      VARCHAR(80)  NOT NULL DEFAULT '',
  dstchannel   VARCHAR(80)  NOT NULL DEFAULT '',
  lastapp      VARCHAR(80)  NOT NULL DEFAULT '',
  lastdata     VARCHAR(255) NOT NULL DEFAULT '',
  duration     INT          NOT NULL DEFAULT 0,
  billsec      INT          NOT NULL DEFAULT 0,
  disposition  VARCHAR(45)  NOT NULL DEFAULT '',
  amaflags     INT          NOT NULL DEFAULT 0,
  accountcode  VARCHAR(20)  NOT NULL DEFAULT '',
  uniqueid     VARCHAR(150) NOT NULL DEFAULT '',
  userfield    VARCHAR(255) NOT NULL DEFAULT '',
  peeraccount  VARCHAR(80)  NOT NULL DEFAULT '',
  linkedid     VARCHAR(150) NOT NULL DEFAULT '',
  sequence     INT          NOT NULL DEFAULT 0
);
-- upgrade an older table in place
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS calldate     TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS clid         VARCHAR(80)  NOT NULL DEFAULT '';
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS src          VARCHAR(80)  NOT NULL DEFAULT '';
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS dst          VARCHAR(80)  NOT NULL DEFAULT '';
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS dcontext     VARCHAR(80)  NOT NULL DEFAULT '';
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS channel      VARCHAR(80)  NOT NULL DEFAULT '';
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS dstchannel   VARCHAR(80)  NOT NULL DEFAULT '';
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS lastapp      VARCHAR(80)  NOT NULL DEFAULT '';
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS lastdata     VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS duration     INT          NOT NULL DEFAULT 0;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS billsec      INT          NOT NULL DEFAULT 0;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS disposition  VARCHAR(45)  NOT NULL DEFAULT '';
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS amaflags     INT          NOT NULL DEFAULT 0;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS accountcode  VARCHAR(20)  NOT NULL DEFAULT '';
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS userfield    VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS peeraccount  VARCHAR(80)  NOT NULL DEFAULT '';
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS linkedid     VARCHAR(150) NOT NULL DEFAULT '';
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS sequence     INT          NOT NULL DEFAULT 0;
DO $$DECLARE c record; BEGIN  -- leftover NOT NULL columns from an older version must not block inserts
  FOR c IN SELECT column_name FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'cdr' AND is_nullable = 'NO'
             AND column_default IS NULL
             AND column_name NOT IN (SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = to_regclass(table_name::text) AND i.indisprimary)
             AND column_name NOT IN ('calldate','clid','src','dst','dcontext','channel','dstchannel','lastapp','lastdata','duration','billsec','disposition','amaflags','accountcode','userfield','peeraccount','linkedid','sequence') LOOP
    EXECUTE format('ALTER TABLE cdr ALTER COLUMN %I DROP NOT NULL', c.column_name);
  END LOOP; END$$;

CREATE INDEX IF NOT EXISTS cdr_calldate_brin ON cdr USING brin(calldate);
CREATE INDEX IF NOT EXISTS cdr_uniqueid      ON cdr(uniqueid);

-- unique keys used by ON CONFLICT (also covers tables created by an older version)
CREATE UNIQUE INDEX IF NOT EXISTS dispositions_code_uidx ON dispositions(code);
CREATE UNIQUE INDEX IF NOT EXISTS trunks_name_uidx       ON trunks(name);
CREATE UNIQUE INDEX IF NOT EXISTS processes_code_uidx    ON processes(code);
CREATE UNIQUE INDEX IF NOT EXISTS processes_sipuser_uidx ON processes(sip_username);
CREATE UNIQUE INDEX IF NOT EXISTS calls_uniqueid_uidx    ON calls(uniqueid);
CREATE UNIQUE INDEX IF NOT EXISTS daily_stats_key_uidx   ON daily_stats(day, scope, ref);
CREATE UNIQUE INDEX IF NOT EXISTS admins_username_uidx   ON admins(username);

-- seed / refresh dispositions (after the unique index exists)
-- DID ranges owned on a trunk. Used as the caller-ID pool for processes in cli_mode 'trunk_did'
-- and to route inbound calls from the carrier to a process.
CREATE TABLE IF NOT EXISTS trunk_did_ranges (
  id          SERIAL PRIMARY KEY,
  trunk_id    INT NOT NULL REFERENCES trunks(id) ON DELETE CASCADE,
  first_did   VARCHAR(15) NOT NULL CHECK (first_did ~ '^[0-9]{4,15}$'),
  last_did    VARCHAR(15) NOT NULL CHECK (last_did ~ '^[0-9]{4,15}$'),
  process_id  INT REFERENCES processes(id) ON DELETE SET NULL,   -- inbound calls to these DIDs; NULL = rejected
  use_as_cli  BOOLEAN NOT NULL DEFAULT TRUE,                      -- part of the outbound caller-ID pool
  note        VARCHAR(128),
  CONSTRAINT trunk_did_ranges_order CHECK (length(first_did) = length(last_did) AND first_did <= last_did)
);
CREATE INDEX IF NOT EXISTS trunk_did_ranges_trunk_idx ON trunk_did_ranges(trunk_id);

ALTER TABLE processes DROP CONSTRAINT IF EXISTS processes_cli_mode_check;
ALTER TABLE processes ADD CONSTRAINT processes_cli_mode_check CHECK (cli_mode IN ('dummy','passthrough','trunk_did'));
ALTER TABLE calls ADD COLUMN IF NOT EXISTS direction VARCHAR(3) NOT NULL DEFAULT 'out';
-- per trunk: accept inbound calls from the carrier to its DIDs (FALSE = reject all, DIDs still usable as caller ID)
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS allow_inbound BOOLEAN NOT NULL DEFAULT TRUE;
-- per trunk: max new outbound calls per second (0 = unlimited); extra calls wait up to 3 s, then TRUNK_LIMIT
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS cps INT NOT NULL DEFAULT 0 CHECK (cps >= 0);
-- per trunk: prepended to the caller ID (DID) sent on outbound calls, like prefix is for the number
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS cli_prefix VARCHAR(32) NOT NULL DEFAULT '';
-- per process: which call directions are allowed, and optional working time for each
-- out_hours / in_hours: NULL = any time, else {"days":["mon",..],"from":"09:00","to":"18:00"} (STATS_TZ)
ALTER TABLE processes ADD COLUMN IF NOT EXISTS allow_outbound BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE processes ADD COLUMN IF NOT EXISTS allow_inbound  BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE processes ADD COLUMN IF NOT EXISTS out_hours      JSONB;
ALTER TABLE processes ADD COLUMN IF NOT EXISTS in_hours       JSONB;
-- SIP port of the customer server (IP auth): inbound DID calls and the OPTIONS ping go to <first fixed IP>:<sip_port>
ALTER TABLE processes ADD COLUMN IF NOT EXISTS sip_port       INT NOT NULL DEFAULT 5060 CHECK (sip_port BETWEEN 1 AND 65535);
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS off_hours    INT NOT NULL DEFAULT 0;
-- header dialing: the client calls the process's dummy number and sends the caller-ID DID and the
-- customer number in SIP headers (names per process). '' = feature off.
ALTER TABLE processes ADD COLUMN IF NOT EXISTS hdr_number   VARCHAR(20) NOT NULL DEFAULT '';
ALTER TABLE processes ADD COLUMN IF NOT EXISTS hdr_did_name VARCHAR(40) NOT NULL DEFAULT 'X-DID';
ALTER TABLE processes ADD COLUMN IF NOT EXISTS hdr_num_name VARCHAR(40) NOT NULL DEFAULT 'X-Number';
-- per call: DID used as caller ID, header result (NULL = not a header call; ok/missing/bad_number/bad_did) and raw values
ALTER TABLE calls ADD COLUMN IF NOT EXISTS did        VARCHAR(20);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS hdr_status VARCHAR(12);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS hdr_did    VARCHAR(40);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS hdr_num    VARCHAR(40);
DROP INDEX IF EXISTS calls_did_idx;
CREATE INDEX IF NOT EXISTS calls_did_time_idx ON calls(did, start_time DESC) WHERE did IS NOT NULL;   -- DID stats + inbound DID routing
CREATE INDEX IF NOT EXISTS calls_hdr_idx ON calls(process_code, start_time) WHERE hdr_status IS NOT NULL;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS no_header   INT NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS invalid_did INT NOT NULL DEFAULT 0;
-- daily stats are also kept per DID
ALTER TABLE daily_stats DROP CONSTRAINT IF EXISTS daily_stats_scope_check;
ALTER TABLE daily_stats ADD CONSTRAINT daily_stats_scope_check CHECK (scope IN ('process','trunk','did'));

-- SIP_DOWN: trunk (or customer, inbound) unreachable - Dial() returned CHANUNAVAIL
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS sip_down INT NOT NULL DEFAULT 0;
-- custom_code: admin-editable code shown in the UI, CSV and reports instead of the internal code ('' = the code).
-- First time the column is added, CHANNEL_LIMIT is shown as LIMIT_REACH.
DO $$BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema() AND table_name = 'dispositions' AND column_name = 'custom_code') THEN
    ALTER TABLE dispositions ADD COLUMN custom_code VARCHAR(16) NOT NULL DEFAULT '';
    UPDATE dispositions SET custom_code = 'LIMIT_REACH' WHERE code = 'CHANNEL_LIMIT';
  END IF;
END$$;

-- Diagnostics issue tracker: one row per problem, open while closed_at IS NULL (src/diag/issues.js)
CREATE TABLE IF NOT EXISTS diag_issues (
  id         BIGSERIAL PRIMARY KEY,
  key        VARCHAR(80) NOT NULL,                 -- e.g. sip_down:<trunk>, limit:<process>
  severity   VARCHAR(8) NOT NULL CHECK (severity IN ('critical','warning')),
  title      VARCHAR(160) NOT NULL,
  detail     TEXT,
  hint       TEXT,
  opened_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS diag_issues_opened_idx ON diag_issues(opened_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS diag_issues_open_uidx ON diag_issues(key) WHERE closed_at IS NULL;

-- System page graphs: one sample per minute (src/sysinfo.js), pruned after 5 days
CREATE TABLE IF NOT EXISTS sys_metrics (
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  cpu        REAL NOT NULL,          -- % of all cores, averaged over the minute
  mem_used   BIGINT NOT NULL,        -- bytes (total - MemAvailable)
  mem_total  BIGINT NOT NULL,
  disks      JSONB NOT NULL DEFAULT '[]'   -- [{ mount, used, total }] bytes
);
CREATE INDEX IF NOT EXISTS sys_metrics_at_idx ON sys_metrics(at);

-- Slack / email alerts sent by src/diag/alerts.js (issue opened / resolved / reminder / test)
CREATE TABLE IF NOT EXISTS alert_log (
  id       BIGSERIAL PRIMARY KEY,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  channel  VARCHAR(8) NOT NULL,        -- slack | email
  kind     VARCHAR(40) NOT NULL,       -- opened / closed / reminder (combined with +) / test
  subject  TEXT,
  ok       BOOLEAN NOT NULL,
  error    TEXT
);
CREATE INDEX IF NOT EXISTS alert_log_at_idx ON alert_log(at DESC);

-- Alerts page settings (single row, src/diag/alerts.js). NULL = use the ALERT_* value from .env.
-- routes: { <alert type>: 'both'|'slack'|'email'|'off' } — missing type = default for its severity.
CREATE TABLE IF NOT EXISTS alert_settings (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  slack_webhook   TEXT,
  slack_mention   BOOLEAN,                -- @channel on critical alerts
  gmail_user      TEXT,
  gmail_pass      TEXT,
  email_to        TEXT,                   -- comma-separated
  warnings_email  BOOLEAN,
  remind_min      INT,
  resolved        BOOLEAN,
  name            TEXT,
  routes          JSONB NOT NULL DEFAULT '{}',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- label, sip_code and custom_code are editable in the UI (Dispositions page): only set them for new rows
INSERT INTO dispositions(code,label,source,sip_code,sort,custom_code) VALUES
  ('ANSWERED',      'Answered',                       'trunk',       200, 1, ''),
  ('BUSY',          'Busy',                           'trunk',       486, 2, ''),
  ('NO_ANSWER',     'No answer',                      'trunk',       480, 3, ''),
  ('CANCEL',        'Cancelled by caller',            'trunk',       487, 4, ''),
  ('CONGESTION',    'Congestion',                     'trunk',       503, 5, ''),
  ('FAILED',        'Failed / unavailable',           'trunk',       500, 6, ''),
  ('CHANNEL_LIMIT', 'Rejected: process limit',        'distributor', 503, 7, 'LIMIT_REACH'),
  ('TRUNK_LIMIT',   'Rejected: trunk limit',          'distributor', 503, 8, ''),
  ('BLOCKED',       'Rejected: inactive / direction off', 'distributor', 403, 9, ''),
  ('NO_ROUTE',      'Rejected: no active trunk',      'distributor', 503, 10, ''),
  ('INVALID',       'Rejected: invalid number',       'distributor', 404, 11, ''),
  ('OFF_HOURS',     'Rejected: outside working time', 'distributor', 480, 12, ''),
  ('NO_HEADER',     'Rejected: DID/number header missing', 'distributor', 484, 13, ''),
  ('INVALID_DID',   'Rejected: DID not on trunk',     'distributor', 403, 14, ''),
  ('SIP_DOWN',      'SIP down / unreachable',         'trunk',       503, 15, '')
ON CONFLICT (code) DO UPDATE SET source=EXCLUDED.source, sort=EXCLUDED.sort;

COMMIT;
