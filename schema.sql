-- One workspace = one household: the parent who lives alone and the family circle around them.
CREATE TABLE IF NOT EXISTS profile (
  ws TEXT PRIMARY KEY,
  parent_name TEXT NOT NULL DEFAULT 'Mom',
  city TEXT NOT NULL DEFAULT '',
  lat REAL, lon REAL,
  tz TEXT NOT NULL DEFAULT 'America/New_York',
  checkin_by TEXT NOT NULL DEFAULT '10:30',        -- local time by which the morning check-in is expected
  family TEXT NOT NULL DEFAULT '[]',               -- JSON [{name, relation}]
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ws TEXT NOT NULL,
  name TEXT NOT NULL,                              -- as the person says it, e.g. "lisinopril"
  nickname TEXT NOT NULL DEFAULT '',               -- e.g. "blood pressure pill"
  dose TEXT NOT NULL DEFAULT '',
  times TEXT NOT NULL DEFAULT '["08:00"]',          -- JSON local times
  purpose TEXT NOT NULL DEFAULT '',                -- first sentence of the FDA label's indications or purpose
  label_id TEXT,                                   -- openFDA label set_id
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS meds_ws ON meds(ws, active);

CREATE TABLE IF NOT EXISTS doses (
  ws TEXT NOT NULL,
  med_id INTEGER NOT NULL,
  day TEXT NOT NULL,                               -- local date YYYY-MM-DD
  slot TEXT NOT NULL,                              -- local time from meds.times
  status TEXT NOT NULL,                            -- taken | skipped | missed
  at TEXT NOT NULL,
  PRIMARY KEY (ws, med_id, day, slot)
);

CREATE TABLE IF NOT EXISTS checkins (
  ws TEXT NOT NULL,
  day TEXT NOT NULL,
  started_at TEXT NOT NULL,
  sleep TEXT, mood INTEGER, pain TEXT, note TEXT,
  pending TEXT,                                    -- next question: sleep | mood | pain | NULL when complete
  completed_at TEXT,
  PRIMARY KEY (ws, day)
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ws TEXT NOT NULL,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,                         -- local "YYYY-MM-DDTHH:MM"
  place TEXT NOT NULL DEFAULT '',
  reminded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS appts_ws ON appointments(ws, starts_at);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ws TEXT NOT NULL,
  at TEXT NOT NULL,
  day TEXT NOT NULL,
  level TEXT NOT NULL,                             -- info | warn | urgent
  kind TEXT NOT NULL,                              -- no_checkin | missed_dose | concern | heat | cold | appointment
  text TEXT NOT NULL,
  ack INTEGER NOT NULL DEFAULT 0,
  ack_by TEXT
);
CREATE INDEX IF NOT EXISTS alerts_ws ON alerts(ws, day);
