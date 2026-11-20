[English](../build-and-release.md) · [Русский](build-and-release.md)

# Сборка и релиз

## Что нужно

- Bun 1.3+ (сборка демона и компиляция в exe);
- Node.js 20+ и npm (Electron-оболочка);
- .NET SDK 10 (CLI);
- Inno Setup 6 (установщик);
- `ffmpeg.exe` — в репозиторий не входит, положите его в `dist\`.

## 1. Демон

```bash
bun install
bun run typecheck
bun run build                 # dist\ocbridge.exe
```

`bun run build` = `bun build src/index.ts --compile --outfile dist/ocbridge.exe`.
Кросс-сборка: `bun run build:linux`, `bun run build:mac` (артефакты без `.exe`).

Скопируйте `ffmpeg.exe` в `dist\ffmpeg.exe` — установщик берёт его оттуда,
а демон ищет рядом с собой.

## 2. CLI

```powershell
cd cli
dotnet publish -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -o ..\dist\cli
```

Результат: `dist\cli\ocbridge-cli.exe`, single-file, ~74 МБ.

## 3. Electron-оболочка

```powershell
cd desktop
npm install
npm run pack                  # electron-builder --win --dir
```

Результат: `desktop\release\win-unpacked\` (~357 МБ), внутри `OpenCode Bridge.exe`.
Target только `dir` — отдельный portable-exe Electron не собирается.

## 4. Установщик

```powershell
winget install JRSoftware.InnoSetup
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\ocbridge.iss
```

Выход: `dist\ocbridge-setup-<version>.exe`, сжатие lzma2, итог ~180 МБ.

Состав:

| Что | Откуда | Размер |
|---|---|---|
| `ocbridge.exe` | `dist\` | ~115 МБ |
| `ffmpeg.exe` | `dist\` | ~83 МБ |
| `ocbridge-cli.exe` | `dist\cli\` (если есть) | ~74 МБ |
| `desktop\*` | `desktop\release\win-unpacked\` | ~357 МБ |
| `README.md`, `INSTALL.txt` | корень / `docs\` | мало |

Установщик: простой режим пишет только `ui.lang` (существующий конфиг не трогает),
расширенный — токен, режим, папку. Перед установкой процессы с путём
`*OpenCodeTelegramBridge*` завершаются. Ярлыки: приложение, CLI, удаление,
опционально рабочий стол. Автозапуск — задача установщика.
При удалении `%APPDATA%\opencode-telegram-bridge\` сохраняется.

## 5. Версии: четыре места

| Файл | Поле |
|---|---|
| `package.json` | `"version"` |
| `desktop/package.json` | `"version"` |
| `installer/ocbridge.iss` | `#define AppVersion "0.3.0"` |
| `cli/cli.csproj` | `Version`, `FileVersion`, `AssemblyVersion`, `InformationalVersion` |

Дополнительно: `cli/Program.cs`, константа `Program.Version` — её печатает
`ocbridge-cli version`; держите равной версии csproj. Версия API берётся из
`package.json` автоматически.

Имя установщика формируется из `AppVersion`: `ocbridge-setup-0.3.0.exe`.
После смены версии пересоберите **все** артефакты — старый exe внутри нового
установщика иначе покажет прежнюю версию.

## Чек-лист релиза

1. Поднять версию в четырёх местах (+ `Program.cs`).
2. `bun run typecheck` и `bun run src/doctor.ts`.
3. Пересобрать демон, CLI, оболочку, установщик.
4. Запустить установщик на чистой машине: окно, трей, `/start`, тема, голос.
5. Проверить, что в git нет `config.json`, `state.json`, `*.log`, `dist/`, `*.exe`.
6. Тег `v0.3.0`, к релизу приложить `ocbridge-setup-0.3.0.exe` и исходники.

## Подпись кода

Сейчас binaries не подписаны: SmartScreen покажет предупреждение «Неизвестный издатель».
При наличии сертификата подпишите сначала `ocbridge.exe`, `ocbridge-cli.exe` и
`OpenCode Bridge.exe`, затем сам установщик:

```powershell
signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /a <файл>
```

Подпись установщика после сборки не меняет его содержимое, но меняет хеш —
пересчитывайте контрольные суммы после подписи. CI и workflows в репозитории нет:
сборка ручная, на Windows.
