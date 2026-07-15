CREATE VIEW platform.worker_health AS
SELECT
  max(heartbeat_at) FILTER (WHERE metadata ->> 'state' = 'active') AS last_heartbeat_at,
  max(heartbeat_at) FILTER (
    WHERE metadata ->> 'state' = 'active' AND metadata ->> 'smtp' = 'healthy'
  ) AS smtp_healthy_at,
  max(heartbeat_at) FILTER (
    WHERE metadata ->> 'state' = 'active' AND metadata ->> 'smtp' = 'unhealthy'
  ) AS smtp_unhealthy_at
FROM platform.worker_heartbeats;

REVOKE ALL ON TABLE platform.worker_health FROM PUBLIC;
GRANT SELECT ON TABLE platform.worker_health TO platform_web;
