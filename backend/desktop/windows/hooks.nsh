!macro NSIS_HOOK_PREUNINSTALL
  Delete "$APPDATA\Microsoft\Windows\SendTo\* (RClone Manager).lnk"
  Delete "$APPDATA\Microsoft\Windows\SendTo\* (RClone Manager Headless).lnk"
  DeleteRegKey HKCU "Software\Classes\*\shell\RCloneManager"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\RCloneManager"
  DeleteRegKey HKCU "Software\Classes\*\shell\RCloneManagerHeadless"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\RCloneManagerHeadless"
!macroend
