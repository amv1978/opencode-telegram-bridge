; Lite installer: downloads the portable bundle from the matching GitHub tag,
; verifies SHA256, extracts it and creates shortcuts. Shortcuts point into the
; extracted desktop\ folder.
; Build: ISCC.exe /DBundleSha=<sha256> installer\ocbridge-lite.iss

#ifndef BundleSha
  #error BundleSha is required: pass /DBundleSha=<sha256>
#endif
#if BundleSha == ""
  #error BundleSha must not be empty
#endif

[Code]
var
  DownloadPage: TDownloadWizardPage;

procedure InitLiteDownloadPage;
begin
  DownloadPage := CreateDownloadPage(
    CustomMessage('LiteDownloadTitle'),
    CustomMessage('LiteDownloadDesc'),
    nil);
  DownloadPage.ShowBaseNameInsteadOfUrl := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Error: String;
  ResultCode: Integer;
begin
  Result := True;
  if CurPageID <> wpReady then exit;

  DownloadPage.Clear;
  DownloadPage.Add(
    'https://github.com/amv1978/opencode-telegram-bridge/releases/download/v{#AppVersion}/ocbridge-bundle-{#AppVersion}.zip',
    'ocbridge-bundle-{#AppVersion}.zip',
    '{#BundleSha}');
  DownloadPage.Show;
  try
    try
      DownloadPage.Download;
    except
      if DownloadPage.AbortedByUser then
        Log('Download aborted by user.')
      else
      begin
        Error := Format('%s: %s', [DownloadPage.LastBaseNameOrUrl, GetExceptionMessage]);
        Log(Error);
        if MsgBox(CustomMessage('LiteDownloadFailed'), mbError, MB_YESNO) = IDYES then
          ShellExec('open',
            'https://github.com/amv1978/opencode-telegram-bridge/releases/tag/v{#AppVersion}',
            '', '', SW_SHOWNORMAL, ewNoWait, ResultCode);
      end;
      Result := False;
    end;
  finally
    DownloadPage.Hide;
  end;
end;

procedure ExtractBundle;
var
  Zip, Command: String;
  ResultCode: Integer;
begin
  Zip := ExpandConstant('{tmp}\ocbridge-bundle-{#AppVersion}.zip');
  if not FileExists(Zip) then
  begin
    MsgBox(CustomMessage('LiteMissingBundle'), mbError, MB_OK);
    exit;
  end;
  Command := '-NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath ''' +
    Zip + ''' -DestinationPath ''' + ExpandConstant('{app}') + ''' -Force"';
  if (not Exec('powershell', Command, '', SW_HIDE, ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
    MsgBox(CustomMessage('LiteExtractFailed'), mbError, MB_OK);
end;
