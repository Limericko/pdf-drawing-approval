import { describe, expect, it, vi } from "vitest";
import {
  calculateNextDailyRun,
  createMaintenanceScheduler,
  readMaintenanceSettings,
  type MaintenanceSchedule
} from "./maintenanceScheduler.ts";

describe("maintenance scheduler", () => {
  it("does not run disabled schedules", async () => {
    const task = vi.fn(async () => undefined);
    const scheduler = createMaintenanceScheduler();

    await expect(
      scheduler.runDue("auto_backup", { enabled: false, time: "02:30" }, task, new Date("2026-06-23T03:00:00.000Z"))
    ).resolves.toEqual({ status: "skipped", reason: "disabled" });
    expect(task).not.toHaveBeenCalled();
  });

  it("calculates the next enabled daily run", () => {
    const schedule: MaintenanceSchedule = { enabled: true, time: "02:30" };

    expect(calculateNextDailyRun(schedule, new Date("2026-06-23T01:00:00.000Z")).toISOString()).toBe(
      "2026-06-23T02:30:00.000Z"
    );
    expect(calculateNextDailyRun(schedule, new Date("2026-06-23T03:00:00.000Z")).toISOString()).toBe(
      "2026-06-24T02:30:00.000Z"
    );
  });

  it("blocks a second run while the same task is running", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = createMaintenanceScheduler();
    const first = scheduler.runNow("auto_cleanup", async () => pending);

    await expect(scheduler.runNow("auto_cleanup", async () => undefined)).resolves.toEqual({
      status: "skipped",
      reason: "already_running"
    });

    release();
    await expect(first).resolves.toEqual({ status: "completed" });
  });

  it("returns failed results instead of throwing out of the loop", async () => {
    const scheduler = createMaintenanceScheduler();

    await expect(
      scheduler.runNow("auto_backup", async () => {
        throw new Error("disk full");
      })
    ).resolves.toEqual({ status: "failed", errorMessage: "disk full" });
  });

  it("reads maintenance settings with conservative defaults", () => {
    expect(
      readMaintenanceSettings((key) =>
        ({
          maintenance_auto_backup_enabled: "true",
          maintenance_auto_backup_time: "01:20"
        })[key] ?? null
      )
    ).toEqual({
      autoBackup: { enabled: true, time: "01:20" },
      autoCleanup: { enabled: false, time: "03:30" }
    });
  });
});
