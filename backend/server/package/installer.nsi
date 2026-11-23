; The server's Windows setup, for the current user. It replaces an installation of
; the RClone Manager Headless app (0.3.6 and older), which shares its settings. The
; MSI, for all users, is built from nfpm.yaml. release-headless.yml builds it with:
;   makensis /DVERSION=<version> /DBINARY=<rclone-manager-server.exe> /DOUTFILE=<setup.exe> installer.nsi
; /P runs it without questions and /R then starts the app; the in-app and Tauri
; updaters pass both. Tauri's also passes /UPDATE and /ARGS, which change nothing.
Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!include MUI2.nsh
!include FileFunc.nsh
!include LogicLib.nsh

!define PRODUCTNAME "RClone Manager Server"
!define MANUFACTURER "Zarestia Dev"
!define EXE "rclone-manager-server.exe"
!define LEGACYNAME "RClone Manager Headless"
!define LEGACYEXE "rclone-manager-headless.exe"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUPRODUCTKEY "Software\${MANUFACTURER}\${PRODUCTNAME}"
!define ICONS "..\..\desktop\icons"

Name "${PRODUCTNAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\${PRODUCTNAME}"
InstallDirRegKey HKCU "${MANUPRODUCTKEY}" ""

!define MUI_ICON "${ICONS}\icon.ico"
!define MUI_UNICON "${ICONS}\icon.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "${ICONS}\nsis-header.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${ICONS}\nsis-sidebar.bmp"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"

Var Passive

!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; An updater starts this setup and then quits: wait for that, then ask.
!macro WAIT_FOR_APP EXECUTABLE NAME
  StrCpy $1 0
  ${DoWhile} ${FileExists} "${EXECUTABLE}"
    ClearErrors
    FileOpen $0 "${EXECUTABLE}" a
    ${IfNot} ${Errors}
      FileClose $0
      ${Break}
    ${EndIf}
    IntOp $1 $1 + 1
    ${If} $1 > 60
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Quit ${NAME} from its tray icon, then retry." IDRETRY +2
      Abort
      StrCpy $1 0
    ${EndIf}
    Sleep 500
  ${Loop}
!macroend

Function .onInit
  ClearErrors
  ${GetOptions} $CMDLINE "/P" $0
  ${IfNot} ${Errors}
    StrCpy $Passive 1
  ${EndIf}
FunctionEnd

Function SkipIfPassive
  ${IfThen} $Passive = 1 ${|} Abort ${|}
FunctionEnd

; The RClone Manager Headless app recorded its folder where this setup records its
; own. Its files, shortcuts, start-at-login entry and uninstall entry go; its
; settings in %APPDATA%\com.rclone.manager.headless stay, because this app uses them.
; The app moves the file manager entries to its own name when it starts.
Function RemoveLegacyInstallation
  ReadRegStr $R0 HKCU "Software\${MANUFACTURER}\${LEGACYNAME}" ""
  ${If} $R0 == ""
    Return
  ${EndIf}
  !insertmacro WAIT_FOR_APP "$R0\${LEGACYEXE}" "${LEGACYNAME}"
  Delete "$R0\${LEGACYEXE}"
  Delete "$R0\uninstall.exe"
  RMDir "$R0"
  Delete "$SMPROGRAMS\${LEGACYNAME}\${LEGACYNAME}.lnk"
  RMDir "$SMPROGRAMS\${LEGACYNAME}"
  Delete "$DESKTOP\${LEGACYNAME}.lnk"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${LEGACYNAME}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${LEGACYNAME}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${LEGACYNAME}"
  DeleteRegKey HKCU "Software\${MANUFACTURER}\${LEGACYNAME}"
FunctionEnd

Section
  ${IfThen} $Passive = 1 ${|} SetAutoClose true ${|}
  !insertmacro WAIT_FOR_APP "$INSTDIR\${EXE}" "${PRODUCTNAME}"
  Call RemoveLegacyInstallation
  SetOutPath "$INSTDIR"
  File "/oname=${EXE}" "${BINARY}"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateDirectory "$SMPROGRAMS\${PRODUCTNAME}"
  CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}\${PRODUCTNAME}.lnk" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${MANUPRODUCTKEY}" "" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" '"$INSTDIR\${EXE}"'
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" '"$INSTDIR"'
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" $0
SectionEnd

Function .onInstSuccess
  ${If} $Passive = 1
    ClearErrors
    ${GetOptions} $CMDLINE "/R" $0
    ${IfNot} ${Errors}
      Exec '"$INSTDIR\${EXE}"'
    ${EndIf}
  ${EndIf}
FunctionEnd

Section Uninstall
  !insertmacro WAIT_FOR_APP "$INSTDIR\${EXE}" "${PRODUCTNAME}"
  Delete "$INSTDIR\${EXE}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${PRODUCTNAME}\${PRODUCTNAME}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCTNAME}"
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  ; What the app registered: start at login, Send To and the Explorer menu.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${PRODUCTNAME}"
  Delete "$APPDATA\Microsoft\Windows\SendTo\* (${PRODUCTNAME}).lnk"
  Delete "$APPDATA\Microsoft\Windows\SendTo\* (${LEGACYNAME}).lnk"
  DeleteRegKey HKCU "Software\Classes\*\shell\RCloneManagerHeadless"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\RCloneManagerHeadless"
  DeleteRegKey HKCU "${UNINSTKEY}"
  DeleteRegKey HKCU "${MANUPRODUCTKEY}"
  DeleteRegKey /ifempty HKCU "Software\${MANUFACTURER}"
SectionEnd
