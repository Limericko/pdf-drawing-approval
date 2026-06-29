import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.ts";
import type { SignatureTemplate, SignatureTemplateRepository } from "../repositories/signatureTemplates.ts";

const placementSchema = z.object({
  role: z.enum(["designer", "supervisor", "process"]),
  pageNumber: z.number().int().min(1),
  xRatio: z.number(),
  yRatio: z.number(),
  widthRatio: z.number(),
  heightRatio: z.number()
});

const templateInputSchema = z.object({
  name: z.string().trim().min(1),
  projectName: z.string().trim().min(1).nullable().optional(),
  placements: z.array(placementSchema)
});

export function signatureTemplateRoutes(deps: { signatureTemplates: SignatureTemplateRepository; jwtSecret: string }) {
  const router = Router();

  router.get("/", requireAuth(deps.jwtSecret, ["designer", "admin"]), (req, res) => {
    if (typeof req.query.projectName === "string") {
      return res.json(deps.signatureTemplates.list({ projectName: req.query.projectName }));
    }
    res.json(deps.signatureTemplates.list());
  });

  router.post("/", requireAuth(deps.jwtSecret, ["designer", "admin"]), (req, res) => {
    const parsed = templateInputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    try {
      const template = deps.signatureTemplates.create({
        ...parsed.data,
        createdByUserId: req.user?.id ?? null
      });
      res.status(201).json(template);
    } catch (error) {
      if (isTemplateValidationError(error)) return res.status(400).json({ error: "INVALID_SIGNATURE_TEMPLATE" });
      res.status(500).json({ error: "CREATE_SIGNATURE_TEMPLATE_FAILED" });
    }
  });

  router.put("/:id", requireAuth(deps.jwtSecret, ["designer", "admin"]), (req, res) => {
    const template = deps.signatureTemplates.getById(Number(req.params.id));
    if (!template) return res.status(404).json({ error: "SIGNATURE_TEMPLATE_NOT_FOUND" });
    if (!canManageTemplate(req.user, template)) return res.status(403).json({ error: "FORBIDDEN" });

    const parsed = templateInputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });

    try {
      res.json(deps.signatureTemplates.update(template.id, parsed.data));
    } catch (error) {
      if (isTemplateValidationError(error)) return res.status(400).json({ error: "INVALID_SIGNATURE_TEMPLATE" });
      res.status(500).json({ error: "UPDATE_SIGNATURE_TEMPLATE_FAILED" });
    }
  });

  router.delete("/:id", requireAuth(deps.jwtSecret, ["designer", "admin"]), (req, res) => {
    const template = deps.signatureTemplates.getById(Number(req.params.id));
    if (!template) return res.status(404).json({ error: "SIGNATURE_TEMPLATE_NOT_FOUND" });
    if (!canManageTemplate(req.user, template)) return res.status(403).json({ error: "FORBIDDEN" });

    deps.signatureTemplates.delete(template.id);
    res.json({ deleted: true, templateId: template.id });
  });

  return router;
}

function canManageTemplate(user: Express.Request["user"], template: SignatureTemplate) {
  return user?.role === "admin" || template.createdByUserId === user?.id;
}

function isTemplateValidationError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return (
    message === "SIGNATURE_TEMPLATE_NAME_REQUIRED" ||
    message === "SIGNATURE_TEMPLATE_REQUIRES_ALL_ROLES" ||
    message === "INVALID_SIGNATURE_ROLE" ||
    message === "INVALID_SIGNATURE_PLACEMENT"
  );
}
