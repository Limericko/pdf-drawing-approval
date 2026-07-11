CREATE TABLE platform.totp_credentials (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  encrypted_secret bytea NOT NULL,
  key_version integer NOT NULL,
  confirmed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT totp_credentials_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT totp_credentials_user_unique UNIQUE (user_id),
  CONSTRAINT totp_credentials_user_fk FOREIGN KEY (user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT totp_credentials_secret_check CHECK (octet_length(encrypted_secret) > 0),
  CONSTRAINT totp_credentials_key_version_check CHECK (key_version > 0),
  CONSTRAINT totp_credentials_updated_at_check CHECK (updated_at >= created_at)
);

CREATE TABLE platform.recovery_codes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  code_hash bytea NOT NULL,
  key_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  used_at timestamptz,
  CONSTRAINT recovery_codes_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT recovery_codes_user_hash_unique UNIQUE (user_id, code_hash),
  CONSTRAINT recovery_codes_user_fk FOREIGN KEY (user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT recovery_codes_hash_check CHECK (octet_length(code_hash) = 32),
  CONSTRAINT recovery_codes_key_version_check CHECK (key_version > 0),
  CONSTRAINT recovery_codes_used_at_check CHECK (used_at IS NULL OR used_at >= created_at)
);

CREATE TABLE platform.mfa_challenges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  token_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL,
  completed_at timestamptz,
  CONSTRAINT mfa_challenges_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT mfa_challenges_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT mfa_challenges_user_fk FOREIGN KEY (user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT mfa_challenges_token_hash_check CHECK (octet_length(token_hash) = 32),
  CONSTRAINT mfa_challenges_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT mfa_challenges_attempts_check CHECK (
    attempt_count >= 0 AND max_attempts > 0 AND attempt_count <= max_attempts
  ),
  CONSTRAINT mfa_challenges_completed_at_check CHECK (
    completed_at IS NULL OR (completed_at >= created_at AND completed_at <= expires_at)
  )
);

CREATE INDEX mfa_challenges_user_id_idx ON platform.mfa_challenges (user_id);

CREATE TABLE platform.mfa_enrollments (
  id uuid PRIMARY KEY,
  invitation_id uuid NOT NULL,
  token_hash bytea NOT NULL,
  encrypted_totp_secret bytea NOT NULL,
  key_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL,
  invalidated_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT mfa_enrollments_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT mfa_enrollments_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT mfa_enrollments_invitation_fk FOREIGN KEY (invitation_id)
    REFERENCES platform.invitations(id) ON DELETE RESTRICT,
  CONSTRAINT mfa_enrollments_token_hash_check CHECK (octet_length(token_hash) = 32),
  CONSTRAINT mfa_enrollments_secret_check CHECK (octet_length(encrypted_totp_secret) > 0),
  CONSTRAINT mfa_enrollments_key_version_check CHECK (key_version > 0),
  CONSTRAINT mfa_enrollments_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT mfa_enrollments_attempts_check CHECK (
    attempt_count >= 0 AND max_attempts > 0 AND attempt_count <= max_attempts
  ),
  CONSTRAINT mfa_enrollments_invalidated_at_check CHECK (
    invalidated_at IS NULL OR invalidated_at >= created_at
  ),
  CONSTRAINT mfa_enrollments_completed_at_check CHECK (
    completed_at IS NULL OR (completed_at >= created_at AND completed_at <= expires_at)
  ),
  CONSTRAINT mfa_enrollments_terminal_state_check CHECK (invalidated_at IS NULL OR completed_at IS NULL)
);

CREATE UNIQUE INDEX mfa_enrollments_active_invitation_uidx
  ON platform.mfa_enrollments (invitation_id)
  WHERE invalidated_at IS NULL AND completed_at IS NULL;
CREATE INDEX mfa_enrollments_invitation_id_idx ON platform.mfa_enrollments (invitation_id);

CREATE TABLE platform.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  token_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  absolute_expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  last_touch_at timestamptz NOT NULL,
  revoked_at timestamptz,
  client_summary text,
  CONSTRAINT sessions_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT sessions_user_fk FOREIGN KEY (user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT sessions_token_hash_check CHECK (octet_length(token_hash) = 32),
  CONSTRAINT sessions_absolute_expiry_check CHECK (absolute_expires_at > created_at),
  CONSTRAINT sessions_idle_expiry_check CHECK (
    idle_expires_at > created_at AND idle_expires_at <= absolute_expires_at
  ),
  CONSTRAINT sessions_activity_check CHECK (
    last_activity_at >= created_at AND last_activity_at <= absolute_expires_at
  ),
  CONSTRAINT sessions_touch_check CHECK (
    last_touch_at >= created_at AND last_touch_at <= last_activity_at
  ),
  CONSTRAINT sessions_revoked_at_check CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX sessions_user_id_idx ON platform.sessions (user_id);
CREATE INDEX sessions_active_idx ON platform.sessions (user_id, idle_expires_at, absolute_expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE platform.security_rate_limit_buckets (
  bucket_type text NOT NULL,
  bucket_key bytea NOT NULL,
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL,
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (bucket_type, bucket_key),
  CONSTRAINT security_rate_limit_buckets_type_check CHECK (btrim(bucket_type) <> ''),
  CONSTRAINT security_rate_limit_buckets_key_check CHECK (octet_length(bucket_key) > 0),
  CONSTRAINT security_rate_limit_buckets_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT security_rate_limit_buckets_blocked_until_check CHECK (
    blocked_until IS NULL OR blocked_until >= window_started_at
  ),
  CONSTRAINT security_rate_limit_buckets_updated_at_check CHECK (updated_at >= window_started_at)
);

CREATE TABLE platform.audit_events (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_user_id uuid,
  actor_type text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  request_id text NOT NULL,
  result text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT audit_events_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT audit_events_actor_user_fk FOREIGN KEY (actor_user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT audit_events_actor_type_check CHECK (btrim(actor_type) <> ''),
  CONSTRAINT audit_events_action_check CHECK (btrim(action) <> ''),
  CONSTRAINT audit_events_target_type_check CHECK (btrim(target_type) <> ''),
  CONSTRAINT audit_events_request_id_check CHECK (btrim(request_id) <> ''),
  CONSTRAINT audit_events_result_check CHECK (result IN ('success', 'failure', 'denied', 'error')),
  CONSTRAINT audit_events_metadata_check CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX audit_events_actor_user_id_idx ON platform.audit_events (actor_user_id);
CREATE INDEX audit_events_occurred_at_idx ON platform.audit_events (occurred_at, id);
CREATE INDEX audit_events_request_id_idx ON platform.audit_events (request_id);
CREATE INDEX audit_events_target_idx ON platform.audit_events (target_type, target_id, occurred_at);

REVOKE ALL ON TABLE
  platform.totp_credentials,
  platform.recovery_codes,
  platform.mfa_challenges,
  platform.mfa_enrollments,
  platform.sessions,
  platform.security_rate_limit_buckets,
  platform.audit_events
FROM PUBLIC;

GRANT SELECT, INSERT ON TABLE
  platform.totp_credentials,
  platform.recovery_codes,
  platform.mfa_challenges,
  platform.mfa_enrollments,
  platform.sessions,
  platform.security_rate_limit_buckets
TO platform_web;

GRANT UPDATE (encrypted_secret, key_version, confirmed_at, updated_at)
  ON TABLE platform.totp_credentials TO platform_web;
GRANT UPDATE (used_at) ON TABLE platform.recovery_codes TO platform_web;
GRANT UPDATE (attempt_count, completed_at) ON TABLE platform.mfa_challenges TO platform_web;
GRANT UPDATE (attempt_count, invalidated_at, completed_at)
  ON TABLE platform.mfa_enrollments TO platform_web;
GRANT UPDATE (
  idle_expires_at,
  last_activity_at,
  last_touch_at,
  revoked_at,
  client_summary
) ON TABLE platform.sessions TO platform_web;
GRANT UPDATE (window_started_at, attempt_count, blocked_until, updated_at)
  ON TABLE platform.security_rate_limit_buckets TO platform_web;

GRANT SELECT, INSERT ON TABLE platform.audit_events TO platform_web;
GRANT INSERT ON TABLE platform.audit_events TO platform_worker;

GRANT INSERT ON TABLE
  platform.totp_credentials,
  platform.recovery_codes,
  platform.audit_events
TO platform_bootstrap;
