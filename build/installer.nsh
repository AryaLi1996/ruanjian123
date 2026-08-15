; NSIS installer hook — runs at the very start of .onInit, before file-lock checks.
; Kills any running ruanjian instance so the "close it manually" retry loop never appears.
!macro preInit
  nsExec::ExecToLog '"$WINDIR\System32\taskkill.exe" /F /IM ruanjian.exe /T'
  Sleep 1000
!macroend

; Secondary kill inside the install section (belt-and-suspenders for slow machines).
!macro customInstall
  nsExec::ExecToLog '"$WINDIR\System32\taskkill.exe" /F /IM ruanjian.exe /T'
  Sleep 500
!macroend
