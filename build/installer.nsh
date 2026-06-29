!include LogicLib.nsh

!macro _pdfApprovalFindAppProcess _RETURN
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$name='${PRODUCT_NAME}.exe'; $$p=Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.Name -ieq $$name }; if ($$p) { exit 0 } else { exit 1 }"`
  Pop ${_RETURN}
  Pop $0
!macroend

!macro _pdfApprovalStopAppProcess
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$name='${PRODUCT_NAME}.exe'; Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.Name -ieq $$name } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"`
  Pop $0
  Pop $1
!macroend

!macro _pdfApprovalRemoveInstallFilesPreservingState
  System::Call 'Kernel32::SetEnvironmentVariable(t, t) i("PDF_APPROVAL_INSTALL_DIR", "$INSTDIR").r0'
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$root=$$env:PDF_APPROVAL_INSTALL_DIR; $$keep=@('data','backups','logs','releases','server-config.json'); if ([string]::IsNullOrWhiteSpace($$root) -or -not (Test-Path -LiteralPath $$root)) { exit 0 }; Get-ChildItem -LiteralPath $$root -Force | Where-Object { $$keep -notcontains $$_.Name } | Remove-Item -Recurse -Force -ErrorAction Stop"`
  Pop $R0
  Pop $R1
  System::Call 'Kernel32::SetEnvironmentVariable(t, t) i("PDF_APPROVAL_INSTALL_DIR", "").r2'
  ${if} $R0 != 0
    DetailPrint "Failed to clean old application files: $R1"
    Abort "无法清理旧安装文件，请关闭服务端后重试。"
  ${endif}
!macroend

!macro customRemoveFiles
  SetOutPath $TEMP
  DetailPrint "保留审批数据、日志、备份和更新发布目录"
  !insertmacro _pdfApprovalRemoveInstallFilesPreservingState
!macroend

!macro customCheckAppRunning
  Var /GLOBAL PdfApprovalCloseAttempt
  StrCpy $PdfApprovalCloseAttempt 0

  pdfApprovalCheckLoop:
    !insertmacro _pdfApprovalFindAppProcess $R0
    ${if} $R0 != 0
      Goto pdfApprovalAppNotRunning
    ${endif}

    ${if} $PdfApprovalCloseAttempt == 0
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK pdfApprovalCloseProcess
      Quit
    ${endif}

    pdfApprovalCloseProcess:
      DetailPrint "$(appClosing)"
      !insertmacro _pdfApprovalStopAppProcess
      Sleep 1000
      IntOp $PdfApprovalCloseAttempt $PdfApprovalCloseAttempt + 1

      ${if} $PdfApprovalCloseAttempt > 2
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY pdfApprovalCheckLoop
        Quit
      ${endif}

      Goto pdfApprovalCheckLoop

  pdfApprovalAppNotRunning:
!macroend
