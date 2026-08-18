; NSIS installer hook — runs at the very start of .onInit, before file-lock checks.
; Kills any running SootheVoice instance so the "close it manually" retry loop never appears.
; The target filename tracks electron-builder.js's productName (SootheVoice — Ticket 32),
; since electron-builder names the packaged exe "<productName>.exe" by default.
!macro preInit
  nsExec::ExecToLog '"$WINDIR\System32\taskkill.exe" /F /IM SootheVoice.exe /T'
  Sleep 1000
!macroend

; Secondary kill inside the install section (belt-and-suspenders for slow machines).
!macro customInstall
  nsExec::ExecToLog '"$WINDIR\System32\taskkill.exe" /F /IM SootheVoice.exe /T'
  Sleep 500
!macroend
