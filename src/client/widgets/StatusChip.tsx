import { signatureStatusLabel, statusLabel } from "./status.ts";

const toneByStatus: Record<string, string> = {
  pending: "status-chip status-chip--pending",
  approved: "status-chip status-chip--approved",
  rejected: "status-chip status-chip--rejected",
  approved_for_print: "status-chip status-chip--print",
  printed_archived: "status-chip status-chip--archived",
  filename_invalid: "status-chip status-chip--invalid",
  file_missing: "status-chip status-chip--invalid",
  invalid_pdf: "status-chip status-chip--invalid",
  voided: "status-chip status-chip--archived",
  running: "status-chip status-chip--pending",
  completed: "status-chip status-chip--approved",
  failed: "status-chip status-chip--invalid"
};

const signatureToneByStatus: Record<string, string> = {
  not_required: "status-chip status-chip--archived",
  placement_required: "status-chip status-chip--pending",
  pending: "status-chip status-chip--pending",
  ready: "status-chip status-chip--pending",
  generated: "status-chip status-chip--approved",
  failed: "status-chip status-chip--invalid"
};

export type StatusChipContext = "default" | "signature";

export function statusChipClassName(status: string, context: StatusChipContext = "default") {
  if (context === "signature") {
    return signatureToneByStatus[status] ?? "status-chip";
  }
  return toneByStatus[status] ?? "status-chip";
}

export function StatusChip({ status, context = "default" }: { status: string; context?: StatusChipContext }) {
  const label = context === "signature" ? signatureStatusLabel(status) : statusLabel(status);
  return <span className={statusChipClassName(status, context)}>{label}</span>;
}
