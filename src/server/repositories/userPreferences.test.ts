import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { UserRepository } from "./users.ts";
import { UserPreferenceRepository, cleanCommonProjects, defaultNotificationPreferencesForRole } from "./userPreferences.ts";

describe("UserPreferenceRepository", () => {
  it("returns role defaults when a user has no saved preferences", () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const preferences = new UserPreferenceRepository(db);
    const designer = users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });

    const profile = preferences.getForUser(designer);

    expect(profile.commonProjects).toEqual([]);
    expect(profile.notificationPreferences.email.approvalRejected).toBe(true);
    expect(profile.notificationPreferences.email.reviewTaskCreated).toBe(false);
    expect(profile.notificationPreferences.email.approvalApprovedForPrint).toBe(true);
  });

  it("saves cleaned common projects and notification preferences", () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const preferences = new UserPreferenceRepository(db);
    const supervisor = users.create({ username: "supervisor", password: "123456", role: "supervisor", displayName: "主管" });

    const saved = preferences.upsertForUser(supervisor, {
      commonProjects: ["  项目A  ", "项目A", "", "项目B"],
      notificationPreferences: {
        email: {
          reviewTaskCreated: false,
          peerReviewCompleted: true
        }
      }
    });

    expect(saved.commonProjects).toEqual(["项目A", "项目B"]);
    expect(saved.notificationPreferences.email.reviewTaskCreated).toBe(false);
    expect(saved.notificationPreferences.email.peerReviewCompleted).toBe(true);
    expect(saved.notificationPreferences.email.approvalRejected).toBe(true);
  });

  it("limits common projects to 20 entries and 80 characters per name", () => {
    const projects = Array.from({ length: 25 }, (_, index) => `项目${index + 1}`);
    const cleaned = cleanCommonProjects([`${"超".repeat(100)}`, ...projects]);

    expect(cleaned).toHaveLength(20);
    expect(cleaned[0]).toHaveLength(80);
    expect(cleaned[19]).toBe("项目19");
  });

  it("uses conservative defaults for administrators", () => {
    const preferences = defaultNotificationPreferencesForRole("admin");

    expect(preferences.email.signatureFailed).toBe(true);
    expect(preferences.email.systemRisk).toBe(false);
    expect(preferences.email.reviewTaskCreated).toBe(false);
  });
});
