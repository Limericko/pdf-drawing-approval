import fs from "node:fs/promises";
import path from "node:path";
import express, { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.ts";
import type { SignatureAsset, SignatureAssetRepository } from "../repositories/signatureAssets.ts";

export function signatureRoutes(deps: {
  signatureAssets: SignatureAssetRepository;
  dataDir: string;
  jwtSecret: string;
}) {
  const router = Router();

  router.get("/me", requireAuth(deps.jwtSecret), (req, res) => {
    const asset = deps.signatureAssets.getActiveForUser(req.user!.id);
    res.json(signatureResponse(asset));
  });

  router.get("/me/file", requireAuth(deps.jwtSecret), (req, res) => {
    const asset = deps.signatureAssets.getActiveForUser(req.user!.id);
    if (!asset) return res.status(404).json({ error: "SIGNATURE_NOT_FOUND" });
    res.type("image/png").sendFile(asset.filePath);
  });

  router.post(
    "/me/upload",
    requireAuth(deps.jwtSecret),
    express.raw({ type: "image/png", limit: "5mb" }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || !isPng(req.body)) {
        return res.status(400).json({ error: "INVALID_PNG_SIGNATURE" });
      }

      const asset = await saveSignaturePng({
        deps,
        userId: req.user!.id,
        kind: "uploaded_png",
        buffer: req.body
      });
      res.json(signatureResponse(asset));
    }
  );

  router.post("/me/draw", requireAuth(deps.jwtSecret), async (req, res) => {
    const parsed = z.object({ dataUrl: z.string().trim().min(1) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    const buffer = pngDataUrlToBuffer(parsed.data.dataUrl);
    if (!buffer || !isPng(buffer)) {
      return res.status(400).json({ error: "INVALID_PNG_SIGNATURE" });
    }

    const asset = await saveSignaturePng({
      deps,
      userId: req.user!.id,
      kind: "drawn_png",
      buffer
    });
    res.json(signatureResponse(asset));
  });

  router.get("/status", requireAuth(deps.jwtSecret, ["admin"]), (_req, res) => {
    res.json(deps.signatureAssets.listUserSignatureStatus());
  });

  return router;
}

async function saveSignaturePng(input: {
  deps: { signatureAssets: SignatureAssetRepository; dataDir: string };
  userId: number;
  kind: "uploaded_png" | "drawn_png";
  buffer: Buffer;
}) {
  const signatureDir = path.join(input.deps.dataDir, "signatures", String(input.userId));
  await fs.mkdir(signatureDir, { recursive: true });
  const filePath = path.join(signatureDir, `signature-${Date.now()}.png`);
  await fs.writeFile(filePath, input.buffer);
  return input.deps.signatureAssets.replaceActiveForUser({
    userId: input.userId,
    kind: input.kind,
    filePath
  });
}

function signatureResponse(asset: SignatureAsset | null) {
  return {
    configured: asset !== null,
    asset
  };
}

function pngDataUrlToBuffer(dataUrl: string): Buffer | null {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  return match ? Buffer.from(match[1], "base64") : null;
}

function isPng(buffer: Buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}
