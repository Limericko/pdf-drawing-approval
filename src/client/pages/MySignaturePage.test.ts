import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clearSignatureCanvas, prepareSignatureCanvas } from "./MySignaturePage.tsx";

const source = fs.readFileSync(path.resolve("src/client/pages/MySignaturePage.tsx"), "utf8");

function createContext() {
  const calls: string[] = [];
  return {
    calls,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    clearRect: (...args: number[]) => calls.push(`clearRect:${args.join(",")}`),
    fillRect: (...args: number[]) => calls.push(`fillRect:${args.join(",")}`)
  };
}

describe("signature drawing canvas", () => {
  it("prepares and clears the canvas with a transparent background", () => {
    const context = createContext();
    const canvas = {
      width: 640,
      height: 220,
      getContext: () => context
    } as unknown as HTMLCanvasElement;

    prepareSignatureCanvas(canvas);
    clearSignatureCanvas(canvas);

    expect(context.calls).toEqual(["clearRect:0,0,640,220", "clearRect:0,0,640,220"]);
    expect(context.calls.some((call) => call.startsWith("fillRect"))).toBe(false);
    expect(context.strokeStyle).toBe("#111827");
    expect(context.lineWidth).toBe(3);
    expect(context.lineCap).toBe("round");
    expect(context.lineJoin).toBe("round");
  });

  it("notifies the app after a signature is uploaded or drawn", () => {
    expect(source).toContain("onSignatureUpdated?:");
    expect(source.match(/onSignatureUpdated\?\.\(next\);/g)?.length).toBe(2);
  });

  it("uses production signing copy", () => {
    expect(source).toContain("签名素材");
    expect(source).toContain("上传或手写透明背景 PNG，审批通过后用于自动盖章。");
  });
});
