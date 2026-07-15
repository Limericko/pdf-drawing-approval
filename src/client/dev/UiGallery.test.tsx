import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UiGallery } from "./UiGallery.tsx";

describe("UiGallery", () => {
  it("documents the DS0 and DS1 foundations with real Chinese content", () => {
    const markup = renderToStaticMarkup(<UiGallery />);

    expect(markup).toContain("工程图纸协同平台");
    expect(markup).toContain("UI 设计系统基线");
    expect(markup).toContain("语义颜色");
    expect(markup).toContain("排版层级");
    expect(markup).toContain("间距与稳定尺寸");
    expect(markup).toContain("深色工具表面");
    expect(markup).toContain("操作组件");
    expect(markup).toContain("表单组件");
    expect(markup).toContain("反馈与状态");
    expect(markup).toContain("浮层与确认");
    expect(markup).toContain("页面壳层模式");
    expect(markup).toContain("数据展示与批量操作");
    expect(markup).toContain("PDF 审阅工作台");
    expect(markup).toContain("PDF Studio DS5 预览");
    expect(markup).toContain("加载状态");
    expect(markup).toContain("空状态");
    expect(markup).toContain("错误状态");
    expect(markup).not.toContain("Lorem ipsum");
  });

  it("uses semantic landmarks and exposes the current phase", () => {
    const markup = renderToStaticMarkup(<UiGallery />);

    expect(markup).toContain("<header");
    expect(markup).toContain("<main");
    expect(markup).toContain("<section");
    expect(markup).toContain("Phase 2–3 · DS0–DS5");
  });
});
