import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, ButtonGroup, ButtonLink, IconButton } from "./index.tsx";

describe("design system actions", () => {
  it("renders finite button variants and preserves loading semantics", () => {
    const markup = renderToStaticMarkup(<>
      <Button variant="primary" loading loadingLabel="正在保存">保存修改</Button>
      <Button variant="secondary" size="sm">取消</Button>
      <Button variant="ghost">返回</Button>
      <Button variant="danger">删除版本</Button>
    </>);

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-label="正在保存"');
    expect(markup).toContain("正在保存");
    expect(markup).toContain("保存修改");
    expect(markup.match(/disabled=""/g)).toHaveLength(1);
    expect(markup).toContain('data-variant="danger"');
  });

  it("requires an accessible icon label and reuses it as the tooltip", () => {
    const markup = renderToStaticMarkup(<IconButton label="关闭检查器"><span aria-hidden="true">×</span></IconButton>);

    expect(markup).toContain('aria-label="关闭检查器"');
    expect(markup).toContain('title="关闭检查器"');
  });

  it("keeps links semantic and groups actions without changing their type", () => {
    const markup = renderToStaticMarkup(<ButtonGroup aria-label="版本操作">
      <ButtonLink href="/drawings/18">打开图纸</ButtonLink>
      <Button type="button" variant="secondary">复制编号</Button>
    </ButtonGroup>);

    expect(markup).toContain('<a href="/drawings/18"');
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="版本操作"');
  });
});
