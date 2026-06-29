export type MaintenanceSchedule = {
  enabled: boolean;
  time: string;
};

export type MaintenanceSettings = {
  autoBackup: MaintenanceSchedule;
  autoCleanup: MaintenanceSchedule;
};

export type MaintenanceRunResult =
  | { status: "completed" }
  | { status: "failed"; errorMessage: string }
  | { status: "skipped"; reason: "disabled" | "not_due" | "already_running" | "already_ran_today"; nextRunAt?: string };

const defaultMaintenanceSettings: MaintenanceSettings = {
  autoBackup: { enabled: false, time: "01:00" },
  autoCleanup: { enabled: false, time: "03:30" }
};

export function readMaintenanceSettings(get: (key: string) => string | null): MaintenanceSettings {
  return {
    autoBackup: {
      enabled: get("maintenance_auto_backup_enabled") === "true",
      time: normalizeTime(get("maintenance_auto_backup_time"), defaultMaintenanceSettings.autoBackup.time)
    },
    autoCleanup: {
      enabled: get("maintenance_auto_cleanup_enabled") === "true",
      time: normalizeTime(get("maintenance_auto_cleanup_time"), defaultMaintenanceSettings.autoCleanup.time)
    }
  };
}

export function calculateNextDailyRun(schedule: MaintenanceSchedule, now = new Date()) {
  const [hour, minute] = parseTime(schedule.time);
  const next = new Date(now.getTime());
  next.setUTCHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

export function createMaintenanceScheduler() {
  const running = new Set<string>();
  const lastRunDateByKey = new Map<string, string>();

  async function runNow(key: string, task: () => Promise<void>): Promise<MaintenanceRunResult> {
    if (running.has(key)) return { status: "skipped", reason: "already_running" };

    running.add(key);
    try {
      await task();
      return { status: "completed" };
    } catch (error) {
      return {
        status: "failed",
        errorMessage: error instanceof Error && error.message ? error.message : "MAINTENANCE_FAILED"
      };
    } finally {
      running.delete(key);
    }
  }

  async function runDue(
    key: string,
    schedule: MaintenanceSchedule,
    task: () => Promise<void>,
    now = new Date()
  ): Promise<MaintenanceRunResult> {
    if (!schedule.enabled) return { status: "skipped", reason: "disabled" };

    const runDate = utcDateKey(now);
    if (lastRunDateByKey.get(key) === runDate) {
      return { status: "skipped", reason: "already_ran_today", nextRunAt: calculateNextDailyRun(schedule, now).toISOString() };
    }

    const dueAt = scheduledAtForDate(schedule, now);
    if (now.getTime() < dueAt.getTime()) {
      return { status: "skipped", reason: "not_due", nextRunAt: dueAt.toISOString() };
    }

    const result = await runNow(key, task);
    if (result.status !== "skipped") {
      lastRunDateByKey.set(key, runDate);
    }
    return result;
  }

  return { runDue, runNow };
}

export function normalizeTime(value: string | null | undefined, fallback = "03:30") {
  return value && isValidDailyTime(value) ? value : fallback;
}

export function isValidDailyTime(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function parseTime(value: string) {
  const normalized = normalizeTime(value);
  return normalized.split(":").map(Number) as [number, number];
}

function scheduledAtForDate(schedule: MaintenanceSchedule, date: Date) {
  const [hour, minute] = parseTime(schedule.time);
  const dueAt = new Date(date.getTime());
  dueAt.setUTCHours(hour, minute, 0, 0);
  return dueAt;
}

function utcDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}
