import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TextInput } from "../../ui/forms/index.tsx";
import { Breadcrumbs, SegmentedControl, Tabs } from "../../ui/navigation/index.tsx";
import { FilterBar } from "../FilterBar/index.tsx";
import { PageHeader } from "./index.tsx";

describe("DS3 page patterns", () => {
  it("renders headers, breadcrumbs and compact filtering semantics", () => {
    const html = renderToStaticMarkup(<><PageHeader title="我的任务" eyebrow="TASKS"
      breadcrumbs={<Breadcrumbs items={[{ label: "首页", href: "#/" }, { label: "我的任务" }]} />} />
      <FilterBar summary="共 12 项"><TextInput id="filter" label="关键词" /></FilterBar></>);
    expect(html).toContain("我的任务");
    expect(html).toContain('aria-label="面包屑"');
    expect(html).toContain('aria-label="筛选条件"');
    expect(html).toContain('role="status"');
  });

  it("exposes tabs and segmented controls as explicit choices", () => {
    const tabs = renderToStaticMarkup(<Tabs label="任务视图" activeId="mine" onChange={() => undefined}
      items={[{ id: "mine", label: "待我处理" }, { id: "all", label: "全部" }]} />);
    const segments = renderToStaticMarkup(<SegmentedControl label="密度" activeId="dense" onChange={() => undefined}
      items={[{ id: "dense", label: "紧凑" }, { id: "comfortable", label: "舒适" }]} />);
    expect(tabs).toContain('role="tablist"');
    expect(tabs).toContain('aria-selected="true"');
    expect(segments).toContain('aria-pressed="true"');
  });
});
