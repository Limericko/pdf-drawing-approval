import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "../actions/index.tsx";
import { ConfirmDialog, Dialog, Drawer, Popover, Tooltip } from "./index.tsx";

describe("overlay primitives", () => {
  it("renders labelled modal dialog and confirmation actions", () => {
    const dialog = renderToStaticMarkup(<Dialog open title="打印设置" description="配置打印任务" onClose={() => undefined}>
      设置内容
    </Dialog>);
    expect(dialog).toContain('role="dialog"');
    expect(dialog).toContain('aria-modal="true"');
    expect(dialog).toContain("打印设置");
    const confirm = renderToStaticMarkup(<ConfirmDialog open title="删除版本" description="操作不可撤销"
      danger onConfirm={() => undefined} onClose={() => undefined} />);
    expect(confirm).toContain('data-variant="danger"');
  });

  it("keeps drawer, popover and tooltip semantics explicit", () => {
    expect(renderToStaticMarkup(<Drawer open title="属性" onClose={() => undefined}>内容</Drawer>)).toContain('role="dialog"');
    expect(renderToStaticMarkup(<Popover open label="筛选" trigger={<Button>筛选</Button>} onClose={() => undefined}>条件</Popover>))
      .toContain('aria-label="筛选"');
    expect(renderToStaticMarkup(<Tooltip content="复制哈希"><Button>复制</Button></Tooltip>)).toContain('role="tooltip"');
  });
});
