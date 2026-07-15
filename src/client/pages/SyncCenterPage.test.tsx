import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { workspaceRoute } from "../features/workspace/PlatformWorkspace.tsx";
import { SyncCenterPage } from "./SyncCenterPage.tsx";

describe("SyncCenterPage", () => {
  it("routes administrators into the dedicated platform sync center", () => {
    expect(workspaceRoute("#/workspace/sync")).toEqual({ name: "sync" });
    const html = renderToStaticMarkup(<SyncCenterPage projects={[{
      id: "01890f1e-9b4a-7cc2-8f00-000000005101", name: "液压平台"
    }]} currentProjectId="01890f1e-9b4a-7cc2-8f00-000000005101" />);
    expect(html).toContain("WebDAV 同步中心");
    expect(html).toContain("云端业务数据保持唯一真相");
    expect(html).toContain("本次操作原因");
  });

  it("uses the platform client and semantic tokens without legacy auth or hardcoded colors", () => {
    const source = fs.readFileSync(path.resolve("src/client/pages/SyncCenterPage.tsx"), "utf8");
    const styles = fs.readFileSync(path.resolve("src/client/pages/SyncCenterPage.module.css"), "utf8");
    expect(source).toContain('from "../api/syncClient.ts"');
    expect(source).not.toContain('from "../api.ts"');
    expect(source).not.toContain("Bearer");
    expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(styles).not.toMatch(/z-index:\s*\d/);
    expect(styles).toContain("var(--color-surface)");
  });
});
