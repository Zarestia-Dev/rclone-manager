!macro NSIS_HOOK_PREUNINSTALL
  Delete "$APPDATA\Microsoft\Windows\SendTo\* (RClone Manager).lnk"
!macroend
