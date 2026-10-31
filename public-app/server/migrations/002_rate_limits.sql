CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key char(64) PRIMARY KEY,
  hits integer NOT NULL CHECK (hits >= 0),
  reset_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_reset_at_idx ON rate_limits (reset_at);
