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

function mediaBlockFor(query: string) {
  const start = styles.indexOf(`@media ${query}`);
  if (start === -1) return "";
  const open = styles.indexOf("{", start);
  if (open === -1) return "";
  let depth = 0;
  for (let index = open; index < styles.length; index += 1) {
    const char = styles[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return styles.slice(open + 1, index);
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

  it("anchors the signature placement layer to the detail PDF preview", () => {
    const detailStage = ruleFor(".detail-pdf-stage");
    const layer = ruleFor(".signature-placement-layer");

    expect(detailStage).toContain("position: sticky");
    expect(detailStage).toContain("height: clamp(560px, calc(100vh - 150px), 980px)");
    expect(detailStage).toContain("overflow: hidden");
    expect(layer).toContain("position: absolute");
    expect(layer).toContain("inset: 0");
  });

  it("keeps the approval side panel independently scrollable", () => {
    const sidePanel = rulesFor(".side-panel");

    expect(sidePanel).toContain("position: sticky");
    expect(sidePanel).toContain("max-height: calc(100vh - 40px)");
    expect(sidePanel).toContain("overflow-y: auto");
  });

  it("renders traceability content as a movable floating panel", () => {
    const launcher = ruleFor(".support-launcher");
    const floatingPanel = ruleFor(".floating-support-panel");
    const floatingHeader = ruleFor(".floating-panel-header");

    expect(launcher).toContain("display: grid");
    expect(floatingPanel).toContain("position: fixed");
    expect(floatingPanel).toContain("z-index: 20");
    expect(floatingHeader).toContain("cursor: move");
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
    const mobile = mediaBlockFor("(max-width: 520px)");
    const approvalRow = ruleForIn(mobile, ".approval-table tbody tr");
    const approvalCell = ruleForIn(mobile, ".approval-table td");
    const approvalCellBefore = ruleForIn(mobile, ".approval-table td::before");
    const pdfStage = ruleForIn(mobile, ".detail-pdf-stage");
    const tableActionBar = ruleForIn(mobile, ".table-action-bar");

    expect(appShellStyles).toContain("@media (max-width: 32.5rem)");
    expect(appShellStyles).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(navigationStyles).toContain("overflow-x: auto");
    expect(navigationStyles).toContain("flex: 0 0 auto");
    expect(approvalRow).toContain("display: grid");
    expect(approvalCell).toContain("grid-template-columns:");
    expect(approvalCellBefore).toContain("content: attr(data-label)");
    expect(pdfStage).toContain("height: 64vh");
    expect(tableActionBar).toContain("position: sticky");
  });

  it("keeps PDF pages and signature boxes in one scrollable placement workspace", () => {
    const workspace = ruleFor(".pdf-placement-workspace");
    const page = ruleFor(".pdf-placement-page");
    const canvas = ruleFor(".pdf-placement-canvas");
    const layer = ruleFor(".signature-placement-layer");

    expect(workspace).toContain("display: flex");
    expect(workspace).toContain("overflow: hidden");
    expect(page).toContain("position: relative");
    expect(canvas).toContain("width: 100%");
    expect(layer).toContain("position: absolute");
    expect(layer).toContain("inset: 0");
  });

  it("supports PDF zoom controls and drag-to-pan scrolling", () => {
    const toolbar = ruleFor(".pdf-viewport-toolbar");
    const toolbarButton = ruleFor(".pdf-viewport-toolbar button");
    const zoom = ruleFor(".pdf-viewport-toolbar__zoom");
    const scroll = ruleFor(".pdf-viewport-scroll");
    const pan = ruleFor(".pdf-viewport-scroll--pan");
    const panning = ruleFor(".pdf-viewport-scroll--panning");
    const placementPage = ruleFor(".pdf-placement-page");
    const annotationPage = ruleFor(".pdf-annotation-page");

    expect(toolbar).toContain("display: flex");
    expect(toolbar).toContain("border-bottom: 1px solid var(--line)");
    expect(toolbarButton).toContain("width: 34px");
    expect(toolbarButton).toContain("place-items: center");
    expect(zoom).toContain("min-width: 52px");
    expect(scroll).toContain("overflow: auto");
    expect(scroll).toContain("touch-action: pan-x pan-y");
    expect(pan).toContain("cursor: grab");
    expect(panning).toContain("cursor: grabbing");
    expect(placementPage).toContain("width: var(--pdf-page-width, min(100%, 960px))");
    expect(annotationPage).toContain("width: var(--pdf-page-width, min(100%, 960px))");
  });

  it("shows compact PDF thumbnail navigation without resizing the document", () => {
    const thumbnails = ruleFor(".pdf-page-thumbnails");
    const thumbnail = ruleFor(".pdf-page-thumbnail");
    const activeThumbnail = ruleFor(".pdf-page-thumbnail--active");
    const thumbnailPreview = ruleFor(".pdf-page-thumbnail__preview");

    expect(thumbnails).toContain("display: flex");
    expect(thumbnails).toContain("overflow-x: auto");
    expect(thumbnail).toContain("width:");
    expect(thumbnail).toContain("flex: 0 0 auto");
    expect(activeThumbnail).toContain("border-color:");
    expect(thumbnailPreview).toContain("aspect-ratio:");
  });

  it("keeps admin operation logs bounded inside a scrollable panel", () => {
    const logSurface = ruleFor(".operation-log-panel .table-surface");
    const tableHeader = ruleFor(".operation-log-panel .data-table th");

    expect(logSurface).toContain("max-height:");
    expect(logSurface).toContain("overflow: auto");
    expect(tableHeader).toContain("position: sticky");
    expect(tableHeader).toContain("top: 0");
    expect(tableHeader).toContain("z-index:");
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
    const textMarker = ruleFor(".pdf-annotation-marker--text");
    const textBody = ruleFor(".pdf-annotation-marker--text em");
    const draft = ruleFor(".pdf-annotation-draft");
    const draftText = ruleFor(".pdf-annotation-draft--text");

    expect(textMarker).toContain("display: block");
    expect(textMarker).toContain("min-width: 42px");
    expect(textMarker).toContain("min-height: 24px");
    expect(textBody).toContain("position: absolute");
    expect(textBody).toContain("inset: 3px");
    expect(textBody).toContain("font-size: 14px");
    expect(textBody).toContain("white-space: pre-wrap");
    expect(draft).toContain("border: 2px dashed currentColor");
    expect(draftText).toContain("min-width: 42px");
    expect(draftText).toContain("font-size: 14px");
  });

  it("supports in-canvas annotation tools, popover comments, and selected handles", () => {
    const toolbar = ruleFor(".annotation-toolbar");
    const popover = ruleFor(".annotation-popover");
    const popoverTextArea = ruleFor(".annotation-popover textarea");
    const selectedMarker = ruleFor(".pdf-annotation-marker--selected");
    const resizeHandle = ruleFor(".pdf-annotation-resize-handle");
    const pdfToolbar = ruleFor(".pdf-annotation-toolbar");

    expect(toolbar).toContain("display:");
    expect(toolbar).toContain("position:");
    expect(popover).toContain("position: absolute");
    expect(popover).toContain("z-index:");
    expect(popoverTextArea).toContain("resize: vertical");
    expect(selectedMarker).toContain("box-shadow:");
    expect(resizeHandle).toContain("position: absolute");
    expect(pdfToolbar).toContain("display:");
  });

  it("renders annotation colors as real swatches and selected callouts", () => {
    const swatch = ruleFor(".annotation-color-swatch");
    const activeSwatch = ruleFor(".annotation-color-swatch.active");
    const customInput = ruleFor(".annotation-custom-color-input");
    const customWell = ruleFor(".annotation-custom-color__well");
    const palette = ruleFor(".annotation-color-palette");
    const paletteSwatches = ruleFor(".annotation-color-palette__swatches");
    const callout = ruleFor(".pdf-annotation-callout");
    const toolbarIcon = ruleFor(".annotation-toolbar__tools svg");

    expect(styles).not.toContain(".annotation-toolbar button {");
    expect(styles).not.toContain(".annotation-toolbar button.active");
    expect(ruleFor(".annotation-toolbar__tools button")).toContain("background: var(--surface-raised)");
    expect(palette).toContain("display: flex");
    expect(paletteSwatches).toContain("display: flex");
    expect(swatch).toContain("background: var(--annotation-choice)");
    expect(swatch).toContain("color: #ffffff");
    expect(activeSwatch).toContain("outline:");
    expect(activeSwatch).not.toContain("background: var(--primary)");
    expect(customInput).toContain("appearance: none");
    expect(customInput).toContain("opacity: 0");
    expect(customWell).toContain("background: var(--annotation-choice)");
    expect(callout).toContain("position: absolute");
    expect(callout).toContain("white-space: normal");
    expect(toolbarIcon).toContain("width:");
  });

  it("uses rendering containment for growing operational lists and muted inline feedback", () => {
    const riskRow = ruleFor(".risk-row");
    const batchRow = rulesFor(".batch-history-row");
    const commentItem = rulesFor(".comment-item");
    const backupRun = rulesFor(".backup-run-row");
    const operationRow = ruleFor(".operation-table tbody tr");
    const mutedInline = ruleFor(".muted-inline");

    expect(riskRow).toContain("content-visibility: auto");
    expect(batchRow).toContain("content-visibility: auto");
    expect(commentItem).toContain("content-visibility: auto");
    expect(backupRun).toContain("content-visibility: auto");
    expect(operationRow).toContain("content-visibility: auto");
    expect(mutedInline).toContain("color: var(--muted)");
  });
});
