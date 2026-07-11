CREATE TABLE platform.users (
  id uuid PRIMARY KEY,
  email_normalized text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  platform_role text NOT NULL,
  status text NOT NULL,
  mfa_status text NOT NULL,
  mfa_enabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT users_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT users_email_normalized_unique UNIQUE (email_normalized),
  CONSTRAINT users_email_normalized_check CHECK (
    email_normalized = lower(btrim(email_normalized)) AND email_normalized <> ''
  ),
  CONSTRAINT users_display_name_check CHECK (btrim(display_name) <> ''),
  CONSTRAINT users_password_hash_check CHECK (password_hash <> ''),
  CONSTRAINT users_platform_role_check CHECK (platform_role IN ('admin', 'member')),
  CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT users_mfa_status_check CHECK (mfa_status IN ('disabled', 'enabled')),
  CONSTRAINT users_mfa_enabled_at_check CHECK (mfa_enabled_at IS NULL OR mfa_enabled_at >= created_at),
  CONSTRAINT users_updated_at_check CHECK (updated_at >= created_at)
);

CREATE TABLE platform.projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT projects_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT projects_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT projects_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT projects_updated_at_check CHECK (updated_at >= created_at)
);

CREATE TABLE platform.project_members (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT project_members_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT project_members_project_user_unique UNIQUE (project_id, user_id),
  CONSTRAINT project_members_project_fk FOREIGN KEY (project_id)
    REFERENCES platform.projects(id) ON DELETE RESTRICT,
  CONSTRAINT project_members_user_fk FOREIGN KEY (user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT project_members_role_check CHECK (role IN ('manager', 'designer', 'supervisor', 'process', 'viewer')),
  CONSTRAINT project_members_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT project_members_updated_at_check CHECK (updated_at >= created_at)
);

CREATE INDEX project_members_user_id_idx ON platform.project_members (user_id);

CREATE TABLE platform.invitations (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL,
  token_key_version integer NOT NULL,
  email_normalized text NOT NULL,
  platform_role text NOT NULL,
  project_id uuid NOT NULL,
  project_role text NOT NULL,
  invited_by_user_id uuid NOT NULL,
  accepted_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  accepted_at timestamptz,
  CONSTRAINT invitations_id_uuid_v7_check CHECK (
    substr(id::text, 15, 1) = '7' AND substr(id::text, 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT invitations_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT invitations_token_hash_check CHECK (octet_length(token_hash) = 32),
  CONSTRAINT invitations_token_key_version_check CHECK (token_key_version > 0),
  CONSTRAINT invitations_email_normalized_check CHECK (
    email_normalized = lower(btrim(email_normalized)) AND email_normalized <> ''
  ),
  CONSTRAINT invitations_platform_role_check CHECK (platform_role IN ('admin', 'member')),
  CONSTRAINT invitations_project_role_check CHECK (
    project_role IN ('manager', 'designer', 'supervisor', 'process', 'viewer')
  ),
  CONSTRAINT invitations_project_fk FOREIGN KEY (project_id)
    REFERENCES platform.projects(id) ON DELETE RESTRICT,
  CONSTRAINT invitations_invited_by_user_fk FOREIGN KEY (invited_by_user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT invitations_accepted_by_user_fk FOREIGN KEY (accepted_by_user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT invitations_expires_at_check CHECK (expires_at > created_at),
  CONSTRAINT invitations_revoked_at_check CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CONSTRAINT invitations_accepted_at_check CHECK (accepted_at IS NULL OR accepted_at >= created_at),
  CONSTRAINT invitations_acceptance_consistency_check CHECK (
    (accepted_at IS NULL AND accepted_by_user_id IS NULL)
    OR (accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL)
  ),
  CONSTRAINT invitations_terminal_state_check CHECK (revoked_at IS NULL OR accepted_at IS NULL)
);

CREATE INDEX invitations_project_id_idx ON platform.invitations (project_id);
CREATE INDEX invitations_invited_by_user_id_idx ON platform.invitations (invited_by_user_id);
CREATE INDEX invitations_accepted_by_user_id_idx ON platform.invitations (accepted_by_user_id);
CREATE INDEX invitations_active_idx ON platform.invitations (email_normalized, expires_at, created_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

REVOKE ALL ON TABLE
  platform.users,
  platform.projects,
  platform.project_members,
  platform.invitations
FROM PUBLIC;

GRANT USAGE ON SCHEMA platform TO platform_web, platform_worker, platform_bootstrap;

GRANT SELECT, INSERT, UPDATE ON TABLE
  platform.users,
  platform.projects,
  platform.project_members,
  platform.invitations
TO platform_web;

GRANT SELECT ON TABLE
  platform.users,
  platform.projects,
  platform.project_members,
  platform.invitations
TO platform_worker;

GRANT SELECT, INSERT ON TABLE platform.users TO platform_bootstrap;
