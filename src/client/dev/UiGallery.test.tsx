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
    expect(markup).not.toContain("Lorem ipsum");
  });

  it("uses semantic landmarks and exposes the current phase", () => {
    const markup = renderToStaticMarkup(<UiGallery />);

    expect(markup).toContain("<header");
    expect(markup).toContain("<main");
    expect(markup).toContain("<section");
    expect(markup).toContain("Phase 2 · DS0 / DS1");
  });
});
