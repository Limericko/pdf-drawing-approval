import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectionBanner, EmptyState, ErrorState, InlineAlert, Progress, SaveIndicator, Skeleton, Toast } from "./index.tsx";

describe("design system feedback", () => {
  it("uses semantic live regions for persistent and transient feedback", () => {
    const markup = renderToStaticMarkup(<>
      <InlineAlert tone="danger" title="保存失败">请检查网络后重试。</InlineAlert>
      <InlineAlert tone="success">图纸已发布。</InlineAlert>
      <Toast tone="info">已复制物料号。</Toast>
      <ConnectionBanner status="offline">网络已断开，修改保存在本机。</ConnectionBanner>
    </>);

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-tone="danger"');
    expect(markup).toContain('data-status="offline"');
  });

  it("covers save, progress, loading, empty and retry states without a spinner", () => {
    const markup = renderToStaticMarkup(<>
      <SaveIndicator status="saving" />
      <Progress label="上传图纸" value={47} />
      <Skeleton lines={3} />
      <EmptyState title="暂无问题">当前图纸没有待处理问题。</EmptyState>
      <ErrorState title="项目读取失败" onRetry={() => undefined}>请重新加载项目。</ErrorState>
    </>);

    expect(markup).toContain('aria-valuenow="47"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("暂无问题");
    expect(markup).toContain("重试");
    expect(markup).not.toContain("spinner");
  });
});
