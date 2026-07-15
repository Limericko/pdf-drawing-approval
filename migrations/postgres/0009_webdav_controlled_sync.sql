CREATE TABLE platform.webdav_connections (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  endpoint_url text NOT NULL,
  credential_ref text NOT NULL,
  credential_available boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  capabilities jsonb NOT NULL DEFAULT '{"class1":false,"move":false,"rangeDownload":false}'::jsonb,
  last_checked_at timestamptz,
  last_error_code text,
  version integer NOT NULL DEFAULT 1,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT webdav_connections_id_uuid_v7_check CHECK (
    substr(id::text,15,1)='7' AND substr(id::text,20,1) IN ('8','9','a','b')
  ),
  CONSTRAINT webdav_connections_created_by_user_id_fk FOREIGN KEY (created_by_user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT webdav_connections_name_check CHECK (btrim(name)<>'' AND length(name)<=160),
  CONSTRAINT webdav_connections_endpoint_url_check CHECK (
    length(endpoint_url)<=2048 AND endpoint_url ~ '^https?://[^/?#]+(?:/[^?#]*)?$'
    AND endpoint_url !~ '[[:cntrl:]]'
  ),
  CONSTRAINT webdav_connections_credential_ref_check CHECK (
    btrim(credential_ref)=credential_ref AND length(credential_ref) BETWEEN 3 AND 240
    AND credential_ref ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    AND credential_ref !~ '(^|/)\.\.?(/|$)'
  ),
  CONSTRAINT webdav_connections_status_check CHECK (status IN ('active','disabled','error')),
  CONSTRAINT webdav_connections_capabilities_check CHECK (
    jsonb_typeof(capabilities)='object'
    AND capabilities ?& ARRAY['class1','move','rangeDownload']
    AND jsonb_typeof(capabilities->'class1')='boolean'
    AND jsonb_typeof(capabilities->'move')='boolean'
    AND jsonb_typeof(capabilities->'rangeDownload')='boolean'
  ),
  CONSTRAINT webdav_connections_error_check CHECK (
    last_error_code IS NULL OR (btrim(last_error_code)<>'' AND length(last_error_code)<=128)
  ),
  CONSTRAINT webdav_connections_version_check CHECK (version>0),
  CONSTRAINT webdav_connections_checked_at_check CHECK (
    last_checked_at IS NULL OR last_checked_at>=created_at
  ),
  CONSTRAINT webdav_connections_updated_at_check CHECK (updated_at>=created_at)
);

ALTER TABLE platform.admin_mutation_requests
  DROP CONSTRAINT admin_mutation_requests_action_check;
ALTER TABLE platform.admin_mutation_requests
  ADD CONSTRAINT admin_mutation_requests_action_check CHECK (
    action IN (
      'user_status','membership_update','session_revoke','job_retry',
      'webdav_connection_create','webdav_connection_update',
      'webdav_mapping_create','webdav_mapping_update','webdav_conflict_resolve','webdav_sync_retry'
    )
  );

CREATE INDEX webdav_connections_created_by_user_id_idx
  ON platform.webdav_connections(created_by_user_id);
CREATE INDEX webdav_connections_status_idx
  ON platform.webdav_connections(status,updated_at DESC,id DESC);

CREATE TABLE platform.webdav_directory_mappings (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL,
  project_id uuid NOT NULL,
  incoming_path text NOT NULL,
  outgoing_path text NOT NULL,
  publish_variant text NOT NULL DEFAULT 'signed',
  status text NOT NULL DEFAULT 'active',
  scan_interval_seconds integer NOT NULL DEFAULT 300,
  next_scan_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_scan_at timestamptz,
  last_success_at timestamptz,
  scan_lease_token uuid,
  scan_lease_expires_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT webdav_directory_mappings_id_uuid_v7_check CHECK (
    substr(id::text,15,1)='7' AND substr(id::text,20,1) IN ('8','9','a','b')
  ),
  CONSTRAINT webdav_directory_mappings_connection_id_fk FOREIGN KEY (connection_id)
    REFERENCES platform.webdav_connections(id) ON DELETE RESTRICT,
  CONSTRAINT webdav_directory_mappings_project_id_fk FOREIGN KEY (project_id)
    REFERENCES platform.projects(id) ON DELETE RESTRICT,
  CONSTRAINT webdav_directory_mappings_created_by_user_id_fk FOREIGN KEY (created_by_user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT webdav_directory_mappings_project_id_id_unique UNIQUE(project_id,id),
  CONSTRAINT webdav_directory_mappings_incoming_unique UNIQUE(connection_id,project_id,incoming_path),
  CONSTRAINT webdav_directory_mappings_outgoing_unique UNIQUE(connection_id,project_id,outgoing_path),
  CONSTRAINT webdav_directory_mappings_paths_distinct CHECK (incoming_path<>outgoing_path),
  CONSTRAINT webdav_directory_mappings_incoming_path_check CHECK (
    length(incoming_path) BETWEEN 2 AND 1024 AND incoming_path ~ '^/[^/]+(?:/[^/]+)*$'
    AND position(E'\\' in incoming_path)=0 AND incoming_path !~ '(^|/)\.\.?(/|$)'
    AND incoming_path !~ '[[:cntrl:]]'
  ),
  CONSTRAINT webdav_directory_mappings_outgoing_path_check CHECK (
    length(outgoing_path) BETWEEN 2 AND 1024 AND outgoing_path ~ '^/[^/]+(?:/[^/]+)*$'
    AND position(E'\\' in outgoing_path)=0 AND outgoing_path !~ '(^|/)\.\.?(/|$)'
    AND outgoing_path !~ '[[:cntrl:]]'
  ),
  CONSTRAINT webdav_directory_mappings_publish_variant_check CHECK (
    publish_variant IN ('original','review','signed')
  ),
  CONSTRAINT webdav_directory_mappings_status_check CHECK (status IN ('active','disabled')),
  CONSTRAINT webdav_directory_mappings_scan_interval_check CHECK (
    scan_interval_seconds BETWEEN 30 AND 86400
  ),
  CONSTRAINT webdav_directory_mappings_lease_check CHECK (
    (scan_lease_token IS NULL AND scan_lease_expires_at IS NULL)
    OR (scan_lease_token IS NOT NULL AND scan_lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT webdav_directory_mappings_scan_times_check CHECK (
    (last_scan_at IS NULL OR last_scan_at>=created_at)
    AND (last_success_at IS NULL OR last_success_at>=created_at)
  ),
  CONSTRAINT webdav_directory_mappings_version_check CHECK (version>0),
  CONSTRAINT webdav_directory_mappings_updated_at_check CHECK (updated_at>=created_at)
);

CREATE INDEX webdav_directory_mappings_connection_id_idx
  ON platform.webdav_directory_mappings(connection_id);
CREATE INDEX webdav_directory_mappings_project_id_idx
  ON platform.webdav_directory_mappings(project_id);
CREATE INDEX webdav_directory_mappings_created_by_user_id_idx
  ON platform.webdav_directory_mappings(created_by_user_id);
CREATE INDEX webdav_directory_mappings_due_idx
  ON platform.webdav_directory_mappings(next_scan_at,id)
  WHERE status='active';

CREATE TABLE platform.webdav_sync_items (
  id uuid PRIMARY KEY,
  mapping_id uuid NOT NULL,
  project_id uuid NOT NULL,
  direction text NOT NULL,
  remote_path text NOT NULL,
  discovery_key text NOT NULL,
  remote_etag text,
  remote_size_bytes bigint,
  remote_modified_at timestamptz,
  remote_sha256 bytea,
  storage_object_id uuid,
  revision_id uuid,
  temporary_remote_path text,
  status text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error_code text,
  version integer NOT NULL DEFAULT 1,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT webdav_sync_items_id_uuid_v7_check CHECK (
    substr(id::text,15,1)='7' AND substr(id::text,20,1) IN ('8','9','a','b')
  ),
  CONSTRAINT webdav_sync_items_mapping_project_fk FOREIGN KEY (project_id,mapping_id)
    REFERENCES platform.webdav_directory_mappings(project_id,id) ON DELETE RESTRICT,
  CONSTRAINT webdav_sync_items_storage_object_id_fk FOREIGN KEY (storage_object_id)
    REFERENCES platform.storage_objects(id) ON DELETE RESTRICT,
  CONSTRAINT webdav_sync_items_revision_project_fk FOREIGN KEY (project_id,revision_id)
    REFERENCES platform.drawing_revisions(project_id,id) ON DELETE RESTRICT,
  CONSTRAINT webdav_sync_items_project_id_id_unique UNIQUE(project_id,id),
  CONSTRAINT webdav_sync_items_discovery_unique UNIQUE(mapping_id,direction,discovery_key),
  CONSTRAINT webdav_sync_items_direction_check CHECK (direction IN ('inbound','outbound')),
  CONSTRAINT webdav_sync_items_remote_path_check CHECK (
    length(remote_path) BETWEEN 2 AND 1024 AND remote_path ~ '^/[^/]+(?:/[^/]+)*$'
    AND position(E'\\' in remote_path)=0 AND remote_path !~ '(^|/)\.\.?(/|$)'
    AND remote_path !~ '[[:cntrl:]]'
  ),
  CONSTRAINT webdav_sync_items_discovery_key_check CHECK (
    btrim(discovery_key)<>'' AND length(discovery_key)<=256 AND discovery_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT webdav_sync_items_remote_etag_check CHECK (
    remote_etag IS NULL OR (btrim(remote_etag)<>'' AND length(remote_etag)<=1024)
  ),
  CONSTRAINT webdav_sync_items_remote_size_check CHECK (remote_size_bytes IS NULL OR remote_size_bytes>=0),
  CONSTRAINT webdav_sync_items_remote_sha_check CHECK (
    remote_sha256 IS NULL OR octet_length(remote_sha256)=32
  ),
  CONSTRAINT webdav_sync_items_temporary_path_check CHECK (
    temporary_remote_path IS NULL OR (
      length(temporary_remote_path) BETWEEN 2 AND 1200
      AND temporary_remote_path ~ '^/[^/]+(?:/[^/]+)*$'
      AND position(E'\\' in temporary_remote_path)=0
      AND temporary_remote_path !~ '(^|/)\.\.?(/|$)'
    )
  ),
  CONSTRAINT webdav_sync_items_status_check CHECK (
    status IN ('discovered','downloading','validating','imported','pending_upload','uploading',
      'verifying','succeeded','conflict','remote_missing','failed')
      OR status='skipped'
  ),
  CONSTRAINT webdav_sync_items_attempt_count_check CHECK (attempt_count>=0),
  CONSTRAINT webdav_sync_items_error_check CHECK (
    last_error_code IS NULL OR (btrim(last_error_code)<>'' AND length(last_error_code)<=128)
  ),
  CONSTRAINT webdav_sync_items_version_check CHECK (version>0),
  CONSTRAINT webdav_sync_items_completed_state_check CHECK (
    (status IN ('imported','succeeded','skipped') AND completed_at IS NOT NULL AND completed_at>=created_at)
    OR (status NOT IN ('imported','succeeded','skipped') AND completed_at IS NULL)
  ),
  CONSTRAINT webdav_sync_items_updated_at_check CHECK (updated_at>=created_at)
);

CREATE INDEX webdav_sync_items_mapping_status_idx
  ON platform.webdav_sync_items(mapping_id,status,updated_at,id);
CREATE INDEX webdav_sync_items_project_mapping_idx
  ON platform.webdav_sync_items(project_id,mapping_id);
CREATE INDEX webdav_sync_items_project_status_idx
  ON platform.webdav_sync_items(project_id,status,updated_at DESC,id DESC);
CREATE INDEX webdav_sync_items_storage_object_fk_idx
  ON platform.webdav_sync_items(storage_object_id);
CREATE INDEX webdav_sync_items_storage_object_id_idx
  ON platform.webdav_sync_items(storage_object_id) WHERE storage_object_id IS NOT NULL;
CREATE INDEX webdav_sync_items_project_revision_idx
  ON platform.webdav_sync_items(project_id,revision_id);
CREATE INDEX webdav_sync_items_revision_id_idx
  ON platform.webdav_sync_items(revision_id) WHERE revision_id IS NOT NULL;
CREATE INDEX webdav_sync_items_remote_path_idx
  ON platform.webdav_sync_items(mapping_id,remote_path,updated_at DESC,id DESC);
CREATE UNIQUE INDEX webdav_sync_items_active_remote_path_uidx
  ON platform.webdav_sync_items(mapping_id,direction,remote_path)
  WHERE status IN ('discovered','downloading','validating','pending_upload','uploading','verifying',
    'conflict','remote_missing','failed');

CREATE TABLE platform.webdav_sync_conflicts (
  id uuid PRIMARY KEY,
  mapping_id uuid NOT NULL,
  project_id uuid NOT NULL,
  sync_item_id uuid NOT NULL,
  direction text NOT NULL,
  remote_path text NOT NULL,
  remote_etag text,
  remote_size_bytes bigint,
  remote_modified_at timestamptz,
  remote_sha256 bytea,
  cloud_revision_id uuid,
  cloud_object_id uuid,
  cloud_size_bytes bigint,
  cloud_sha256 bytea,
  status text NOT NULL DEFAULT 'open',
  resolution text,
  resolution_reason text,
  renamed_remote_path text,
  resolved_by_user_id uuid,
  resolved_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT webdav_sync_conflicts_id_uuid_v7_check CHECK (
    substr(id::text,15,1)='7' AND substr(id::text,20,1) IN ('8','9','a','b')
  ),
  CONSTRAINT webdav_sync_conflicts_mapping_project_fk FOREIGN KEY (project_id,mapping_id)
    REFERENCES platform.webdav_directory_mappings(project_id,id) ON DELETE RESTRICT,
  CONSTRAINT webdav_sync_conflicts_item_project_fk FOREIGN KEY (project_id,sync_item_id)
    REFERENCES platform.webdav_sync_items(project_id,id) ON DELETE RESTRICT,
  CONSTRAINT webdav_sync_conflicts_cloud_revision_project_fk FOREIGN KEY (project_id,cloud_revision_id)
    REFERENCES platform.drawing_revisions(project_id,id) ON DELETE RESTRICT,
  CONSTRAINT webdav_sync_conflicts_cloud_object_id_fk FOREIGN KEY (cloud_object_id)
    REFERENCES platform.storage_objects(id) ON DELETE RESTRICT,
  CONSTRAINT webdav_sync_conflicts_resolved_by_user_id_fk FOREIGN KEY (resolved_by_user_id)
    REFERENCES platform.users(id) ON DELETE RESTRICT,
  CONSTRAINT webdav_sync_conflicts_sync_item_unique UNIQUE(sync_item_id),
  CONSTRAINT webdav_sync_conflicts_direction_check CHECK (direction IN ('inbound','outbound')),
  CONSTRAINT webdav_sync_conflicts_remote_path_check CHECK (
    length(remote_path) BETWEEN 2 AND 1024 AND remote_path ~ '^/[^/]+(?:/[^/]+)*$'
    AND position(E'\\' in remote_path)=0 AND remote_path !~ '(^|/)\.\.?(/|$)'
    AND remote_path !~ '[[:cntrl:]]'
  ),
  CONSTRAINT webdav_sync_conflicts_remote_etag_check CHECK (
    remote_etag IS NULL OR (btrim(remote_etag)<>'' AND length(remote_etag)<=1024)
  ),
  CONSTRAINT webdav_sync_conflicts_remote_size_check CHECK (remote_size_bytes IS NULL OR remote_size_bytes>=0),
  CONSTRAINT webdav_sync_conflicts_remote_sha_check CHECK (
    remote_sha256 IS NULL OR octet_length(remote_sha256)=32
  ),
  CONSTRAINT webdav_sync_conflicts_cloud_size_check CHECK (cloud_size_bytes IS NULL OR cloud_size_bytes>=0),
  CONSTRAINT webdav_sync_conflicts_cloud_sha_check CHECK (
    cloud_sha256 IS NULL OR octet_length(cloud_sha256)=32
  ),
  CONSTRAINT webdav_sync_conflicts_status_check CHECK (status IN ('open','resolved')),
  CONSTRAINT webdav_sync_conflicts_resolution_check CHECK (
    resolution IS NULL OR resolution IN ('import_as_new_version','publish_cloud_as_renamed','keep_remote')
  ),
  CONSTRAINT webdav_sync_conflicts_reason_check CHECK (
    resolution_reason IS NULL OR (btrim(resolution_reason)<>'' AND length(resolution_reason)<=4000)
  ),
  CONSTRAINT webdav_sync_conflicts_renamed_path_check CHECK (
    renamed_remote_path IS NULL OR (
      length(renamed_remote_path) BETWEEN 2 AND 1024
      AND renamed_remote_path ~ '^/[^/]+(?:/[^/]+)*$'
      AND position(E'\\' in renamed_remote_path)=0
      AND renamed_remote_path !~ '(^|/)\.\.?(/|$)'
    )
  ),
  CONSTRAINT webdav_sync_conflicts_resolution_state_check CHECK (
    (status='open' AND resolution IS NULL AND resolution_reason IS NULL
      AND renamed_remote_path IS NULL AND resolved_by_user_id IS NULL AND resolved_at IS NULL)
    OR (status='resolved' AND resolution IS NOT NULL AND resolution_reason IS NOT NULL
      AND resolved_by_user_id IS NOT NULL AND resolved_at IS NOT NULL AND resolved_at>=created_at
      AND ((resolution='publish_cloud_as_renamed' AND renamed_remote_path IS NOT NULL)
        OR (resolution<>'publish_cloud_as_renamed' AND renamed_remote_path IS NULL)))
  ),
  CONSTRAINT webdav_sync_conflicts_version_check CHECK (version>0),
  CONSTRAINT webdav_sync_conflicts_updated_at_check CHECK (updated_at>=created_at)
);

CREATE INDEX webdav_sync_conflicts_project_status_idx
  ON platform.webdav_sync_conflicts(project_id,status,created_at DESC,id DESC);
CREATE INDEX webdav_sync_conflicts_project_mapping_idx
  ON platform.webdav_sync_conflicts(project_id,mapping_id);
CREATE INDEX webdav_sync_conflicts_project_item_idx
  ON platform.webdav_sync_conflicts(project_id,sync_item_id);
CREATE INDEX webdav_sync_conflicts_project_revision_idx
  ON platform.webdav_sync_conflicts(project_id,cloud_revision_id);
CREATE INDEX webdav_sync_conflicts_cloud_object_id_idx
  ON platform.webdav_sync_conflicts(cloud_object_id);
CREATE INDEX webdav_sync_conflicts_mapping_id_idx
  ON platform.webdav_sync_conflicts(mapping_id,created_at DESC,id DESC);
CREATE INDEX webdav_sync_conflicts_resolved_by_user_fk_idx
  ON platform.webdav_sync_conflicts(resolved_by_user_id);
CREATE INDEX webdav_sync_conflicts_resolved_by_user_id_idx
  ON platform.webdav_sync_conflicts(resolved_by_user_id) WHERE resolved_by_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION platform.require_ready_storage_object()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=platform,pg_temp
AS $$
DECLARE
  referenced_object_id uuid;
BEGIN
  referenced_object_id := CASE TG_TABLE_NAME
    WHEN 'drawing_revisions' THEN (to_jsonb(NEW)->>'original_object_id')::uuid
    WHEN 'webdav_sync_items' THEN (to_jsonb(NEW)->>'storage_object_id')::uuid
    WHEN 'webdav_sync_conflicts' THEN (to_jsonb(NEW)->>'cloud_object_id')::uuid
    ELSE (to_jsonb(NEW)->>'object_id')::uuid
  END;
  IF referenced_object_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM platform.storage_objects object
    WHERE object.id=referenced_object_id AND object.status='ready'
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='storage object is not ready';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER webdav_sync_items_ready_object_trigger
BEFORE INSERT OR UPDATE OF storage_object_id ON platform.webdav_sync_items
FOR EACH ROW EXECUTE FUNCTION platform.require_ready_storage_object();

CREATE TRIGGER webdav_sync_conflicts_ready_object_trigger
BEFORE INSERT OR UPDATE OF cloud_object_id ON platform.webdav_sync_conflicts
FOR EACH ROW EXECUTE FUNCTION platform.require_ready_storage_object();

REVOKE ALL ON TABLE
  platform.webdav_connections,
  platform.webdav_directory_mappings,
  platform.webdav_sync_items,
  platform.webdav_sync_conflicts
FROM PUBLIC;

GRANT SELECT,INSERT ON TABLE
  platform.webdav_connections,
  platform.webdav_directory_mappings,
  platform.webdav_sync_items,
  platform.webdav_sync_conflicts
TO platform_web;

GRANT UPDATE (
  name,endpoint_url,credential_ref,credential_available,status,capabilities,last_checked_at,last_error_code,version,updated_at
) ON TABLE platform.webdav_connections TO platform_web;
GRANT UPDATE (
  incoming_path,outgoing_path,publish_variant,status,scan_interval_seconds,next_scan_at,last_scan_at,
  last_success_at,version,updated_at
) ON TABLE platform.webdav_directory_mappings TO platform_web;
GRANT UPDATE (
  remote_etag,remote_size_bytes,remote_modified_at,remote_sha256,storage_object_id,revision_id,
  temporary_remote_path,status,attempt_count,last_error_code,version,completed_at,updated_at
) ON TABLE platform.webdav_sync_items TO platform_web;
GRANT UPDATE (
  status,resolution,resolution_reason,renamed_remote_path,resolved_by_user_id,resolved_at,version,updated_at
) ON TABLE platform.webdav_sync_conflicts TO platform_web;

GRANT SELECT ON TABLE
  platform.webdav_connections,
  platform.webdav_directory_mappings,
  platform.webdav_sync_items,
  platform.webdav_sync_conflicts,
  platform.projects,
  platform.documents,
  platform.drawing_revisions,
  platform.render_artifacts,
  platform.storage_objects
TO platform_worker;

GRANT INSERT ON TABLE
  platform.webdav_sync_items,
  platform.webdav_sync_conflicts
TO platform_worker;
GRANT INSERT (id,project_id,document_code,name,created_by_user_id,created_at,updated_at)
  ON TABLE platform.documents TO platform_worker;
GRANT INSERT (
  id,project_id,document_id,revision_code,original_object_id,source,status,metadata_status,material_code,
  client_request_id,created_by_user_id,created_at,updated_at
) ON TABLE platform.drawing_revisions TO platform_worker;

GRANT UPDATE (credential_available,capabilities,last_checked_at,last_error_code,status,version,updated_at)
  ON TABLE platform.webdav_connections TO platform_worker;
GRANT UPDATE (
  next_scan_at,last_scan_at,last_success_at,scan_lease_token,scan_lease_expires_at,version,updated_at
) ON TABLE platform.webdav_directory_mappings TO platform_worker;
GRANT UPDATE (
  remote_path,remote_etag,remote_size_bytes,remote_modified_at,remote_sha256,storage_object_id,revision_id,
  temporary_remote_path,status,attempt_count,last_error_code,version,completed_at,updated_at
) ON TABLE platform.webdav_sync_items TO platform_worker;
GRANT UPDATE (
  remote_path,remote_etag,remote_size_bytes,remote_modified_at,remote_sha256,cloud_revision_id,
  cloud_object_id,cloud_size_bytes,cloud_sha256,status,resolution,resolution_reason,renamed_remote_path,
  resolved_by_user_id,resolved_at,version,updated_at
) ON TABLE platform.webdav_sync_conflicts TO platform_worker;

REVOKE ALL ON FUNCTION platform.require_ready_storage_object() FROM PUBLIC;
