import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
}

const REPO = "amv1978/opencode-telegram-bridge";
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const HEADERS = { accept: "application/vnd.github+json", "user-agent": "ocbridge-updater" };
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

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

/** GitHub auto-update: check, stream, verify, install; never used in dev builds. */
export class Updater {
  private cache: UpdateCache = {};
  private progress = 0;
  private error = "";
  private downloading = false;
  private installing = false;
  private file?: string;

  constructor(
    private readonly options: {
      packaged: boolean;
      dataDir: string;
      /** Test hook: pretend this version is running. */
      currentVersion?: string;
      onCache?: (cache: UpdateCache) => void;
      exit?: (code: number) => void;
    },
  ) {}

  get current(): string {
    return this.options.currentVersion ?? pkg.version;
  }

  restore(cache: UpdateCache | undefined): void {
    this.cache = cache ?? {};
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
      const asset = assets.find((item) => /^ocbridge-setup-.*\.exe$/i.test(item.name ?? ""));
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

  /** Stream the installer to %TEMP%\ocbridge-update\setup.exe; verify SHA256. */
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
      const dir = join(tmpdir(), "ocbridge-update");
      mkdirSync(dir, { recursive: true });
      const target = join(dir, "setup.exe");
      const part = `${target}.part`;
      const response = await fetch(this.cache.assetUrl, {
        headers: { "user-agent": "ocbridge-updater" },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok || !response.body) throw new Error(`download HTTP ${response.status}`);
      const total = Number(response.headers.get("content-length") ?? 0);
      const reader = response.body.getReader();
      const fd = openSync(part, "w");
      let received = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value?.length) continue;
          writeSync(fd, value);
          received += value.length;
          if (total) this.progress = Math.min(99, Math.round((received / total) * 100));
        }
      } finally {
        closeSync(fd);
      }
      if (total && received !== total) throw new Error(`download incomplete: ${received}/${total} bytes`);

      if (this.cache.shaUrl) {
        const shaResponse = await fetch(this.cache.shaUrl, { headers: { "user-agent": "ocbridge-updater" } });
        if (!shaResponse.ok) throw new Error(`sha256 HTTP ${shaResponse.status}`);
        const expected = (await shaResponse.text()).trim().split(/\s+/)[0]?.toLowerCase();
        const actual = createHash("sha256").update(readFileSync(part)).digest("hex");
        if (!expected || expected !== actual) throw new Error("SHA256 mismatch");
        log.info("update: SHA256 verified");
      }

      rmSync(target, { force: true });
      renameSync(part, target);
      this.file = target;
      this.progress = 100;
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

  /** Spawn the installer silently and exit the bridge shortly afterwards. */
  async install(): Promise<UpdateSnapshot> {
    if (!this.options.packaged) {
      this.error = "автообновление доступно только для собранной версии";
      return this.snapshot();
    }
    const target = this.file ?? join(tmpdir(), "ocbridge-update", "setup.exe");
    if (!existsSync(target)) {
      this.error = "установщик не скачан";
      return this.snapshot();
    }
    this.installing = true;
    try {
      const child = spawn(
        target,
        ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/CLOSEAPPLICATIONS", "/RESTARTAPPLICATIONS", "/NORESTART=0"],
        { detached: true, stdio: "ignore", windowsHide: false },
      );
      child.unref();
      log.info(`update: installer started (${target}); exiting bridge`);
      setTimeout(() => (this.options.exit ?? ((code: number) => process.exit(code)))(0), 2000);
    } catch (error) {
      this.installing = false;
      this.error = `не удалось запустить установщик: ${(error as Error).message}`;
      log.error("update install failed:", this.error);
    }
    return this.snapshot();
  }
}
