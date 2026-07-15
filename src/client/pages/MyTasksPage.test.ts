import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.resolve("src/client/pages/MyTasksPage.tsx"), "utf8");

describe("my tasks page copy", () => {
  it("uses reviewer queue copy with a clear next action", () => {
    expect(source).toContain('title="我的任务"');
    expect(source).toContain("按提交时间处理待审核 PDF，打开图纸后给出通过或驳回意见。");
  });
});
