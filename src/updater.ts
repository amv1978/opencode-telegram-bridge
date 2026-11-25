import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../package.json";
import { log } from "./log.ts";

export interface UpdateSettings {
  checkOnStart?: boolean;
  intervalHours?: number;
  autoDownload?: boolean;
}

export interface UpdateCache {
  current?: string;
  latest?: string;
  available?: boolean;
  assetUrl?: string;
  shaUrl?: string;
  notes?: string;
  publishedAt?: string;
  checkedAt?: number;
  /** True when the asset is the portable bundle, not an installer. */
  bundled?: boolean;
}

export interface UpdateSnapshot {
  available: boolean;
  current: string;
  latest: string;
  notes: string;
  progress: number;
  error: string;
  downloading: boolean;
  installing: boolean;
  assetUrl?: string;
  publishedAt?: string;
  /** Version currently kept in `{app}\prev`, if any. */
  prevVersion?: string;
  /** True when the update payload is a bundle zip. */
  bundled: boolean;
}

const REPO = "amv1978/opencode-telegram-bridge";
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const HEADERS = { accept: "application/vnd.github+json", "user-agent": "ocbridge-updater" };
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const HEALTH_TIMEOUT_SECONDS = 60;
const INSTALLED_ITEMS = ["ocbridge.exe", "ffmpeg.exe", "ocbridge-cli.exe", "desktop", "version.json", "CHANGELOG.md", "README.md"];

interface BundleMeta {
  version: string;
  sha256: string;
  downloadedAt: string;
}

/** Numeric semver comparison; a leading `v` and suffixes are ignored. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) =>
    value
      .replace(/^v/i, "")
      .split(/[+-]/)[0]!
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** GitHub auto-update over the portable bundle; never used in dev builds. */
export class Updater {
  private cache: UpdateCache = {};
  private progress = 0;
  private error = "";
  private downloading = false;
  private installing = false;
  private file?: string;
  private prevVersion?: string;

  constructor(
    private readonly options: {
      packaged: boolean;
      dataDir: string;
      /** Directory that contains ocbridge.exe / desktop\. Defaults to the exe dir. */
      installDir?: string;
      /** Test hook: pretend this version is running. */
      currentVersion?: string;
      /** Actually bound web UI port (the server may fall back from the config). */
      port?: () => number;
      onCache?: (cache: UpdateCache) => void;
      /** Called right before the swap helper starts; must persist state synchronously. */
      onBeforeInstall?: (previous: string, next: string) => void;
      /** Chat notification (used for the "restarting" message). */
      notify?: (text: string) => Promise<void> | void;
      exit?: (code: number) => void;
    },
  ) {}

  get current(): string {
    return this.options.currentVersion ?? pkg.version;
  }

  get appDir(): string {
    return this.options.installDir ?? dirname(process.execPath);
  }

  restore(cache: UpdateCache | undefined, prevVersion?: string): void {
    this.cache = cache ?? {};
    this.prevVersion = prevVersion;
  }

  snapshot(): UpdateSnapshot {
    return {
      available: Boolean(this.cache.available),
      current: this.current,
      latest: this.cache.latest ?? this.current,
      notes: this.cache.notes ?? "",
      progress: this.progress,
      error: this.error,
      downloading: this.downloading,
      installing: this.installing,
      assetUrl: this.cache.assetUrl,
      publishedAt: this.cache.publishedAt,
      prevVersion: this.prevVersion,
      bundled: this.cache.bundled !== false,
    };
  }

  /** GET the latest release and compare with the running version. */
  async check(): Promise<UpdateSnapshot> {
    try {
      const response = await fetch(RELEASE_API, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
      const release = (await response.json()) as {
        tag_name?: string;
        body?: string;
        published_at?: string;
        assets?: Array<{ name?: string; browser_download_url?: string }>;
      };
      const latest = String(release.tag_name ?? "").replace(/^v/i, "");
      if (!latest) throw new Error("release has no tag_name");
      const assets = release.assets ?? [];
      const asset = assets.find((item) => /^ocbridge-bundle-.*\.zip$/i.test(item.name ?? ""));
      const sha = asset ? assets.find((item) => item.name === `${asset.name}.sha256`) : undefined;
      this.cache = {
        current: this.current,
        latest,
        available: compareVersions(latest, this.current) > 0,
        assetUrl: asset?.browser_download_url,
        shaUrl: sha?.browser_download_url,
        notes: release.body ?? "",
        publishedAt: release.published_at ?? "",
        checkedAt: Date.now(),
        bundled: true,
      };
      this.error = "";
      this.options.onCache?.(this.cache);
      log.info(`update check: current=${this.current} latest=${latest} available=${this.cache.available}`);
      return this.snapshot();
    } catch (error) {
      this.error = (error as Error).message;
      log.warn("update check failed:", this.error);
      return this.snapshot();
    }
  }

  /** Stream the bundle to %TEMP%\ocbridge-update\bundle.zip with resume; verify SHA256. */
  async download(): Promise<UpdateSnapshot> {
    if (!this.options.packaged) {
      this.error = "автообновление доступно только для собранной версии";
      log.warn("update download skipped: dev build");
      return this.snapshot();
    }
    if (!this.cache.available || !this.cache.assetUrl) {
      this.error = "обновление не найдено";
      return this.snapshot();
    }
    if (this.downloading) return this.snapshot();

    this.downloading = true;
    this.progress = 0;
    this.error = "";
    try {
      const dir = updateDir();
      mkdirSync(dir, { recursive: true });
      const target = join(dir, "bundle.zip");
      const part = `${target}.part`;

      if (existsSync(target) && (await this.verifyFile(target))) {
        this.file = target;
        this.progress = 100;
        const sha = await fetchText(this.cache.shaUrl!);
        this.writeMeta(this.cache.latest ?? this.current, sha);
        log.info("update: already downloaded and verified");
        return this.snapshot();
      }

      const total = await contentLength(this.cache.assetUrl);
      const received = await this.downloadResume(this.cache.assetUrl, part, total);
      if (total && received !== total) throw new Error(`download incomplete: ${received}/${total} bytes`);
      this.progress = 99;

      if (!this.cache.shaUrl) throw new Error("SHA256 для bundle не опубликован");
      const expected = await fetchText(this.cache.shaUrl);
      const actual = createHash("sha256").update(readFileSync(part)).digest("hex");
      if (!expected || expected !== actual) throw new Error("SHA256 mismatch");
      log.info("update: SHA256 verified");

      rmSync(target, { force: true });
      renameSync(part, target);
      this.file = target;
      this.progress = 100;
      this.writeMeta(this.cache.latest ?? this.current, actual);
      log.info(`update downloaded: ${target} (${Math.round(received / 1024 / 1024)} MB)`);
    } catch (error) {
      this.error = (error as Error).message;
      this.progress = 0;
      log.warn("update download failed:", this.error);
    } finally {
      this.downloading = false;
    }
    return this.snapshot();
  }

  /** Verify, unpack to `{app}\new`, then hand the swap to a detached helper. */
  async install(): Promise<UpdateSnapshot> {
    if (!this.options.packaged) {
      this.error = "автообновление доступно только для собранной версии";
      return this.snapshot();
    }
    const target = this.file ?? join(updateDir(), "bundle.zip");
    if (!existsSync(target)) {
      this.error = "bundle не скачан";
      return this.snapshot();
    }
    if (this.installing) return this.snapshot();

    this.installing = true;
    try {
      const meta = this.readMeta();
      if (!meta) throw new Error("метаданные bundle не найдены, скачайте обновление заново");
      if (this.cache.latest && meta.version !== this.cache.latest) {
        throw new Error(`bundle версии ${meta.version} не совпадает с ожидаемой ${this.cache.latest}`);
      }
      const actualSha = createHash("sha256").update(readFileSync(target)).digest("hex");
      if (actualSha !== meta.sha256) throw new Error("bundle не совпадает с сохранённым SHA256");

      const app = this.appDir;
      const next = join(app, "new");
      const prev = join(app, "prev");
      rmSync(next, { recursive: true, force: true });
      mkdirSync(next, { recursive: true });
      log.info(`update: unpacking ${target} -> ${next}`);
      const unpack = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `Expand-Archive -LiteralPath '${ps(target)}' -DestinationPath '${ps(next)}' -Force`,
        ],
        { windowsHide: true, timeout: 10 * 60_000 },
      );
      if (unpack.status !== 0 || !existsSync(join(next, "ocbridge.exe"))) {
        throw new Error(`не удалось распаковать bundle${unpack.stderr ? `: ${String(unpack.stderr).trim()}` : ""}`);
      }

      const previous = this.current;
      const latest = this.cache.latest ?? previous;
      this.options.onBeforeInstall?.(previous, latest);
      await this.send(`🔄 обновлено с ${previous} до ${latest} — перезапускаюсь`);

      const script = join(updateDir(), "apply-update.ps1");
      writeFileSync(
        script,
        applyScript({
          app,
          next,
          prev,
          port: this.port(),
          items: INSTALLED_ITEMS,
          healthSeconds: HEALTH_TIMEOUT_SECONDS,
        }),
        "utf8",
      );
      const child = spawn(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
        { detached: true, stdio: "ignore", windowsHide: true },
      );
      child.unref();
      log.info(`update: helper started (${script}); exiting bridge`);
      setTimeout(() => (this.options.exit ?? ((code: number) => process.exit(code)))(0), 1500);
    } catch (error) {
      this.installing = false;
      this.error = `не удалось установить обновление: ${(error as Error).message}`;
      log.error("update install failed:", this.error);
    }
    return this.snapshot();
  }

  /** Swap `{app}\prev` back and restart. */
  async rollback(): Promise<UpdateSnapshot> {
    if (!this.options.packaged) {
      this.error = "откат доступен только для собранной версии";
      return this.snapshot();
    }
    const app = this.appDir;
    const prev = join(app, "prev");
    const prevVersion = readPrevVersion(prev);
    if (!existsSync(prev) || !existsSync(join(prev, "ocbridge.exe"))) {
      this.error = "предыдущая версия не найдена";
      return this.snapshot();
    }
    this.installing = true;
    try {
      await this.send(`↩️ откатываюсь на ${prevVersion ?? "предыдущую версию"} — перезапускаюсь`);
      const script = join(updateDir(), "rollback.ps1");
      writeFileSync(
        script,
        rollbackScript({ app, prev, port: this.port(), items: INSTALLED_ITEMS, healthSeconds: HEALTH_TIMEOUT_SECONDS }),
        "utf8",
      );
      const child = spawn(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
        { detached: true, stdio: "ignore", windowsHide: true },
      );
      child.unref();
      log.info(`rollback: helper started (${script}); exiting bridge`);
      setTimeout(() => (this.options.exit ?? ((code: number) => process.exit(code)))(0), 1500);
    } catch (error) {
      this.installing = false;
      this.error = `не удалось откатиться: ${(error as Error).message}`;
      log.error("update rollback failed:", this.error);
    }
    return this.snapshot();
  }

  // --------------------------------------------------------------- internals

  private async send(text: string): Promise<void> {
    try {
      await this.options.notify?.(text);
    } catch (error) {
      log.warn("update notification:", (error as Error).message);
    }
  }

  private async verifyFile(path: string): Promise<boolean> {
    if (!this.cache.shaUrl) return false;
    try {
      const expected = await fetchText(this.cache.shaUrl);
      const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
      return Boolean(expected) && expected === actual;
    } catch {
      return false;
    }
  }

  /** Port the web UI really bound to (the config port may have been busy). */
  private port(): number {
    const value = Number(this.options.port?.() ?? 0);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 7788;
  }

  private metaPath(): string {
    return join(updateDir(), "bundle.meta.json");
  }

  private writeMeta(version: string, sha256: string): void {
    const meta: BundleMeta = { version, sha256, downloadedAt: new Date().toISOString() };
    writeFileSync(this.metaPath(), JSON.stringify(meta, null, 2), "utf8");
  }

  private readMeta(): BundleMeta | undefined {
    try {
      const meta = JSON.parse(readFileSync(this.metaPath(), "utf8")) as Partial<BundleMeta>;
      if (typeof meta.version !== "string" || typeof meta.sha256 !== "string") return undefined;
      return { version: meta.version, sha256: meta.sha256, downloadedAt: String(meta.downloadedAt ?? "") };
    } catch {
      return undefined;
    }
  }

  /** BITS → curl → fetch. Keeps a `.part` file, so an interrupted run resumes. */
  private async downloadResume(url: string, part: string, total: number): Promise<number> {
    const start = existsSync(part) ? statSync(part).size : 0;
    if (start > 0 && total && start >= total) return start;

    if (start === 0 && process.platform === "win32" && (await this.tryBits(url, part, total))) {
      return statSync(part).size;
    }
    if (process.platform === "win32" && (await this.tryCurl(url, part, total))) {
      const size = statSync(part).size;
      if (!total || size === total) return size;
    }
    return this.fetchResume(url, part, total);
  }

  private async tryBits(url: string, part: string, total: number): Promise<boolean> {
    try {
      const script = `Import-Module BitsTransfer -ErrorAction Stop; Start-BitsTransfer -Source '${ps(url)}' -Destination '${ps(part)}' -Description 'ocbridge update' -ErrorAction Stop`;
      const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        stdio: "ignore",
      });
      const timer = setInterval(() => this.trackProgress(part, total), 500);
      const code = await new Promise<number | null>((resolve) => child.on("exit", (value) => resolve(value)));
      clearInterval(timer);
      if (code === 0 && existsSync(part) && statSync(part).size > 0) {
        log.info("update: downloaded via BITS");
        this.trackProgress(part, total);
        return true;
      }
    } catch (error) {
      log.warn("update: BITS unavailable:", (error as Error).message);
    }
    return false;
  }

  private async tryCurl(url: string, part: string, total: number): Promise<boolean> {
    try {
      const child = spawn(
        "curl.exe",
        ["-L", "--fail", "--retry", "3", "--retry-delay", "2", "-C", "-", "-o", part, url],
        { windowsHide: true, stdio: "ignore" },
      );
      const timer = setInterval(() => this.trackProgress(part, total), 500);
      const code = await new Promise<number | null>((resolve) => {
        child.on("error", () => resolve(-1));
        child.on("exit", (value) => resolve(value));
      });
      clearInterval(timer);
      if (code === 0 && existsSync(part)) {
        log.info("update: downloaded via curl");
        this.trackProgress(part, total);
        return true;
      }
    } catch (error) {
      log.warn("update: curl unavailable:", (error as Error).message);
    }
    return false;
  }

  private async fetchResume(url: string, part: string, total: number): Promise<number> {
    let start = existsSync(part) ? statSync(part).size : 0;
    const headers: Record<string, string> = { "user-agent": "ocbridge-updater" };
    if (start > 0) headers.range = `bytes=${start}-`;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (start > 0 && response.status === 200) {
      // Server ignored Range: start over instead of appending a second copy.
      rmSync(part, { force: true });
      start = 0;
    } else if (start > 0 && response.status === 416 && total && start >= total) {
      return start;
    } else if (start > 0 && response.status !== 206) {
      throw new Error(`download HTTP ${response.status}`);
    }
    if (!response.ok || !response.body) throw new Error(`download HTTP ${response.status}`);
    const reader = response.body.getReader();
    const fd = openSync(part, "a");
    let received = start;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        writeSync(fd, value);
        received += value.length;
        this.setProgress(received, total);
      }
    } finally {
      closeSync(fd);
    }
    return received;
  }

  private trackProgress(part: string, total: number): void {
    try {
      this.setProgress(statSync(part).size, total);
    } catch {
      /* file not created yet */
    }
  }

  private setProgress(received: number, total: number): void {
    if (total) this.progress = Math.min(99, Math.round((received / total) * 100));
  }
}

// ------------------------------------------------------------------ helpers

function updateDir(): string {
  return join(tmpdir(), "ocbridge-update");
}

function ps(value: string): string {
  return value.replace(/'/g, "''");
}

async function contentLength(url: string): Promise<number> {
  try {
    const response = await fetch(url, { method: "HEAD", headers: { "user-agent": "ocbridge-updater" } });
    return Number(response.headers.get("content-length") ?? 0);
  } catch {
    return 0;
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "user-agent": "ocbridge-updater" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

export function readPrevVersion(prevDir: string): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(prevDir, "version.json"), "utf8")) as { version?: string };
    return typeof meta.version === "string" ? meta.version : undefined;
  } catch {
    return undefined;
  }
}

function commonScript(items: string[], healthSeconds: number): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$Items = @(${items.map((item) => `'${ps(item)}'`).join(", ")})
function Stop-Bridge {
  Get-Process -Name 'ocbridge','OpenCode Bridge' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-Process -Name 'ocbridge','OpenCode Bridge' -ErrorAction SilentlyContinue)) { break }
  }
}
function Start-App {
  $desktop = Join-Path $App 'desktop\\OpenCode Bridge.exe'
  if (Test-Path $desktop) { Start-Process -FilePath $desktop -ArgumentList '--hidden' -WorkingDirectory $App }
  else { Start-Process -FilePath (Join-Path $App 'ocbridge.exe') -ArgumentList '--no-browser' -WorkingDirectory $App }
}
function Wait-Healthy {
  for ($i = 0; $i -lt ${healthSeconds}; $i++) {
    Start-Sleep -Seconds 1
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/state" -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) { return $true }
    } catch {}
  }
  return $false
}
function Move-Items($from, $to) {
  foreach ($item in $Items) {
    $source = Join-Path $from $item
    if (Test-Path $source) { Move-Item -LiteralPath $source -Destination (Join-Path $to $item) -Force }
  }
}
`;
}

export function applyScript(options: { app: string; next: string; prev: string; port: number; items: string[]; healthSeconds: number }): string {
  return `${commonScript(options.items, options.healthSeconds)}
$App = '${ps(options.app)}'
$New = '${ps(options.next)}'
$Prev = '${ps(options.prev)}'
$Port = ${options.port}
Start-Sleep -Seconds 2
Stop-Bridge
Remove-Item $Prev -Recurse -Force
New-Item -ItemType Directory -Path $Prev | Out-Null
Move-Items $App $Prev
Get-ChildItem -LiteralPath $New -Force | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination (Join-Path $App $_.Name) -Force }
Remove-Item $New -Recurse -Force
Start-App
if (-not (Wait-Healthy)) {
  Stop-Bridge
  $Failed = Join-Path $App 'failed'
  Remove-Item $Failed -Recurse -Force
  New-Item -ItemType Directory -Path $Failed | Out-Null
  Move-Items $App $Failed
  Get-ChildItem -LiteralPath $Prev -Force | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination (Join-Path $App $_.Name) -Force }
  Remove-Item $Prev -Recurse -Force
  Remove-Item $Failed -Recurse -Force
  Start-App
}
`;
}

export function rollbackScript(options: { app: string; prev: string; port: number; items: string[]; healthSeconds: number }): string {
  return `${commonScript(options.items, options.healthSeconds)}
$App = '${ps(options.app)}'
$Prev = '${ps(options.prev)}'
$Port = ${options.port}
Start-Sleep -Seconds 2
Stop-Bridge
$Failed = Join-Path $App 'failed'
Remove-Item $Failed -Recurse -Force
New-Item -ItemType Directory -Path $Failed | Out-Null
Move-Items $App $Failed
Get-ChildItem -LiteralPath $Prev -Force | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination (Join-Path $App $_.Name) -Force }
Remove-Item $Prev -Recurse -Force
Remove-Item $Failed -Recurse -Force
Start-App
if (-not (Wait-Healthy)) {
  Set-Content -Path (Join-Path $App 'rollback-health.txt') -Value 'rollback started, but /api/state did not answer'
}
`;
}
