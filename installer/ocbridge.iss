; Inno Setup script for OpenCode Telegram Bridge.
; Build: ISCC.exe installer\ocbridge.iss
; Produces: dist\ocbridge-setup-standalone-<version>.exe

#define AppName "OpenCode Telegram Bridge"
#ifndef AppVersion
  #define AppVersion "0.8.2"
#endif
#define AppExe "ocbridge.exe"

[Setup]
AppId={{7C4E2B0F-6C1E-4C63-9C2A-91C1D8B7A001}
AppName={#AppName}
AppVersion={#AppVersion}
VersionInfoVersion={#AppVersion}
VersionInfoProductVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} Setup
CloseApplications=force
RestartApplications=no
DefaultDirName={autopf}\OpenCodeTelegramBridge
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=ocbridge-setup-standalone-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\desktop\OpenCode Bridge.exe
SetupIconFile=icon.ico
MinVersion=10.0
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UsePreviousLanguage=yes

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "{cm:TaskAutostart}"; GroupDescription: "{cm:AutostartGroup}"; Flags: checkedonce
Name: "desktopicon"; Description: "{cm:TaskDesktopIcon}"; GroupDescription: "{cm:DesktopIconGroup}"

[Files]
Source: "..\dist\ocbridge.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\ffmpeg.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\cli\ocbridge-cli.exe"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "..\desktop\release\win-unpacked\*"; DestDir: "{app}\desktop"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\CHANGELOG.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\version.json"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist

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
Type: files; Name: "{app}\bridge.log"
Type: filesandordirs; Name: "{app}\prev"
Type: filesandordirs; Name: "{app}\new"
Type: filesandordirs; Name: "{app}\failed"
#include "messages.iss"
#include "wizard.iss"
