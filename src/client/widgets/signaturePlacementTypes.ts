export type SignaturePlacementRole = "designer" | "supervisor" | "process";

export type SignaturePlacement = {
  role: SignaturePlacementRole;
  pageNumber: number;
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
};
