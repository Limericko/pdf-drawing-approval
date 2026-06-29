import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { appIconFiles, getIconAssetDir } from "./appIcons.mjs";

const workspaceRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const outputDir = getIconAssetDir(workspaceRoot);
const clientPublicDir = path.join(workspaceRoot, "src", "client", "public");

const themes = {
  client: {
    top: "#0f5f56",
    bottom: "#20a07d",
    accent: "#31c48d",
    ink: "#1f2937"
  },
  server: {
    top: "#263241",
    bottom: "#0d766c",
    accent: "#38bdf8",
    ink: "#111827"
  }
};

const iconSizes = [16, 24, 32, 48, 64, 128, 256];

function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(clientPublicDir, { recursive: true });

  for (const kind of ["client", "server"]) {
    const files = appIconFiles[kind];
    const png = renderIcon(kind, 512);
    const ico = createIco(iconSizes.map((size) => ({ size, png: renderIcon(kind, size) })));

    fs.writeFileSync(path.join(outputDir, files.png), png);
    fs.writeFileSync(path.join(outputDir, files.ico), ico);
  }

  fs.copyFileSync(path.join(outputDir, appIconFiles.client.ico), path.join(clientPublicDir, "favicon.ico"));
  fs.copyFileSync(path.join(outputDir, appIconFiles.client.png), path.join(clientPublicDir, "app-icon.png"));

  console.log(`Generated icons in ${outputDir}`);
  console.log(`Generated web favicon assets in ${clientPublicDir}`);
}

function renderIcon(kind, size) {
  const theme = themes[kind];
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const scale = size / 1024;

  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.scale(scale, scale);

  drawBackground(ctx, theme);
  if (kind === "client") drawClientGlyph(ctx, theme);
  if (kind === "server") drawServerGlyph(ctx, theme);

  ctx.restore();
  return canvas.toBuffer("image/png");
}

function drawBackground(ctx, theme) {
  const gradient = ctx.createLinearGradient(0, 0, 1024, 1024);
  gradient.addColorStop(0, theme.top);
  gradient.addColorStop(1, theme.bottom);

  roundedRect(ctx, 48, 48, 928, 928, 210);
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.globalAlpha = 0.18;
  ctx.fillStyle = "#ffffff";
  roundedRect(ctx, 112, 98, 800, 150, 76);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawClientGlyph(ctx, theme) {
  drawDocument(ctx, 292, 154, 440, 660, 126);

  ctx.fillStyle = "#dbe7e2";
  ctx.beginPath();
  ctx.moveTo(606, 154);
  ctx.lineTo(732, 280);
  ctx.lineTo(606, 280);
  ctx.closePath();
  ctx.fill();

  drawLine(ctx, 366, 390, 288, 38, theme.ink);
  drawLine(ctx, 366, 500, 288, 38, theme.ink);
  drawLine(ctx, 366, 610, 178, 38, theme.ink);

  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 56;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(352, 738);
  ctx.lineTo(452, 836);
  ctx.lineTo(666, 622);
  ctx.stroke();

  ctx.strokeStyle = "#0f766e";
  ctx.lineWidth = 20;
  roundedRect(ctx, 330, 320, 362, 410, 34);
  ctx.stroke();
}

function drawServerGlyph(ctx, theme) {
  ctx.fillStyle = "#e5edf0";
  roundedRect(ctx, 238, 260, 284, 424, 54);
  ctx.fill();

  for (const y of [314, 444, 574]) {
    ctx.fillStyle = "#344055";
    roundedRect(ctx, 286, y, 188, 72, 22);
    ctx.fill();

    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    ctx.arc(430, y + 36, 15, 0, Math.PI * 2);
    ctx.fill();
  }

  drawDocument(ctx, 474, 202, 330, 520, 96);
  ctx.fillStyle = "#dbe7e2";
  ctx.beginPath();
  ctx.moveTo(708, 202);
  ctx.lineTo(804, 298);
  ctx.lineTo(708, 298);
  ctx.closePath();
  ctx.fill();

  drawLine(ctx, 532, 396, 202, 30, theme.ink);
  drawLine(ctx, 532, 486, 202, 30, theme.ink);
  drawLine(ctx, 532, 576, 134, 30, theme.ink);

  ctx.strokeStyle = "#22c55e";
  ctx.lineWidth = 48;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(510, 766);
  ctx.lineTo(604, 850);
  ctx.lineTo(780, 668);
  ctx.stroke();
}

function drawDocument(ctx, x, y, width, height, fold) {
  ctx.fillStyle = "#f8fafc";
  roundedRect(ctx, x, y, width, height, 28);
  ctx.fill();

  ctx.fillStyle = "rgba(15, 23, 42, 0.1)";
  roundedRect(ctx, x + 24, y + height - 56, width - 48, 24, 12);
  ctx.fill();

  ctx.fillStyle = "#e8f1ed";
  ctx.beginPath();
  ctx.moveTo(x + width - fold, y);
  ctx.lineTo(x + width, y + fold);
  ctx.lineTo(x + width - fold, y + fold);
  ctx.closePath();
  ctx.fill();
}

function drawLine(ctx, x, y, width, height, color) {
  ctx.fillStyle = color;
  roundedRect(ctx, x, y, width, height, height / 2);
  ctx.fill();
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function createIco(entries) {
  let imageOffset = 6 + entries.length * 16;
  const header = Buffer.alloc(imageOffset);

  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  entries.forEach((entry, index) => {
    const offset = 6 + index * 16;
    const sizeByte = entry.size >= 256 ? 0 : entry.size;
    header.writeUInt8(sizeByte, offset);
    header.writeUInt8(sizeByte, offset + 1);
    header.writeUInt8(0, offset + 2);
    header.writeUInt8(0, offset + 3);
    header.writeUInt16LE(1, offset + 4);
    header.writeUInt16LE(32, offset + 6);
    header.writeUInt32LE(entry.png.length, offset + 8);
    header.writeUInt32LE(imageOffset, offset + 12);
    imageOffset += entry.png.length;
  });

  return Buffer.concat([header, ...entries.map((entry) => entry.png)]);
}

main();
