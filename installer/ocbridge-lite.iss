; Inno Setup script for the "lite" OpenCode Telegram Bridge installer.
; It downloads ocbridge-bundle-<version>.zip from the matching GitHub tag,
; verifies SHA256 and extracts the portable layout.
; Build: ISCC.exe /DBundleSha=<sha256> installer\ocbridge-lite.iss
; Produces: dist\ocbridge-setup-lite-<version>.exe

#define AppName "OpenCode Telegram Bridge"
#ifndef AppVersion
  #define AppVersion "0.6.0"
#endif
#define AppExe "ocbridge.exe"
#define LITE

[Setup]
AppId={{7C4E2B0F-6C1E-4C63-9C2A-91C1D8B7A001}
AppName={#AppName}
AppVersion={#AppVersion}
VersionInfoVersion={#AppVersion}
VersionInfoProductVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} Lite Setup
CloseApplications=force
RestartApplications=no
DefaultDirName={autopf}\OpenCodeTelegramBridge
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=ocbridge-setup-lite-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\desktop\OpenCode Bridge.exe
SetupIconFile=icon.ico
InfoAfterFile=..\docs\INSTALL.txt
MinVersion=10.0
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "{cm:TaskAutostart}"; GroupDescription: "{cm:AutostartGroup}"; Flags: checkedonce
Name: "desktopicon"; Description: "{cm:TaskDesktopIcon}"; GroupDescription: "Дополнительно:"

[Dirs]
Name: "{app}"; Permissions: users-modify

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\desktop\OpenCode Bridge.exe"; WorkingDir: "{app}"
Name: "{group}\{#AppName} (CLI)"; Filename: "{cmd}"; Parameters: "/k ""{app}\ocbridge-cli.exe"" help"; WorkingDir: "{app}"
Name: "{group}\{cm:UninstallShortcut}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\desktop\OpenCode Bridge.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; \
  ValueName: "OpenCodeTelegramBridge"; ValueData: """{app}\desktop\OpenCode Bridge.exe"" --hidden"; \
  Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\desktop\OpenCode Bridge.exe"; Description: "{cm:RunApp}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "taskkill"; Parameters: "/IM ""OpenCode Bridge.exe"" /F"; Flags: runhidden; RunOnceId: "KillDesktop"
Filename: "taskkill"; Parameters: "/IM ocbridge.exe /F"; Flags: runhidden; RunOnceId: "KillBridge"

[UninstallDelete]
Type: files; Name: "{app}\ocbridge.exe"
Type: files; Name: "{app}\ffmpeg.exe"
Type: files; Name: "{app}\ocbridge-cli.exe"
Type: files; Name: "{app}\version.json"
Type: files; Name: "{app}\CHANGELOG.md"
Type: files; Name: "{app}\README.md"
Type: filesandordirs; Name: "{app}\desktop"
Type: filesandordirs; Name: "{app}\prev"
Type: filesandordirs; Name: "{app}\new"
Type: filesandordirs; Name: "{app}\failed"

#include "messages.iss"
#include "lite.iss"
#include "wizard.iss"
