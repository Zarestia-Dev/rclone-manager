!macro NSIS_HOOK_PREUNINSTALL
  Delete "$APPDATA\Microsoft\Windows\SendTo\* (RClone Manager).lnk"
  DeleteRegKey HKCU "Software\Classes\*\shell\RCloneManager"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\RCloneManager"
!macroend
