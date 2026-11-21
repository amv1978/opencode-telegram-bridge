[Code]
var
  InstallModePage: TInputOptionWizardPage;
  ConfigPage: TInputQueryWizardPage;
  ModePage: TInputOptionWizardPage;
  SavedConfig: String;
  SavedToken: String;
  SavedTokenMask: String;

function ConfigPath: String;
begin
  Result := ExpandConstant('{userappdata}\opencode-telegram-bridge\config.json');
end;

function InstallerPath: String;
begin
  Result := ExpandConstant('{userappdata}\opencode-telegram-bridge\installer.json');
end;

function LoadTextFile(const Path: String): String;
var
  Raw: AnsiString;
begin
  Result := '';
  if not FileExists(Path) then exit;
  if LoadStringFromFile(Path, Raw) then
    Result := Utf8Decode(Raw);
end;

function JsonUnescape(const S: String): String;
begin
  Result := S;
  StringChangeEx(Result, '\\', '\', True);
  StringChangeEx(Result, '\"', '"', True);
  StringChangeEx(Result, '\n', #13#10, True);
  StringChangeEx(Result, '\r', '', True);
  StringChangeEx(Result, '\t', ' ', True);
end;

function LastPos(const Needle, Haystack: String): Integer;
var
  P, Q: Integer;
begin
  Result := 0;
  P := Pos(Needle, Haystack);
  while P > 0 do
  begin
    Result := P;
    Q := Pos(Needle, Copy(Haystack, P + 1, Length(Haystack)));
    if Q = 0 then break;
    P := P + Q;
  end;
end;

function JsonStringValueFrom(const Json, Key: String; StartAt: Integer): String;
var
  Tag, Rest: String;
  P, Q: Integer;
begin
  Result := '';
  if StartAt < 1 then StartAt := 1;
  Tag := '"' + Key + '"';
  P := Pos(Tag, Copy(Json, StartAt, Length(Json)));
  if P = 0 then exit;
  Rest := Copy(Json, StartAt + P + Length(Tag) - 1, Length(Json));
  P := Pos(':', Rest);
  if P = 0 then exit;
  Rest := TrimLeft(Copy(Rest, P + 1, Length(Rest)));
  if (Length(Rest) = 0) or (Rest[1] <> '"') then exit;
  Rest := Copy(Rest, 2, Length(Rest));
  Q := Pos('"', Rest);
  if Q = 0 then exit;
  Result := JsonUnescape(Copy(Rest, 1, Q - 1));
end;

function JsonStringValue(const Json, Key: String): String;
begin
  Result := JsonStringValueFrom(Json, Key, 1);
end;

function JsonStringValueLast(const Json, Key: String): String;
begin
  Result := JsonStringValueFrom(Json, Key, LastPos('"' + Key + '"', Json));
end;

function JsonNumberValue(const Json, Key: String): Int64;
var
  Tag, Rest, Digits: String;
  P, Q: Integer;
begin
  Result := 0;
  Tag := '"' + Key + '"';
  P := Pos(Tag, Json);
  if P = 0 then exit;
  Rest := Copy(Json, P + Length(Tag), Length(Json));
  P := Pos(':', Rest);
  if P = 0 then exit;
  Rest := TrimLeft(Copy(Rest, P + 1, Length(Rest)));
  Q := 1;
  while (Q <= Length(Rest)) and
        (((Rest[Q] >= '0') and (Rest[Q] <= '9')) or (Rest[Q] = '-')) do
    Q := Q + 1;
  Digits := Copy(Rest, 1, Q - 1);
  if Digits = '' then exit;
  Result := StrToInt64Def(Digits, 0);
end;

procedure InitializeWizard;
var
  Previous: String;
  Dir, Mode, Topics: String;
begin
  SavedConfig := LoadTextFile(ConfigPath);
  Previous := LoadTextFile(InstallerPath);

  // `discord` also has token/mode: read the Telegram token after "telegram" and
  // take the last root-level "mode", never the Discord thread mode.
  SavedToken := JsonStringValueFrom(SavedConfig, 'token', Pos('"telegram"', SavedConfig));
  SavedTokenMask := '';
  if Length(SavedToken) > 4 then
    SavedTokenMask := '****' + Copy(SavedToken, Length(SavedToken) - 3, 4);

  InstallModePage := CreateInputOptionPage(wpWelcome,
    CustomMessage('SetupModeTitle'), CustomMessage('SetupModeSubtitle'),
    CustomMessage('SetupModeDesc'),
    True, False);
  InstallModePage.Add(CustomMessage('SimpleLabel'));
  InstallModePage.Add(CustomMessage('AdvancedLabel'));
  InstallModePage.Values[0] := True;
  if JsonStringValue(Previous, 'installKind') = 'advanced' then
    InstallModePage.Values[1] := True;

  ConfigPage := CreateInputQueryPage(InstallModePage.ID,
    CustomMessage('TelegramTitle'), CustomMessage('TelegramSubtitle'),
    CustomMessage('TelegramDesc'));
  ConfigPage.Add(CustomMessage('TokenLabel'), False);
  ConfigPage.Add(CustomMessage('DirLabel'), False);
  ConfigPage.Add(CustomMessage('TopicsLabel'), False);

  Dir := JsonStringValue(SavedConfig, 'defaultDirectory');
  if Dir = '' then
    Dir := JsonStringValue(Previous, 'directory');
  if Dir = '' then
    Dir := ExpandConstant('{userdocs}');
  ConfigPage.Values[1] := Dir;

  Topics := '';
  if JsonNumberValue(SavedConfig, 'topicsChatId') <> 0 then
    Topics := IntToStr(JsonNumberValue(SavedConfig, 'topicsChatId'));
  ConfigPage.Values[2] := Topics;

  ConfigPage.Values[0] := SavedTokenMask;
  if SavedTokenMask <> '' then
    ConfigPage.Edits[0].Text := SavedTokenMask;

  ModePage := CreateInputOptionPage(ConfigPage.ID,
    CustomMessage('ModeTitle'), CustomMessage('ModeSubtitle'),
    CustomMessage('ModeDesc'), True, False);
  ModePage.Add(CustomMessage('ModeBoth'));
  ModePage.Add(CustomMessage('ModePrivate'));
  ModePage.Add(CustomMessage('ModeTopics'));
  ModePage.Values[0] := True;
  Mode := JsonStringValueLast(SavedConfig, 'mode');
  if Mode = 'private' then
    ModePage.Values[1] := True
  else if Mode = 'topics' then
    ModePage.Values[2] := True;

  // Remember the previous install directory, but never override an explicit /DIR.
  Dir := JsonStringValue(Previous, 'directory');
  if (Dir <> '') and
     (CompareText(WizardForm.DirEdit.Text, ExpandConstant('{autopf}\OpenCodeTelegramBridge')) = 0) then
    WizardForm.DirEdit.Text := Dir;
  if Pos('"autostart": true', Previous) > 0 then
    WizardSelectTasks('autostart');

  #ifdef LITE
  InitLiteDownloadPage;
  #endif
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

procedure WriteInstallerJson;
var
  Token, Dir, Mode, Lang, Json: String;
  Topics: Int64;
begin
  Lang := 'en';
  if ActiveLanguage = 'russian' then Lang := 'ru';

  Json := '{' + #13#10 +
    '  "version": "' + '{#AppVersion}' + '",' + #13#10 +
    '  "installKind": "';

  if InstallModePage.Values[1] then
    Json := Json + 'advanced",' + #13#10
  else
    Json := Json + 'simple",' + #13#10;

  Json := Json + '  "directory": "' + JsonEscape(ExpandConstant('{app}')) + '",' + #13#10 +
    '  "autostart": ';
  if WizardIsTaskSelected('autostart') then
    Json := Json + 'true,' + #13#10
  else
    Json := Json + 'false,' + #13#10;
  Json := Json + '  "writtenAt": "' + GetDateTimeString('yyyy-mm-dd hh:nn:ss', '-', ':') + '",' + #13#10;

  if not InstallModePage.Values[1] then
  begin
    Json := Json +
      '  "configOnlyIfNew": true,' + #13#10 +
      '  "config": { "lang": "' + Lang + '" }' + #13#10 +
      '}' + #13#10;
  end
  else
  begin
    Token := Trim(ConfigPage.Values[0]);
    if (Token = SavedTokenMask) or (Token = '') then
      Token := '';
    Dir := Trim(ConfigPage.Values[1]);
    if ModePage.Values[0] then Mode := 'both'
    else if ModePage.Values[1] then Mode := 'private'
    else Mode := 'topics';
    Topics := StrToInt64Def(Trim(ConfigPage.Values[2]), 0);

    Json := Json + '  "config": {' + #13#10;
    if Token <> '' then
      Json := Json + '    "telegramToken": "' + JsonEscape(Token) + '",' + #13#10;
    Json := Json +
      '    "mode": "' + Mode + '",' + #13#10 +
      '    "defaultDirectory": "' + JsonEscape(Dir) + '"';
    // Never override an existing interface language just because the installer
    // ran in another language; only a brand-new config gets the chosen one.
    if (SavedConfig = '') or (JsonStringValue(SavedConfig, 'lang') = '') then
      Json := Json + ',' + #13#10 + '    "lang": "' + Lang + '"';
    if Topics <> 0 then
      Json := Json + ',' + #13#10 + '    "topicsChatId": ' + IntToStr(Topics);
    Json := Json + #13#10 + '  }' + #13#10 + '}' + #13#10;
  end;

  ForceDirectories(ExpandConstant('{userappdata}\opencode-telegram-bridge'));
  SaveStringToFile(InstallerPath, Json, False);
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
  begin
    WriteInstallerJson;
    #ifdef LITE
    ExtractBundle;
    #endif
  end;
end;
