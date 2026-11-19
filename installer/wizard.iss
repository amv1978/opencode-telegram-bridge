[Code]
var
  InstallModePage: TInputOptionWizardPage;
  ConfigPage: TInputQueryWizardPage;
  ModePage: TInputOptionWizardPage;

procedure InitializeWizard;
begin
  InstallModePage := CreateInputOptionPage(wpWelcome,
    CustomMessage('SetupModeTitle'), CustomMessage('SetupModeSubtitle'),
    CustomMessage('SetupModeDesc'),
    True, False);
  InstallModePage.Add(CustomMessage('SimpleLabel'));
  InstallModePage.Add(CustomMessage('AdvancedLabel'));
  InstallModePage.Values[0] := True;

  ConfigPage := CreateInputQueryPage(InstallModePage.ID,
    CustomMessage('TelegramTitle'), CustomMessage('TelegramSubtitle'),
    CustomMessage('TelegramDesc'));
  ConfigPage.Add(CustomMessage('TokenLabel'), False);
  ConfigPage.Add(CustomMessage('DirLabel'), False);
  ConfigPage.Values[1] := ExpandConstant('{userdocs}');

  ModePage := CreateInputOptionPage(ConfigPage.ID,
    CustomMessage('ModeTitle'), CustomMessage('ModeSubtitle'),
    CustomMessage('ModeDesc'), True, False);
  ModePage.Add(CustomMessage('ModeBoth'));
  ModePage.Add(CustomMessage('ModePrivate'));
  ModePage.Add(CustomMessage('ModeTopics'));
  ModePage.Values[0] := True;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if (PageID = ConfigPage.ID) or (PageID = ModePage.ID) then
    Result := not InstallModePage.Values[1];
end;

function JsonEscape(const S: String): String;
begin
  Result := S;
  StringChangeEx(Result, '\', '\\', True);
  StringChangeEx(Result, '"', '\"', True);
end;

procedure WriteConfig;
var
  Token, Dir, Mode, Lang, Json, Path: String;
begin
  Lang := 'en';
  if ActiveLanguage = 'russian' then Lang := 'ru';
  Path := ExpandConstant('{userappdata}\opencode-telegram-bridge\config.json');
  ForceDirectories(ExpandConstant('{userappdata}\opencode-telegram-bridge'));

  if not InstallModePage.Values[1] then
  begin
    // Simple install: remember only the language, never touch an existing config.
    if FileExists(Path) then exit;
    Json := '{' + #13#10 + '  "ui": { "lang": "' + Lang + '" }' + #13#10 + '}' + #13#10;
    SaveStringToFile(Path, Json, False);
    exit;
  end;

  Token := Trim(ConfigPage.Values[0]);
  Dir := Trim(ConfigPage.Values[1]);
  if ModePage.Values[0] then Mode := 'both'
  else if ModePage.Values[1] then Mode := 'private'
  else Mode := 'topics';

  Json := '{' + #13#10 +
    '  "telegram": { "token": "' + JsonEscape(Token) + '", "allowedUsers": [] },' + #13#10 +
    '  "mode": "' + Mode + '",' + #13#10 +
    '  "defaultDirectory": "' + JsonEscape(Dir) + '",' + #13#10 +
    '  "ui": { "lang": "' + Lang + '" },' + #13#10 +
    '  "web": { "port": 7788 }' + #13#10 +
    '}' + #13#10;
  SaveStringToFile(Path, Json, False);
end;

procedure KillRunning;
var
  ResultCode: Integer;
begin
  Exec('powershell',
    '-NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like ''*OpenCodeTelegramBridge*'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(1200);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
    KillRunning;
  if CurStep = ssPostInstall then
    WriteConfig;
end;
