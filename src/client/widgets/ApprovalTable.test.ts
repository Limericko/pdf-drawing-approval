import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.resolve("src/client/widgets/ApprovalTable.tsx"), "utf8");

describe("approval table usability", () => {
  it("keeps row click navigation but also exposes a visible detail action", () => {
    expect(source).toContain("location.hash = `/approvals/${approval.id}`");
    expect(source).toContain("查看");
    expect(source).toContain("查看图纸");
  });

  it("marks table cells for mobile card rendering", () => {
    expect(source).toContain("approval-table");
    for (const label of ["项目", "零件", "版本", "主管", "工艺", "总状态", "签审", "提交时间", "操作"]) {
      expect(source).toContain(`data-label="${label}"`);
    }
  });
});
