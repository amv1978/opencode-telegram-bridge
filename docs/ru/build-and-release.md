[English](../build-and-release.md) · [Русский](build-and-release.md)

# Сборка и релиз

## Что нужно

- Bun 1.3+ (сборка демона и компиляция exe);
- Node.js 20+ и npm (Electron-оболочка);
- .NET SDK 10 (CLI);
- Inno Setup 6 (`winget install JRSoftware.InnoSetup`; `ISCC.exe` появляется в
  `%LOCALAPPDATA%\Programs\Inno Setup 6\`);
- `ffmpeg.exe` — не в репозитории, положить в `dist\`.

`scripts/build-release.ps1` выполняет все шаги ниже и создаёт релизные файлы.

## 1. Демон

```bash
bun install
bun run typecheck
bun run build                 # dist\ocbridge.exe
```

`bun run build` = `bun build src/index.ts --compile --outfile dist/ocbridge.exe`.
Кросс-сборки: `bun run build:linux`, `bun run build:mac` (без `.exe`).

Скопируйте `ffmpeg.exe` в `dist\ffmpeg.exe` — его берут bundle и оба установщика,
а демон ищет его рядом с собой.

## 2. CLI

```powershell
cd cli
dotnet publish -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -o ..\dist\cli
```

Результат: `dist\cli\ocbridge-cli.exe`, single-file, ~74 МБ. В bundle он лежит в
корне как `ocbridge-cli.exe`.

## 3. Electron-оболочка

```powershell
cd desktop
npm install
npm run pack                  # electron-builder --win --dir
```

Результат: `desktop\release\win-unpacked\` (~357 МБ) с `OpenCode Bridge.exe`.
Только target `dir` — отдельный portable Electron exe не собирается.

## 4. Portable bundle

`scripts/build-release.ps1` готовит `dist\bundle\` и упаковывает:

```
ocbridge-bundle-0.6.1.zip
  ocbridge.exe
  ffmpeg.exe
  ocbridge-cli.exe
  desktop\            (весь win-unpacked)
  version.json        version, builtAt, files[{path,size}]
  CHANGELOG.md
  README.md
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1
```

Скрипт пишет `dist\ocbridge-bundle-<ver>.zip.sha256`. `version.json` также
копируется в `dist\version.json` для полного установщика.

## 5. Установщики

Два скрипта Inno Setup используют общие `messages.iss` и `wizard.iss`:

| Скрипт | Результат | Размер | Содержимое |
|---|---|---|---|
| `installer\ocbridge.iss` | `dist\ocbridge-setup-standalone-<ver>.exe` | ~180 МБ | полная офлайн-установка |
| `installer\ocbridge-lite.iss` | `dist\ocbridge-setup-lite-<ver>.exe` | ~3–5 МБ | скачивает bundle |

```powershell
$iscc = "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
& $iscc "/DAppVersion=0.6.1" installer\ocbridge.iss
$sha = (Get-FileHash dist\ocbridge-bundle-0.6.1.zip -Algorithm SHA256).Hash.ToLower()
& $iscc "/DAppVersion=0.6.1" "/DBundleSha=$sha" installer\ocbridge-lite.iss
```

Lite-установщик показывает страницу загрузки с прогрессом, проверяет SHA256
(`DownloadPage.Add(..., BundleSha)`), распаковывает zip в `{app}`, создаёт
ярлыки/автозапуск и запускает приложение. При ошибке сети/404/хеша предлагает
открыть страницу релиза ради полного установщика.

Оба установщика:

- не перезаписывают `config.json`; пишут `installer.json` с типом установки,
  каталогом, флагом автозапуска и разовыми переопределениями конфига, которые
  приложение применяет при следующем старте;
- предзаполняют мастер из `%APPDATA%\opencode-telegram-bridge\config.json`
  (режим, папка проектов, `topicsChatId`; токен замаскирован, пусто = оставить)
  и из прошлого `installer.json`;
- завершают процессы с `*OpenCodeTelegramBridge*` в пути перед установкой; при
  удалении `%APPDATA%\opencode-telegram-bridge\` сохраняется.

## 6. Контрольные суммы и артефакты

```powershell
Get-ChildItem dist\ocbridge-*0.6.1* | Select-Object Name,Length
```

В релиз загружаются три бинарника и три суммы:

```
ocbridge-setup-standalone-0.6.1.exe
ocbridge-setup-standalone-0.6.1.exe.sha256
ocbridge-setup-lite-0.6.1.exe
ocbridge-setup-lite-0.6.1.exe.sha256
ocbridge-bundle-0.6.1.zip
ocbridge-bundle-0.6.1.zip.sha256
```

Формат `sha256sum`: hex в нижнем регистре, два пробела, имя файла.

## 7. Версии: пять мест

| Файл | Поле |
|---|---|
| `package.json` | `"version"` |
| `desktop/package.json` | `"version"` |
| `installer/ocbridge.iss` | `#define AppVersion "0.6.1"` |
| `installer/ocbridge-lite.iss` | `#define AppVersion "0.6.1"` |
| `cli/cli.csproj` | `Version`, `FileVersion`, `AssemblyVersion`, `InformationalVersion` |

Дополнительно: `cli/Program.cs`, константа `Program.Version` — её печатает
`ocbridge-cli version`; держите равной версии csproj. Версия API берётся из
`package.json` автоматически.

После смены версии пересоберите **все** артефакты — иначе старый exe внутри
нового bundle/установщика всё ещё сообщает прошлую версию.

## Чек-лист релиза

1. Поднять версию в пяти местах (+ `Program.cs`).
2. `bunx tsc --noEmit` и `bun run src/doctor.ts`.
3. `powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1`.
4. Проверить layout bundle (`version.json` со списком файлов,
   `desktop\OpenCode Bridge.exe`).
5. Установить полный и lite setup на чистой машине: окно, трей, `/start`, тема,
   голос.
6. Убедиться, что в git нет `config.json`, `state.json`, `installer.json`,
   `*.log`, `dist/`, `*.exe`.
7. Поставить тег `v0.6.1` и загрузить все шесть файлов.
8. Удалить устаревшие релизы.

## Подпись кода

Бинарники пока без подписи: SmartScreen показывает «Unknown publisher». С
сертификатом подпишите `ocbridge.exe`, `ocbridge-cli.exe` и
`OpenCode Bridge.exe`, затем установщики:

```powershell
signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /a <file>
```

Подпись установщика после сборки не меняет содержимое, но меняет хеш —
пересчитайте контрольные суммы. CI нет: сборка ручная, на Windows.
