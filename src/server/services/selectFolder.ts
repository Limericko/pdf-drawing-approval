import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export type FolderPickerStartResult = {
  pickerId: string;
};

export type FolderPickerPollResult =
  | { status: "pending" }
  | { status: "selected"; path: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

const pickerDir = path.join(os.tmpdir(), "pdf-approval-folder-picker");

export async function startFolderPicker(): Promise<FolderPickerStartResult> {
  await fs.mkdir(pickerDir, { recursive: true });
  const pickerId = crypto.randomUUID();
  const scriptPath = path.join(pickerDir, `picker-${pickerId}.ps1`);
  const resultPath = getPickerResultPath(pickerId);
  const script = `
param([string]$ResultPath)
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $owner.StartPosition = 'CenterScreen'
  $owner.Size = New-Object System.Drawing.Size(1, 1)
  $owner.ShowInTaskbar = $false
  $owner.Opacity = 0
  $owner.Show()
  $owner.Activate()
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = '请选择坚果云图纸审批根目录'
  $dialog.ShowNewFolderButton = $true
  $dialog.RootFolder = [System.Environment+SpecialFolder]::Desktop
  $result = $dialog.ShowDialog($owner)
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
    Set-Content -LiteralPath $ResultPath -Value ("SELECTED|" + $dialog.SelectedPath) -Encoding UTF8
  } else {
    Set-Content -LiteralPath $ResultPath -Value "CANCELLED|" -Encoding UTF8
  }
  $owner.Close()
} catch {
  Set-Content -LiteralPath $ResultPath -Value ("ERROR|" + ($_ | Out-String)) -Encoding UTF8
}
`;

  await fs.writeFile(scriptPath, script, "utf8");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-ResultPath", resultPath],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    }
  );
  child.unref();

  return { pickerId };
}

export async function pollFolderPicker(pickerId: string): Promise<FolderPickerPollResult> {
  const resultPath = getPickerResultPath(pickerId);
  let content: string;
  try {
    content = await fs.readFile(resultPath, "utf8");
  } catch {
    return { status: "pending" };
  }

  const normalized = content.replace(/^\uFEFF/, "").trim();
  const separator = normalized.indexOf("|");
  const status = separator >= 0 ? normalized.slice(0, separator) : normalized;
  const value = separator >= 0 ? normalized.slice(separator + 1) : "";

  if (status === "SELECTED" && value) return { status: "selected", path: value };
  if (status === "CANCELLED") return { status: "cancelled" };
  if (status === "ERROR") return { status: "error", message: value || "Folder picker failed" };
  return { status: "pending" };
}

function getPickerResultPath(pickerId: string) {
  return path.join(pickerDir, `picker-${pickerId}.txt`);
}
