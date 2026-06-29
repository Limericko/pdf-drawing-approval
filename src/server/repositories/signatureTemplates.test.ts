import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { SignatureTemplateRepository } from "./signatureTemplates.ts";
import { UserRepository } from "./users.ts";
import type { SignaturePlacementInput } from "./signaturePlacements.ts";

const standardPlacements: SignaturePlacementInput[] = [
  { role: "designer", pageNumber: 1, xRatio: 0.62, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
  { role: "supervisor", pageNumber: 1, xRatio: 0.74, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
  { role: "process", pageNumber: 1, xRatio: 0.86, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 }
];

function repositories() {
  const db = createDatabase(":memory:");
  const users = new UserRepository(db);
  const designer = users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });

  return {
    designer,
    templates: new SignatureTemplateRepository(db)
  };
}

describe("SignatureTemplateRepository", () => {
  it("creates and reads a template with all required signature placements", () => {
    const { designer, templates } = repositories();

    const created = templates.create({
      name: "A3 标准图框",
      projectName: "LS-300N",
      createdByUserId: designer.id,
      placements: standardPlacements
    });

    expect(created).toEqual(
      expect.objectContaining({
        name: "A3 标准图框",
        projectName: "LS-300N",
        createdByUserId: designer.id
      })
    );
    expect(created.placements.map((placement) => placement.role)).toEqual(["designer", "supervisor", "process"]);
    expect(templates.getById(created.id)?.placements[0]).toEqual(expect.objectContaining({ role: "designer", xRatio: 0.62 }));
  });

  it("lists global and project templates while excluding other projects", () => {
    const { designer, templates } = repositories();
    const global = templates.create({ name: "通用模板", projectName: null, createdByUserId: designer.id, placements: standardPlacements });
    const project = templates.create({ name: "项目模板", projectName: "LS-300N", createdByUserId: designer.id, placements: standardPlacements });
    templates.create({ name: "其它项目", projectName: "OTHER", createdByUserId: designer.id, placements: standardPlacements });

    expect(templates.list({ projectName: "LS-300N" }).map((template) => template.id)).toEqual([project.id, global.id]);
  });

  it("updates and deletes a template", () => {
    const { designer, templates } = repositories();
    const created = templates.create({ name: "旧模板", projectName: null, createdByUserId: designer.id, placements: standardPlacements });

    const updated = templates.update(created.id, {
      name: "新模板",
      projectName: "项目A",
      placements: standardPlacements.map((placement) =>
        placement.role === "designer" ? { ...placement, xRatio: 0.52, pageNumber: 2 } : placement
      )
    });

    expect(updated).toEqual(expect.objectContaining({ name: "新模板", projectName: "项目A" }));
    expect(updated.placements.find((placement) => placement.role === "designer")).toEqual(
      expect.objectContaining({ pageNumber: 2, xRatio: 0.52 })
    );

    templates.delete(created.id);

    expect(templates.getById(created.id)).toBeNull();
  });

  it("rejects templates without designer supervisor and process placements", () => {
    const { designer, templates } = repositories();

    expect(() =>
      templates.create({
        name: "缺少工艺",
        projectName: null,
        createdByUserId: designer.id,
        placements: standardPlacements.filter((placement) => placement.role !== "process")
      })
    ).toThrow("SIGNATURE_TEMPLATE_REQUIRES_ALL_ROLES");
  });
});
