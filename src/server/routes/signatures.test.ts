import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { SignatureAssetRepository } from "../repositories/signatureAssets.ts";
import { UserRepository } from "../repositories/users.ts";
import { createServer } from "../server.ts";

const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
const pngDataUrl = `data:image/png;base64,${pngBytes.toString("base64")}`;

async function appContext() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-signatures-"));
  const db = createDatabase(":memory:");
  const users = new UserRepository(db);
  const signatureAssets = new SignatureAssetRepository(db);
  users.create({ username: "admin", password: "admin123", role: "admin", displayName: "管理员" });
  users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });
  const app = createServer(
    { port: 0, dataDir, databasePath: ":memory:", jwtSecret: "secret" },
    { db, users, signatureAssets }
  );
  const adminLogin = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" });
  const designerLogin = await request(app).post("/api/auth/login").send({ username: "designer", password: "123456" });
  return {
    app,
    dataDir,
    signatureAssets,
    adminToken: adminLogin.body.token,
    designerToken: designerLogin.body.token
  };
}

describe("signature routes", () => {
  it("returns the current user's signature status", async () => {
    const context = await appContext();

    const response = await request(context.app)
      .get("/api/signatures/me")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .expect(200);

    expect(response.body.configured).toBe(false);
    expect(response.body.asset).toBeNull();
  });

  it("lets authenticated users upload a PNG signature", async () => {
    const context = await appContext();

    const response = await request(context.app)
      .post("/api/signatures/me/upload")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .set("Content-Type", "image/png")
      .send(pngBytes)
      .expect(200);

    expect(response.body.configured).toBe(true);
    expect(response.body.asset.kind).toBe("uploaded_png");
    await expect(fs.stat(response.body.asset.filePath)).resolves.toBeTruthy();
    expect(context.signatureAssets.getActiveForUser(response.body.asset.userId)?.id).toBe(response.body.asset.id);

    const file = await request(context.app)
      .get("/api/signatures/me/file")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .expect(200);
    expect(file.headers["content-type"]).toContain("image/png");
  });

  it("lets authenticated users save a drawn PNG data URL", async () => {
    const context = await appContext();

    const response = await request(context.app)
      .post("/api/signatures/me/draw")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send({ dataUrl: pngDataUrl })
      .expect(200);

    expect(response.body.configured).toBe(true);
    expect(response.body.asset.kind).toBe("drawn_png");
    await expect(fs.readFile(response.body.asset.filePath)).resolves.toEqual(pngBytes);
  });

  it("accepts larger drawn PNG data URLs from browser canvases", async () => {
    const context = await appContext();
    const largerPng = Buffer.concat([pngBytes, Buffer.alloc(160 * 1024, 0)]);
    const largerDataUrl = `data:image/png;base64,${largerPng.toString("base64")}`;

    const response = await request(context.app)
      .post("/api/signatures/me/draw")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .send({ dataUrl: largerDataUrl })
      .expect(200);

    expect(response.body.configured).toBe(true);
    await expect(fs.readFile(response.body.asset.filePath)).resolves.toEqual(largerPng);
  });

  it("rejects non-PNG signature uploads", async () => {
    const context = await appContext();

    const response = await request(context.app)
      .post("/api/signatures/me/upload")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .set("Content-Type", "image/png")
      .send(Buffer.from("not a png"))
      .expect(400);

    expect(response.body.error).toBe("INVALID_PNG_SIGNATURE");
  });

  it("lets admins list user signature configuration status", async () => {
    const context = await appContext();
    await request(context.app)
      .post("/api/signatures/me/upload")
      .set("Authorization", `Bearer ${context.designerToken}`)
      .set("Content-Type", "image/png")
      .send(pngBytes)
      .expect(200);

    const response = await request(context.app)
      .get("/api/signatures/status")
      .set("Authorization", `Bearer ${context.adminToken}`)
      .expect(200);

    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ username: "admin", hasSignature: false }),
        expect.objectContaining({ username: "designer", hasSignature: true })
      ])
    );
  });
});
