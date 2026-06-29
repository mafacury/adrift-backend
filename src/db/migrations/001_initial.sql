-- Users
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT,                        -- null when using OAuth
  oauth_provider  TEXT,
  oauth_id        TEXT,
  reputation_score INT NOT NULL DEFAULT 100,
  ban_status      TEXT NOT NULL DEFAULT 'active' CHECK (ban_status IN ('active', 'warned', 'banned')),
  fcm_token       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_oauth_idx ON users (oauth_provider, oauth_id)
  WHERE oauth_provider IS NOT NULL;

-- Boats
CREATE TABLE IF NOT EXISTS boats (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  stage           INT  NOT NULL DEFAULT 1 CHECK (stage BETWEEN 1 AND 6),
  unique_countries INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_hop_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS boats_creator_idx ON boats (creator_user_id);
CREATE INDEX IF NOT EXISTS boats_status_idx  ON boats (status);

-- Boat messages (one per hop; nullable for hops where receptor said nothing)
CREATE TABLE IF NOT EXISTS boat_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  boat_id      UUID NOT NULL REFERENCES boats(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content      TEXT NOT NULL CHECK (char_length(content) <= 500),
  country_code CHAR(2) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS boat_messages_boat_idx ON boat_messages (boat_id, created_at);

-- Boat hops (routing history)
CREATE TABLE IF NOT EXISTS boat_hops (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  boat_id       UUID NOT NULL REFERENCES boats(id) ON DELETE CASCADE,
  from_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  to_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  country_code  CHAR(2) NOT NULL,
  message_id    UUID REFERENCES boat_messages(id) ON DELETE SET NULL,
  hopped_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS boat_hops_boat_idx    ON boat_hops (boat_id, hopped_at);
CREATE INDEX IF NOT EXISTS boat_hops_to_user_idx ON boat_hops (to_user_id);

-- Countries visited per boat (deduplicated for fast stage computation)
CREATE TABLE IF NOT EXISTS boat_countries (
  boat_id      UUID NOT NULL REFERENCES boats(id) ON DELETE CASCADE,
  country_code CHAR(2) NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (boat_id, country_code)
);

-- Per-country interaction counts (for map badge)
CREATE TABLE IF NOT EXISTS boat_country_interactions (
  boat_id       UUID NOT NULL REFERENCES boats(id) ON DELETE CASCADE,
  country_code  CHAR(2) NOT NULL,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (boat_id, country_code, user_id)
);

-- Ignore log
CREATE TABLE IF NOT EXISTS boat_ignores (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  boat_id     UUID NOT NULL REFERENCES boats(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ignored_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS boat_ignores_unique_idx ON boat_ignores (boat_id, user_id);

-- Counts per (boat, user) for quick MAX_IGNORES check
CREATE TABLE IF NOT EXISTS boat_ignore_counts (
  boat_id     UUID NOT NULL REFERENCES boats(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  count       INT NOT NULL DEFAULT 1,
  PRIMARY KEY (boat_id, user_id)
);

-- Receiver queue
CREATE TABLE IF NOT EXISTS receiver_queue (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  boat_id     UUID NOT NULL REFERENCES boats(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  queued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'expired', 'skipped'))
);

CREATE INDEX IF NOT EXISTS rq_user_status_idx ON receiver_queue (user_id, status);
CREATE INDEX IF NOT EXISTS rq_expires_idx     ON receiver_queue (expires_at) WHERE status = 'pending';

-- Moderation log
CREATE TABLE IF NOT EXISTS moderation_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  boat_id     UUID NOT NULL REFERENCES boats(id) ON DELETE CASCADE,
  message_id  UUID REFERENCES boat_messages(id) ON DELETE SET NULL,
  verdict     TEXT NOT NULL CHECK (verdict IN ('approved', 'rejected', 'uncertain')),
  layer       INT  NOT NULL,   -- 1 = blocklist, 2 = AI
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reports
CREATE TABLE IF NOT EXISTS reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  boat_id         UUID NOT NULL REFERENCES boats(id) ON DELETE CASCADE,
  message_id      UUID NOT NULL REFERENCES boat_messages(id) ON DELETE CASCADE,
  reporter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, reporter_user_id)
);

CREATE INDEX IF NOT EXISTS reports_message_idx ON reports (message_id);
