import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Badge,
  BatchActionBar,
  DataTable,
  FileLink,
  HashValue,
  KeyValueList,
  Pagination,
  StatusChip,
  TableFrame,
  Timeline,
  type DataTableColumn
} from "./index.tsx";

type DrawingRow = {
  readonly id: number;
  readonly drawing: string;
  readonly version: string;
  readonly status: string;
};

const rows: readonly DrawingRow[] = [
  { id: 18, drawing: "GX-240713-018", version: "A03", status: "等待工艺确认" },
  { id: 22, drawing: "GX-240713-022", version: "A01", status: "主管已通过" }
];

const columns: readonly DataTableColumn<DrawingRow>[] = [
  { id: "drawing", header: "图号", cell: (row) => row.drawing },
  { id: "version", header: "版本", cell: (row) => row.version, mobileHidden: true },
  { id: "status", header: "状态", cell: (row) => <StatusChip tone="warning">{row.status}</StatusChip> }
];

describe("design system data components", () => {
  it("renders domain-neutral status, metadata and file primitives", () => {
    const markup = renderToStaticMarkup(<>
      <StatusChip tone="success">已发布</StatusChip>
      <Badge tone="primary">3 个问题</Badge>
      <KeyValueList items={[{ label: "零件号", value: "GX-240713-018" }, { label: "版本", value: "A03" }]} />
      <FileLink href="/files/18">减速器壳体-A03.pdf</FileLink>
      <HashValue value="8f2c26df4a917e8ac0" />
    </>);

    expect(markup).toContain('data-tone="success"');
    expect(markup).toContain('data-tone="primary"');
    expect(markup).toContain("<dl");
    expect(markup).toContain('href="/files/18"');
    expect(markup).toContain("8f2c26df4a917e8ac0");
  });

  it("renders accessible headers, mobile field choices and controlled selection", () => {
    const markup = renderToStaticMarkup(<DataTable
      ariaLabel="图纸版本"
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.id}
      getRowLabel={(row) => row.drawing}
      selectedKeys={new Set([18])}
      onSelectionChange={() => undefined}
      stickyHeader
    />);

    expect(markup).toContain('aria-label="图纸版本"');
    expect(markup).toContain('scope="col"');
    expect(markup).toContain('data-mobile-hidden="true"');
    expect(markup).toContain('aria-label="选择全部图纸版本"');
    expect(markup).toContain('aria-label="选择 GX-240713-018"');
    expect(markup).toContain('data-sticky-header="true"');
    expect(markup.match(/checked=""/g)).toHaveLength(1);
  });

  it("keeps loading, empty and error states inside the table frame", () => {
    const loading = renderToStaticMarkup(<TableFrame title="图纸版本"><DataTable
      ariaLabel="图纸版本"
      columns={columns}
      rows={[]}
      getRowKey={(row) => row.id}
      loading
    /></TableFrame>);
    const empty = renderToStaticMarkup(<DataTable ariaLabel="图纸版本" columns={columns} rows={[]}
      getRowKey={(row) => row.id} emptyTitle="暂无图纸版本" emptyDescription="提交后将在此显示。" />);
    const failed = renderToStaticMarkup(<DataTable ariaLabel="图纸版本" columns={columns} rows={[]}
      getRowKey={(row) => row.id} error="无法读取图纸版本" onRetry={() => undefined} />);

    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("正在加载图纸版本");
    expect(empty).toContain("暂无图纸版本");
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("重试");
  });

  it("exposes pagination, timeline and batch actions with stable semantics", () => {
    const markup = renderToStaticMarkup(<>
      <Pagination page={2} pageCount={7} onPageChange={() => undefined} totalItems={126} />
      <Timeline items={[
        { id: "created", title: "提交图纸", timestamp: "2026-07-13 09:42", tone: "info" },
        { id: "approved", title: "主管通过", timestamp: "2026-07-13 11:18", tone: "success" }
      ]} />
      <BatchActionBar selectedCount={3} onClearSelection={() => undefined}><button type="button">打印归档</button></BatchActionBar>
    </>);

    expect(markup).toContain('aria-label="分页"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("第 2 / 7 页");
    expect(markup).toContain("126 条记录");
    expect(markup).toContain("<ol");
    expect(markup).toContain("已选择 3 项");
    expect(markup).toContain("清除选择");
  });
});
