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
    expect(source).toContain("DataTable");
    expect(source).toContain("mobileHidden: true");
    for (const label of ["项目", "零件", "版本", "主管", "工艺", "总状态", "签审", "提交时间", "操作"]) {
      expect(source).toContain(`header: "${label}"`);
    }
  });

  it("maps domain status to data component presentation without teaching DataTable business states", () => {
    expect(source).toContain("approvalStatusPresentation");
    expect(source).toContain("<StatusChip tone={presentation.tone}");
    expect(source).not.toContain("../widgets/StatusChip");
  });
});
