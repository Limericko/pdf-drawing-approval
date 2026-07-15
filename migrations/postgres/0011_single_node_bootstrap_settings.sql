ALTER TABLE platform.users
  ADD COLUMN username_normalized text,
  ADD COLUMN password_change_required boolean NOT NULL DEFAULT false;

ALTER TABLE platform.users
  ADD CONSTRAINT users_username_normalized_check CHECK (
    username_normalized IS NULL OR (
      username_normalized = lower(btrim(username_normalized))
      AND username_normalized ~ '^[a-z0-9][a-z0-9._-]{2,31}$'
    )
  );

CREATE UNIQUE INDEX users_username_normalized_unique
  ON platform.users (username_normalized)
  WHERE username_normalized IS NOT NULL;

GRANT UPDATE (username_normalized, password_change_required)
  ON TABLE platform.users TO platform_web;

GRANT SELECT, INSERT ON TABLE platform.users TO platform_bootstrap;

CREATE TABLE platform.runtime_settings (
  setting_key text PRIMARY KEY,
  encrypted_value bytea NOT NULL,
  key_version text NOT NULL,
  updated_by_user_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT runtime_settings_key_check CHECK (setting_key ~ '^[a-z][a-z0-9._-]{1,63}$'),
  CONSTRAINT runtime_settings_value_check CHECK (octet_length(encrypted_value) > 0),
  CONSTRAINT runtime_settings_key_version_check CHECK (btrim(key_version) <> ''),
  CONSTRAINT runtime_settings_user_fk FOREIGN KEY (updated_by_user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT
);

CREATE INDEX runtime_settings_updated_by_user_id_idx
  ON platform.runtime_settings (updated_by_user_id);

REVOKE ALL ON TABLE platform.runtime_settings FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE platform.runtime_settings TO platform_web;
GRANT SELECT ON TABLE platform.runtime_settings TO platform_worker;
