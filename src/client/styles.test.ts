import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const styles = [
  "styles/tokens.css",
  "styles/reset.css",
  "styles/globals.css",
  "styles/motion.css",
  "styles.css"
].map((file) => fs.readFileSync(path.resolve("src/client", file), "utf8")).join("\n");
const appShellStyles = fs.readFileSync(path.resolve("src/client/patterns/AppShell/AppShell.module.css"), "utf8");
const navigationStyles = fs.readFileSync(path.resolve("src/client/ui/navigation/Navigation.module.css"), "utf8");
const dataStyles = fs.readFileSync(path.resolve("src/client/ui/data/Data.module.css"), "utf8");
const pdfCanvasStyles = fs.readFileSync(path.resolve("src/client/features/pdf-studio/PdfCanvasViewport.module.css"), "utf8");
const pdfViewportStyles = fs.readFileSync(path.resolve("src/client/features/pdf-studio/PdfViewportControls.module.css"), "utf8");
const pdfToolbarStyles = fs.readFileSync(path.resolve("src/client/features/pdf-studio/PdfToolbar.module.css"), "utf8");
const draftPopoverStyles = fs.readFileSync(path.resolve("src/client/features/pdf-studio/AnnotationDraftPopover.module.css"), "utf8");
const annotationLayerStyles = fs.readFileSync(path.resolve("src/client/widgets/PdfAnnotationLayer.module.css"), "utf8");
const signatureWorkspaceStyles = fs.readFileSync(path.resolve("src/client/widgets/PdfSignaturePlacementWorkspace.module.css"), "utf8");

function ruleFor(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

function rulesFor(selector: string) {
  const matches = Array.from(styles.matchAll(/([^{}]+)\{([^}]*)\}/g));
  return matches
    .filter((match) => match[1].split(",").map((item) => item.trim()).includes(selector))
    .map((match) => match[2])
    .join("\n");
}

function mediaBlockFor(query: string, source = styles) {
  const start = source.indexOf(`@media ${query}`);
  if (start === -1) return "";
  const open = source.indexOf("{", start);
  if (open === -1) return "";
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  return "";
}

function ruleForIn(block: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

describe("approval detail PDF placement styles", () => {
  it("keeps the redesigned workbench accessible and data-scannable", () => {
    const body = rulesFor("body");
    const focusStyles = rulesFor("button:focus-visible");
    const root = ruleFor(":root");

    expect(body).toContain("font-variant-numeric: tabular-nums");
    expect(focusStyles).toContain("box-shadow: var(--focus)");
    expect(root).toContain("--radius-panel: var(--radius-lg)");
    expect(root).toContain("--radius-lg: 0.5rem");
    expect(styles).not.toContain("border-radius: 999px");
  });

  it("anchors the signature placement layer inside the component-scoped workspace", () => {
    const workspace = ruleForIn(signatureWorkspaceStyles, ".workspace");
    const layer = ruleFor(".signature-placement-layer");

    expect(workspace).toContain("height: 100%");
    expect(workspace).toContain("overflow: hidden");
    expect(layer).toContain("position: absolute");
    expect(layer).toContain("inset: 0");
  });

  it("removes the superseded detail rail, floating panel, and legacy annotation toolbar", () => {
    for (const selector of [".detail-layout", ".detail-pdf-stage", ".side-panel", ".floating-support-panel", ".annotation-toolbar", ".annotation-popover"]) {
      expect(styles).not.toContain(selector);
    }
  });

  it("supports a compact collapsible sidebar rail", () => {
    expect(appShellStyles).toContain('grid-template-columns: var(--nav-width-collapsed) minmax(0, 1fr)');
    expect(appShellStyles).toContain('.shell[data-collapsed="true"] .brand { justify-content: center; }');
    expect(appShellStyles).toContain('.shell[data-collapsed="true"] .compactRole');
    expect(navigationStyles).toContain('.navigation[data-collapsed="true"] .link');
    expect(navigationStyles).toContain('grid-template-columns: 1fr');
    expect(navigationStyles).toContain('.navigation[data-collapsed="true"] .label { display: none; }');
  });

  it("adapts the app shell and core work surfaces for phone widths", () => {
    const mobileData = mediaBlockFor("(max-width: 48rem)", dataStyles);
    const approvalRow = ruleForIn(mobileData, ".dataTable tbody tr");
    const approvalCell = ruleForIn(mobileData, ".dataTable td");
    const approvalCellBefore = ruleForIn(mobileData, ".dataTable td::before");
    const mobilePdf = mediaBlockFor("(max-width: 42.5rem)", pdfCanvasStyles);
    const tableActionBar = ruleForIn(mobileData, ".batchActionBar");

    expect(appShellStyles).toContain("@media (max-width: 32.5rem)");
    expect(appShellStyles).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(navigationStyles).toContain("overflow-x: auto");
    expect(navigationStyles).toContain("flex: 0 0 auto");
    expect(approvalRow).toContain("display: grid");
    expect(approvalCell).toContain("grid-template-columns:");
    expect(approvalCellBefore).toContain("content: attr(data-label)");
    expect(ruleForIn(mobilePdf, ".viewport")).toContain("padding: var(--space-2)");
    expect(tableActionBar).toContain("flex-direction: column");
    expect(mobileData).toContain("position: sticky");
    expect(mobileData).toContain("z-index: var(--z-sticky)");
  });

  it("keeps PDF pages and signature boxes in one scrollable placement workspace", () => {
    const workspace = ruleForIn(signatureWorkspaceStyles, ".workspace");
    const page = ruleForIn(signatureWorkspaceStyles, ".page");
    const canvas = ruleForIn(signatureWorkspaceStyles, ".canvas");
    const layer = ruleFor(".signature-placement-layer");

    expect(workspace).toContain("display: flex");
    expect(workspace).toContain("overflow: hidden");
    expect(page).toContain("position: relative");
    expect(canvas).toContain("width: 100%");
    expect(layer).toContain("position: absolute");
    expect(layer).toContain("inset: 0");
  });

  it("supports PDF zoom controls and drag-to-pan scrolling", () => {
    const toolbar = ruleForIn(pdfViewportStyles, ".toolbar");
    const toolbarButton = ruleForIn(pdfViewportStyles, ".toolbar button");
    const zoom = ruleForIn(pdfViewportStyles, ".zoom");
    const scroll = ruleForIn(signatureWorkspaceStyles, ".viewport");
    const pan = ruleForIn(signatureWorkspaceStyles, '.viewport[data-pan="true"]');
    const panning = ruleForIn(signatureWorkspaceStyles, '.viewport[data-panning="true"]');
    const placementPage = ruleForIn(signatureWorkspaceStyles, ".page");
    const annotationPage = ruleForIn(pdfCanvasStyles, ".page");

    expect(toolbar).toContain("display: flex");
    expect(toolbar).toContain("gap: var(--space-1)");
    expect(toolbarButton).toContain("width: var(--icon-button-sm)");
    expect(toolbarButton).toContain("place-items: center");
    expect(zoom).toContain("min-width: 3.25rem");
    expect(scroll).toContain("overflow: auto");
    expect(scroll).toContain("touch-action: pan-x pan-y");
    expect(pan).toContain("cursor: grab");
    expect(panning).toContain("cursor: grabbing");
    expect(placementPage).toContain("width: var(--pdf-page-width, min(100%, 60rem))");
    expect(annotationPage).toContain("width: var(--pdf-page-width, min(100%, 60rem))");
  });

  it("shows compact PDF thumbnail navigation without resizing the document", () => {
    const thumbnails = ruleForIn(signatureWorkspaceStyles, ".thumbnails");
    const thumbnail = ruleForIn(signatureWorkspaceStyles, ".thumbnail");
    const activeThumbnail = ruleForIn(signatureWorkspaceStyles, '.thumbnail[data-active="true"]');
    const thumbnailPreview = ruleForIn(signatureWorkspaceStyles, ".thumbnailPreview");

    expect(thumbnails).toContain("display: flex");
    expect(thumbnails).toContain("overflow-x: auto");
    expect(thumbnail).toContain("width:");
    expect(thumbnail).toContain("flex: 0 0 auto");
    expect(activeThumbnail).toContain("border-color:");
    expect(thumbnailPreview).toContain("aspect-ratio:");
  });

  it("keeps admin operation logs bounded inside a scrollable panel", () => {
    expect(dataStyles).toContain('.dataTable[data-sticky-header="true"] th');
    expect(dataStyles).toContain("position: sticky");
    expect(dataStyles).toContain("top: 0");
    expect(dataStyles).toContain("z-index: var(--z-sticky)");
  });

  it("keeps profile and role guide layouts responsive at medium window widths", () => {
    const pageHeading = ruleFor(".page-heading");
    const formActions = rulesFor(".form-actions");
    const inputs = rulesFor("input");
    const adminTabs = ruleFor(".admin-tabs");
    const adminTabButton = ruleFor(".admin-tabs button");
    const roleStepText = ruleFor(".role-flow-guide__steps strong");
    const roleActions = ruleFor(".role-flow-guide__actions");
    const profileGrid = ruleFor(".profile-page-grid");
    const profileFormGrid = ruleFor(".profile-form-grid");
    const profileLabel = ruleFor(".profile-form-grid label");
    const profileInput = ruleFor(".profile-form-grid input");
    const notificationList = ruleFor(".notification-preference-list");
    const medium = mediaBlockFor("(max-width: 1280px)");
    const mediumGuide = ruleForIn(medium, ".role-flow-guide:not(.role-flow-guide--collapsed)");
    const mediumSteps = ruleForIn(medium, ".role-flow-guide:not(.role-flow-guide--collapsed) .role-flow-guide__steps");

    expect(pageHeading).toContain("flex-wrap: wrap");
    expect(formActions).toContain("flex-wrap: wrap");
    expect(inputs).toContain("max-width: 100%");
    expect(adminTabs).toContain("overflow-x: auto");
    expect(adminTabButton).toContain("flex: 0 0 auto");
    expect(adminTabButton).toContain("white-space: nowrap");
    expect(roleStepText).toContain("overflow-wrap: anywhere");
    expect(roleStepText).toContain("white-space: normal");
    expect(roleActions).toContain("flex-wrap: wrap");
    expect(profileGrid).toContain("repeat(auto-fit, minmax(min(100%, 340px), 1fr))");
    expect(profileFormGrid).toContain("repeat(auto-fit, minmax(min(100%, 180px), 1fr))");
    expect(profileLabel).toContain("min-width: 0");
    expect(profileInput).toContain("width: 100%");
    expect(profileInput).toContain("min-width: 0");
    expect(notificationList).toContain("repeat(auto-fit, minmax(min(100%, 260px), 1fr))");
    expect(mediumGuide).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(mediumSteps).toContain("grid-column: 1 / -1");
  });

  it("keeps drawing annotation text readable on top of the PDF", () => {
    const textMarker = ruleForIn(annotationLayerStyles, '.marker[data-kind="text"]');
    const textBody = ruleForIn(annotationLayerStyles, '.marker[data-kind="text"] > em');
    const draft = ruleForIn(annotationLayerStyles, ".draft");
    const draftText = ruleForIn(annotationLayerStyles, '.draft[data-kind="text"]');

    expect(textMarker).toContain("display: block");
    expect(textMarker).toContain("min-width: 2.625rem");
    expect(textMarker).toContain("min-height: 1.5rem");
    expect(textBody).toContain("position: absolute");
    expect(textBody).toContain("inset: 3px");
    expect(textBody).toContain("font-size: var(--font-size-body)");
    expect(textBody).toContain("white-space: pre-wrap");
    expect(draft).toContain("border: 2px dashed currentColor");
    expect(draftText).toContain("min-width: 2.625rem");
    expect(draftText).toContain("font-size: var(--font-size-body)");
  });

  it("supports in-canvas annotation tools, popover comments, and selected handles", () => {
    const toolbar = ruleForIn(pdfToolbarStyles, ".bar");
    const popover = ruleForIn(draftPopoverStyles, ".popover");
    const popoverTextArea = ruleForIn(draftPopoverStyles, ".field textarea");
    const selectedMarker = ruleForIn(annotationLayerStyles, '.marker[data-selected="true"]');
    const resizeHandle = ruleForIn(annotationLayerStyles, ".resizeHandle");

    expect(toolbar).toContain("display:");
    expect(toolbar).toContain("overflow-x: auto");
    expect(popover).toContain("position: absolute");
    expect(popover).toContain("z-index:");
    expect(popoverTextArea).toContain("resize: vertical");
    expect(selectedMarker).toContain("box-shadow:");
    expect(resizeHandle).toContain("position: absolute");
  });

  it("renders annotation colors as real swatches and selected callouts", () => {
    const swatch = ruleForIn(pdfToolbarStyles, ".swatch");
    const activeSwatch = ruleForIn(pdfToolbarStyles, '.swatch[data-selected="true"]');
    const customInput = ruleForIn(pdfToolbarStyles, ".custom input");
    const customWell = ruleForIn(pdfToolbarStyles, ".customWell");
    const palette = ruleForIn(pdfToolbarStyles, ".colors");
    const callout = ruleForIn(annotationLayerStyles, ".callout");

    expect(styles).not.toContain(".annotation-toolbar");
    expect(palette).toContain("display: flex");
    expect(swatch).toContain("background: var(--annotation-choice)");
    expect(swatch).toContain("color: var(--palette-white)");
    expect(activeSwatch).toContain("box-shadow:");
    expect(activeSwatch).not.toContain("background: var(--primary)");
    expect(customInput).toContain("opacity: 0");
    expect(customWell).toContain("background: var(--annotation-choice)");
    expect(callout).toContain("position: absolute");
    expect(callout).toContain("white-space: normal");
  });

  it("uses rendering containment for growing operational lists and muted inline feedback", () => {
    const riskRow = ruleFor(".risk-row");
    const batchRow = rulesFor(".batch-history-row");
    const commentItem = rulesFor(".comment-item");
    const backupRun = rulesFor(".backup-run-row");
    const operationRow = dataStyles.match(/\.dataTable tbody tr\s*\{([^}]*)\}/)?.[1] ?? "";
    const mutedInline = ruleFor(".muted-inline");

    expect(riskRow).toContain("content-visibility: auto");
    expect(batchRow).toContain("content-visibility: auto");
    expect(commentItem).toContain("content-visibility: auto");
    expect(backupRun).toContain("content-visibility: auto");
    expect(operationRow).toContain("content-visibility: auto");
    expect(mutedInline).toContain("color: var(--muted)");
  });
});
