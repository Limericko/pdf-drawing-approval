import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, getLanIPv4Addresses } from "./server.ts";

const originalSlowRequestThreshold = process.env.PDF_APPROVAL_SLOW_REQUEST_MS;

afterEach(() => {
  if (originalSlowRequestThreshold === undefined) {
    delete process.env.PDF_APPROVAL_SLOW_REQUEST_MS;
  } else {
    process.env.PDF_APPROVAL_SLOW_REQUEST_MS = originalSlowRequestThreshold;
  }
  vi.restoreAllMocks();
});

describe("server health", () => {
  it("returns ok for health checks", async () => {
    const app = createServer({
      port: 0,
      dataDir: "data",
      databasePath: ":memory:",
      jwtSecret: "test"
    });

    const response = await request(app).get("/health").expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        ok: true,
        runtimeMode: "legacy",
        appName: "PDF图纸审批",
        version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
        apiCompatVersion: 1,
        port: 0,
        lanUrls: []
      })
    );
  });

  it("derives safe LAN IPv4 addresses for public health checks", () => {
    expect(
      getLanIPv4Addresses({
        Ethernet: [
          { address: "127.0.0.1", family: "IPv4", internal: true },
          { address: "192.168.1.20", family: "IPv4", internal: false }
        ],
        Loopback: [{ address: "::1", family: "IPv6", internal: true }],
        VPN: [{ address: "10.8.0.2", family: 4, internal: false }]
      })
    ).toEqual(["10.8.0.2", "192.168.1.20"]);
  });

  it("allows tray helper browser dev origin to call API routes", async () => {
    const app = createServer({
      port: 0,
      dataDir: "data",
      databasePath: ":memory:",
      jwtSecret: "test"
    });

    const origin = "http://127.0.0.1:1420";

    await request(app)
      .options("/api/auth/login")
      .set("Origin", origin)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type")
      .expect(204)
      .expect("Access-Control-Allow-Origin", origin)
      .expect("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
      .expect("Access-Control-Allow-Headers", "Content-Type,Authorization");

    await request(app)
      .post("/api/auth/login")
      .set("Origin", origin)
      .send({ username: "supervisor", password: "123456" })
      .expect("Access-Control-Allow-Origin", origin)
      .expect(200);
  });

  it("serves release update manifests and installers from the configured release directory", async () => {
    const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-approval-releases-"));
    fs.mkdirSync(path.join(releaseDir, "updates"), { recursive: true });
    fs.mkdirSync(path.join(releaseDir, "installers", "client"), { recursive: true });
    fs.writeFileSync(path.join(releaseDir, "updates", "latest.json"), JSON.stringify({ version: "0.8.1" }), "utf8");
    fs.writeFileSync(path.join(releaseDir, "installers", "client", "PDF图纸审批客户端-安装包-0.8.1.exe"), "client-installer");

    const app = createServer({
      port: 0,
      dataDir: "data",
      databasePath: ":memory:",
      jwtSecret: "test",
      releaseDir
    });

    await request(app)
      .get("/updates/latest.json")
      .expect(200)
      .expect("Content-Type", /application\/json/)
      .expect((response) => {
        expect(response.body).toEqual({ version: "0.8.1" });
      });

    await request(app)
      .get("/installers/client/PDF图纸审批客户端-安装包-0.8.1.exe")
      .expect(200)
      .expect((response) => {
        expect(Buffer.from(response.body).toString("utf8")).toBe("client-installer");
      });

    await request(app)
      .get("/updates/missing.json")
      .expect(404)
      .expect("Content-Type", /application\/json/)
      .expect((response) => {
        expect(response.body).toEqual({ error: "UPDATE_FILE_NOT_FOUND" });
      });
  });

  it("logs slow API requests without request body or password data", async () => {
    process.env.PDF_APPROVAL_SLOW_REQUEST_MS = "0";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = createServer({
      port: 0,
      dataDir: "data",
      databasePath: ":memory:",
      jwtSecret: "test"
    });

    await request(app).post("/api/auth/login").send({ username: "supervisor", password: "123456" }).expect(200);

    const message = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(message).toContain("Slow API request");
    expect(message).toContain("method=POST");
    expect(message).toContain("path=/api/auth/login");
    expect(message).toContain("status=200");
    expect(message).toContain("durationMs=");
    expect(message).not.toContain("password");
    expect(message).not.toContain("123456");
  });
});
