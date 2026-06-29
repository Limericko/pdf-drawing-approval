import { describe, expect, it } from "vitest";
import { buildTrayMenuModel } from "./trayMenu.ts";

describe("buildTrayMenuModel", () => {
  it("shows reviewer task entry for supervisor and process users", () => {
    const model = buildTrayMenuModel({
      session: { serverUrl: "http://127.0.0.1:8080", username: "supervisor", role: "supervisor", token: "token-1" },
      pendingCount: 3,
      status: "online"
    });

    expect(model.items).toContainEqual(expect.objectContaining({ id: "open-tasks", text: "打开待审核（3）" }));
  });

  it("does not expose admin actions to non-admin roles", () => {
    const model = buildTrayMenuModel({
      session: { serverUrl: "http://127.0.0.1:8080", username: "designer", role: "designer", token: "token-1" },
      pendingCount: 0,
      status: "online"
    });

    expect(model.items.map((item) => item.id)).not.toContain("scan-now");
    expect(model.items.map((item) => item.id)).not.toContain("restart-server");
  });

  it("shows scan, restart and service log actions for admins", () => {
    const model = buildTrayMenuModel({
      session: { serverUrl: "http://127.0.0.1:8080", username: "admin", role: "admin", token: "token-1" },
      pendingCount: 0,
      status: "online",
      adminRiskCount: 2
    });

    expect(model.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "open-system", text: "打开系统管理（2 项风险）" }),
        expect.objectContaining({ id: "open-logs", text: "打开服务日志" }),
        expect.objectContaining({ id: "scan-now", text: "立即扫描" }),
        expect.objectContaining({ id: "restart-server", text: "重启服务" })
      ])
    );
  });
});
