import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PlatformPartDetail } from "../../api/pdmClient.ts";
import { PdmRevisionActions } from "./PlatformWorkspace.tsx";

const revision: PlatformPartDetail["revisions"][number] = {
  linkId: "01890f1e-9b4a-7cc2-8f00-000000001601",
  revisionId: "01890f1e-9b4a-7cc2-8f00-000000001602",
  revisionCode: "A01",
  documentId: "01890f1e-9b4a-7cc2-8f00-000000001603",
  documentCode: "GX-240714-001",
  approvalCaseId: "01890f1e-9b4a-7cc2-8f00-000000001604",
  originalObjectId: "01890f1e-9b4a-7cc2-8f00-000000001605",
  signedObjectId: null,
  annotatedObjectId: null,
  materialCode: null,
  releaseStatus: "pending_metadata",
  voidReason: null,
  version: 1,
  releasedAt: null,
  createdAt: "2026-07-14T08:00:00.000Z",
  updatedAt: "2026-07-14T08:00:00.000Z"
};

describe("PdmRevisionActions", () => {
  it("shows material completion and audited manager void controls for pending metadata", () => {
    const html = renderToStaticMarkup(<PdmRevisionActions
      projectId="01890f1e-9b4a-7cc2-8f00-000000001606" revision={revision} canVoid onChanged={vi.fn()} />);
    expect(html).toContain("补录并发布");
    expect(html).toContain('placeholder="材料牌号"');
    expect(html).toContain('placeholder="作废原因"');
    expect(html).toContain("作废版本");
  });

  it("shows retry for failed publication without exposing manager actions to a viewer", () => {
    const html = renderToStaticMarkup(<PdmRevisionActions
      projectId="01890f1e-9b4a-7cc2-8f00-000000001606"
      revision={{ ...revision, releaseStatus: "failed", materialCode: "40Cr" }} canVoid={false} onChanged={vi.fn()} />);
    expect(html).toContain("重试发布");
    expect(html).not.toContain("作废版本");
    expect(html).not.toContain("补录并发布");
  });

  it("renders an immutable void reason instead of mutation controls", () => {
    const html = renderToStaticMarkup(<PdmRevisionActions
      projectId="01890f1e-9b4a-7cc2-8f00-000000001606"
      revision={{ ...revision, releaseStatus: "void", voidReason: "图号录入错误" }} canVoid onChanged={vi.fn()} />);
    expect(html).toContain("作废原因：图号录入错误");
    expect(html).not.toContain("button");
  });
});
