import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../package.json";
import { log } from "./log.ts";
import {
  isRetryable,
  mapUpdateFailure,
  parseSha256,
  retryDelay,
  statusProblem,
  type UpdateErrorCode,
  type UpdateProblem,
} from "./update/policy.ts";

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
  /** Machine-readable reason for `error`. */
  errorCode?: UpdateErrorCode;
  /** HTTP status when the failure came from GitHub. */
  errorStatus?: number;
  errorAt?: number;
  hint?: string;
  downloading: boolean;
  /** Download is waiting for the current turn to finish. */
  paused: boolean;
  installing: boolean;
  /** Bundle is on disk and its SHA256 was verified: Install can run. */
  verified: boolean;
  assetUrl?: string;
  publishedAt?: string;
  /** Version currently kept in `{app}\prev`, if any. */
  prevVersion?: string;
  /** True when the update payload is a bundle zip. */
  bundled: boolean;
}

const REPO = "amv1978/opencode-telegram-bridge";
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASE_PAGE = `https://github.com/${REPO}/releases/latest`;
const HEADERS = { accept: "application/vnd.github+json", "user-agent": "ocbridge-updater" };
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const CHECK_TIMEOUT_MS = 20_000;
const HEALTH_TIMEOUT_SECONDS = 60;
const RETRIES = 3;
const INSTALLED_ITEMS = ["ocbridge.exe", "ffmpeg.exe", "ocbridge-cli.exe", "desktop", "version.json", "CHANGELOG.md", "README.md"];

interface BundleMeta {
  version: string;
  sha256: string;
  downloadedAt: string;
}

class UpdateFailure extends Error {
  constructor(readonly problem: UpdateProblem) {
    super(problem.message);
  }
}

/**
 * Bun's fetch accepts a `proxy` init (HTTP/SOCKS) on every request. The updater
 * must use the same route as Telegram, otherwise GitHub is unreachable behind
 * the same firewall and every check ends in a swallowed 403.
 */
export function createUpdateFetch(proxy?: string): typeof globalThis.fetch {
  const value =
    proxy ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    "";
  if (!value.trim()) return globalThis.fetch;
  return ((input: unknown, init: Record<string, unknown> = {}) =>
    (globalThis.fetch as unknown as (a: unknown, b: unknown) => Promise<Response>)(input, { ...init, proxy: value })) as typeof globalThis.fetch;
}

/** Streaming SHA256 so a 275 MB bundle does not have to fit in memory twice. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
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
  private errorCode?: UpdateErrorCode;
  private errorStatus?: number;
  private errorAt?: number;
  private hint = "";
  private downloading = false;
  private paused = false;
  private installing = false;
  private verified = false;
  private file?: string;
  private prevVersion?: string;
  private abort?: AbortController;
  private cancelRequested = false;
  private readonly children = new Set<ReturnType<typeof spawn>>();
  private runToken = 0;

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
      /** Request implementation: Telegram net/proxy → HTTPS_PROXY → direct. */
      fetch?: () => typeof globalThis.fetch;
      onCache?: (cache: UpdateCache) => void;
      /** Called right before the swap helper starts; must persist state synchronously. */
      onBeforeInstall?: (previous: string, next: string) => void;
      /** Chat notification (lifecycle target); used for "restarting" and errors. */
      notify?: (text: string) => Promise<void> | void;
      /** Side channel for download/install failures (App throttles the chat notice). */
      onError?: (problem: UpdateProblem) => void;
      /** True while a turn is running: a background download pauses. */
      busy?: () => boolean;
      /** Test hook: start the swap helper (defaults to a detached PowerShell). */
      launchHelper?: (script: string) => void;
      /** Test hook: directory for bundle.zip / scripts (default %TEMP%\ocbridge-update). */
      updateDir?: string;
      exit?: (code: number) => void;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {
    this.options.sleep ??= (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  }

  get current(): string {
    return this.options.currentVersion ?? pkg.version;
  }

  get appDir(): string {
    return this.options.installDir ?? dirname(process.execPath);
  }

  restore(cache: UpdateCache | undefined, prevVersion?: string): void {
    this.cache = cache ?? {};
    this.prevVersion = prevVersion;
    this.syncVerified();
  }

  /** A cached release from another version must not leave a stale "verified". */
  private syncVerified(): void {
    const target = join(this.dir(), "bundle.zip");
    const meta = this.readMeta();
    const ok = Boolean(existsSync(target) && meta?.sha256 && (!this.cache.latest || meta.version === this.cache.latest));
    this.verified = ok;
    if (ok) {
      this.file = target;
      this.progress = 100;
    } else if (!this.downloading) {
      this.file = undefined;
      this.progress = 0;
    }
  }

  snapshot(): UpdateSnapshot {
    return {
      available: Boolean(this.cache.available),
      current: this.current,
      latest: this.cache.latest ?? this.current,
      notes: this.cache.notes ?? "",
      progress: this.progress,
      error: this.error,
      errorCode: this.errorCode,
      errorStatus: this.errorStatus,
      errorAt: this.errorAt,
      hint: this.hint,
      downloading: this.downloading,
      paused: this.paused,
      installing: this.installing,
      verified: this.verified,
      assetUrl: this.cache.assetUrl,
      publishedAt: this.cache.publishedAt,
      prevVersion: this.prevVersion,
      bundled: this.cache.bundled !== false,
    };
  }

  /** Page the user can open when automatic update cannot proceed. */
  get releasePage(): string {
    return RELEASE_PAGE;
  }

  /** GET the latest release and compare with the running version. */
  async check(): Promise<UpdateSnapshot> {
    this.clearError();
    const token = ++this.runToken;
    try {
      const release = await this.fetchRelease();
      if (token !== this.runToken) return this.snapshot();
      const latest = String(release.tag_name ?? "").replace(/^v/i, "");
      if (!latest) throw new UpdateFailure({ code: "asset", message: mapUpdateFailure("release has no tag_name").message });
      const assets = release.assets ?? [];
      const asset = assets.find((item) => /^ocbridge-bundle-.*\.zip$/i.test(item.name ?? ""));
      if (!asset) throw new UpdateFailure(mapUpdateFailure("no bundle asset in release"));
      const sha = assets.find((item) => (item.name ?? "").toLowerCase() === `${(asset.name ?? "").toLowerCase()}.sha256`);
      this.cache = {
        current: this.current,
        latest,
        available: compareVersions(latest, this.current) > 0,
        assetUrl: asset.browser_download_url,
        shaUrl: sha?.browser_download_url,
        notes: release.body ?? "",
        publishedAt: release.published_at ?? "",
        checkedAt: Date.now(),
        bundled: true,
      };
      this.error = "";
      this.options.onCache?.(this.cache);
      if (!this.downloading) this.syncVerified();
      log.info(`update check: current=${this.current} latest=${latest} available=${this.cache.available}`);
      return this.snapshot();
    } catch (error) {
      if (token !== this.runToken) return this.snapshot();
      this.fail(error);
      log.warn("update check failed:", this.error);
      return this.snapshot();
    }
  }

  /**
   * Stream the bundle to %TEMP%\ocbridge-update\bundle.zip with resume; verify
   * SHA256. Runs in the background (the API does not wait for it); `cancel()`
   * keeps `.part` so a later Retry resumes.
   */
  async download(): Promise<UpdateSnapshot> {
    if (!this.options.packaged) {
      this.fail(new UpdateFailure(mapUpdateFailure("только для собранной версии")));
      return this.snapshot();
    }
    if (!this.cache.available || !this.cache.assetUrl) {
      this.fail(new UpdateFailure({ code: "state", message: "Сначала проверьте обновления: подходящий bundle не найден." }));
      return this.snapshot();
    }
    if (this.downloading) return this.snapshot();

    this.downloading = true;
    this.verified = false;
    this.progress = 0;
    this.cancelRequested = false;
    this.clearError();
    const token = ++this.runToken;
    const controller = new AbortController();
    this.abort = controller;
    const timer = setTimeout(() => controller.abort(new Error("download timeout")), DOWNLOAD_TIMEOUT_MS);
    timer.unref?.();

    let problem: UpdateProblem | undefined;
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await this.downloadOnce(controller.signal);
          problem = undefined;
          break;
        } catch (error) {
          if (token !== this.runToken) return this.snapshot();
          problem = this.problemOf(error);
          if (this.cancelRequested || !isRetryable(problem.code) || attempt >= RETRIES) break;
          const delay = retryDelay(attempt);
          if (delay === undefined) break;
          this.error = problem.message;
          this.errorCode = problem.code;
          this.errorStatus = problem.status;
          this.hint = `Повтор через ${Math.round(delay / 1000)} с…`;
          log.warn(`update download retry ${attempt + 1} in ${delay} ms: ${problem.message}`);
          await this.delay(delay, controller.signal);
          this.hint = "";
        }
      }
      if (problem) {
        if (!this.cancelRequested) {
          this.fail(new UpdateFailure(problem));
          if (token === this.runToken) log.warn("update download failed:", this.error);
        }
      } else if (token === this.runToken) {
        log.info("update: bundle downloaded and verified");
      }
    } finally {
      clearTimeout(timer);
      if (token === this.runToken) {
        this.downloading = false;
        this.paused = false;
        this.abort = undefined;
      }
    }
    return this.snapshot();
  }

  /** Cancel an in-flight download; the `.part` file is kept for resume. */
  cancel(): UpdateSnapshot {
    if (!this.downloading) return this.snapshot();
    this.cancelRequested = true;
    this.abort?.abort(new Error("canceled"));
    for (const child of this.children) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    this.children.clear();
    this.progress = 0;
    this.downloading = false;
    this.paused = false;
    this.error = "Загрузка отменена.";
    this.errorCode = "canceled";
    this.errorStatus = undefined;
    this.errorAt = Date.now();
    this.hint = "Нажмите «Повторить», чтобы продолжить с того же места.";
    log.info("update: download canceled by user");
    return this.snapshot();
  }

  /** Verify, unpack to `{app}\new`, then hand the swap to a detached helper. */
  async install(): Promise<UpdateSnapshot> {
    if (!this.options.packaged) {
      this.fail(new UpdateFailure(mapUpdateFailure("только для собранной версии")));
      return this.snapshot();
    }
    const target = this.file ?? join(this.dir(), "bundle.zip");
    if (!existsSync(target)) {
      this.fail(new UpdateFailure({ code: "state", message: "Bundle не скачан — нажмите «Скачать и установить»." }));
      return this.snapshot();
    }
    if (this.installing) return this.snapshot();

    this.installing = true;
    this.clearError();
    try {
      const meta = this.readMeta();
      if (!meta) throw new Error("метаданные bundle не найдены, скачайте обновление заново");
      if (this.cache.latest && meta.version !== this.cache.latest) {
        throw new Error(`bundle версии ${meta.version} не совпадает с ожидаемой ${this.cache.latest}`);
      }
      const actualSha = await sha256File(target);
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

      const script = join(this.dir(), "apply-update.ps1");
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
      this.launchHelper(script);
      log.info(`update: helper started (${script}); exiting bridge`);
      this.exitSoon();
    } catch (error) {
      this.installing = false;
      this.fail(new UpdateFailure(this.problemOf(error, "install")));
      log.error("update install failed:", this.error);
    }
    return this.snapshot();
  }

  /** Swap `{app}\prev` back and restart. */
  async rollback(): Promise<UpdateSnapshot> {
    if (!this.options.packaged) {
      this.fail(new UpdateFailure(mapUpdateFailure("только для собранной версии")));
      return this.snapshot();
    }
    const app = this.appDir;
    const prev = join(app, "prev");
    const prevVersion = readPrevVersion(prev);
    if (!existsSync(prev) || !existsSync(join(prev, "ocbridge.exe"))) {
      this.fail(new UpdateFailure({ code: "state", message: "Предыдущая версия не найдена." }));
      return this.snapshot();
    }
    this.installing = true;
    this.clearError();
    try {
      await this.send(`↩️ откатываюсь на ${prevVersion ?? "предыдущую версию"} — перезапускаюсь`);
      const script = join(this.dir(), "rollback.ps1");
      writeFileSync(
        script,
        rollbackScript({ app, prev, port: this.port(), items: INSTALLED_ITEMS, healthSeconds: HEALTH_TIMEOUT_SECONDS }),
        "utf8",
      );
      this.launchHelper(script);
      log.info(`rollback: helper started (${script}); exiting bridge`);
      this.exitSoon();
    } catch (error) {
      this.installing = false;
      this.fail(new UpdateFailure(this.problemOf(error, "rollback")));
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

  private launchHelper(script: string): void {
    if (this.options.launchHelper) {
      this.options.launchHelper(script);
      return;
    }
    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    child.unref();
  }

  private exitSoon(): void {
    setTimeout(() => (this.options.exit ?? ((code: number) => process.exit(code)))(0), 1500);
  }

  private fetchImpl(): typeof globalThis.fetch {
    return this.options.fetch?.() ?? globalThis.fetch;
  }

  /** One release request with the 5 s / 30 s / 5 min backoff for transient errors. */
  private async fetchRelease(): Promise<{
    tag_name?: string;
    body?: string;
    published_at?: string;
    assets?: Array<{ name?: string; browser_download_url?: string }>;
  }> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.fetchImpl()(RELEASE_API, {
          headers: HEADERS,
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
        if (response.ok) return (await response.json()) as never;
        const remaining = response.headers.get("x-ratelimit-remaining");
        const resetSeconds = Number(response.headers.get("x-ratelimit-reset") ?? 0);
        const problem = statusProblem(response.status, resetSeconds > 0 ? resetSeconds * 1000 : undefined);
        if (response.status >= 500 && attempt < RETRIES) {
          await this.delay(retryDelay(attempt) ?? 0);
          continue;
        }
        throw new UpdateFailure(problem);
      } catch (error) {
        if (error instanceof UpdateFailure) throw error;
        const problem = mapUpdateFailure(error);
        if (!isRetryable(problem.code) || attempt >= RETRIES) throw new UpdateFailure(problem);
        const delay = retryDelay(attempt);
        if (delay === undefined) throw new UpdateFailure(problem);
        log.warn(`update check retry ${attempt + 1} in ${delay} ms: ${problem.message}`);
        await this.delay(delay);
      }
    }
  }

  private async downloadOnce(signal: AbortSignal): Promise<void> {
    const dir = this.dir();
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "bundle.zip");
    const part = `${target}.part`;

    if (existsSync(target) && (await this.verifyFile(target))) {
      this.file = target;
      this.progress = 100;
      this.verified = true;
      const sha = this.readMeta()?.sha256 ?? (await this.fetchSha());
      this.writeMeta(this.cache.latest ?? this.current, sha);
      log.info("update: already downloaded and verified");
      return;
    }

    await this.waitWhileBusy(signal);
    const total = await contentLength(this.cache.assetUrl!, this.fetchImpl());
    const received = await this.downloadResume(this.cache.assetUrl!, part, total, signal);
    if (total && received !== total) throw new Error(`download incomplete: ${received}/${total} bytes`);
    this.progress = 99;

    const expected = await this.fetchSha();
    if (!expected) throw new Error("SHA256 для bundle не опубликован");
    const actual = await sha256File(part);
    if (expected !== actual) throw new Error("SHA256 mismatch");
    log.info("update: SHA256 verified");

    rmSync(target, { force: true });
    renameSync(part, target);
    this.file = target;
    this.progress = 100;
    this.verified = true;
    this.writeMeta(this.cache.latest ?? this.current, actual);
    log.info(`update downloaded: ${target} (${Math.round(received / 1024 / 1024)} MB)`);
  }

  private async fetchSha(): Promise<string> {
    if (!this.cache.shaUrl) return "";
    const response = await this.fetchImpl()(this.cache.shaUrl, {
      headers: { "user-agent": "ocbridge-updater" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) throw new UpdateFailure(statusProblem(response.status));
    return parseSha256(await response.text());
  }

  private async verifyFile(path: string): Promise<boolean> {
    if (!this.cache.shaUrl) return false;
    try {
      const expected = await this.fetchSha();
      return Boolean(expected) && expected === (await sha256File(path));
    } catch {
      return false;
    }
  }

  /** A background download yields to the running turn between chunks. */
  private async waitWhileBusy(signal: AbortSignal): Promise<void> {
    if (!this.options.busy?.()) return;
    this.paused = true;
    log.info("update: download paused while a turn is running");
    try {
      while (this.options.busy?.()) {
        if (signal.aborted) throw new Error("canceled");
        await this.delay(2000, signal);
      }
    } finally {
      this.paused = false;
    }
    log.info("update: download resumed");
  }

  /** Port the web UI really bound to (the config port may have been busy). */
  private port(): number {
    const value = Number(this.options.port?.() ?? 0);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 7788;
  }

  private metaPath(): string {
    return join(this.dir(), "bundle.meta.json");
  }

  private dir(): string {
    return this.options.updateDir ?? updateDir();
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

  private problemOf(error: unknown, phase: "download" | "install" | "rollback" = "download"): UpdateProblem {
    if (error instanceof UpdateFailure) return error.problem;
    const problem = mapUpdateFailure(error);
    if (problem.code === "unknown") {
      const prefix = phase === "install" ? "не удалось установить обновление" : phase === "rollback" ? "не удалось откатиться" : "не удалось скачать обновление";
      return { ...problem, message: `${prefix}: ${problem.message.replace(/^Обновление не удалось: /, "")}` };
    }
    return problem;
  }

  private fail(error: unknown): void {
    const problem = this.problemOf(error);
    this.error = problem.message;
    this.errorCode = problem.code;
    this.errorStatus = problem.status;
    this.hint = problem.hint ?? "";
    this.errorAt = Date.now();
    this.progress = 0;
    this.downloading = false;
    this.paused = false;
    try {
      this.options.onError?.(problem);
    } catch (notifyError) {
      log.warn("update error callback:", (notifyError as Error).message);
    }
  }

  private clearError(): void {
    this.error = "";
    this.errorCode = undefined;
    this.errorStatus = undefined;
    this.errorAt = undefined;
    this.hint = "";
  }

  private async delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return;
    if (signal?.aborted) throw new Error("canceled");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listener: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(resolve, ms);
        if (!signal) return;
        listener = () => {
          if (timer) clearTimeout(timer);
          reject(new Error("canceled"));
        };
        signal.addEventListener("abort", listener, { once: true });
      });
    } finally {
      if (listener) signal?.removeEventListener("abort", listener);
    }
  }

  /** BITS → curl → fetch. Keeps a `.part` file, so an interrupted run resumes. */
  private async downloadResume(url: string, part: string, total: number, signal: AbortSignal): Promise<number> {
    const start = existsSync(part) ? statSync(part).size : 0;
    if (start > 0 && total && start >= total) return start;

    if (start === 0 && process.platform === "win32" && (await this.tryBits(url, part, total, signal))) {
      return statSync(part).size;
    }
    if (process.platform === "win32" && (await this.tryCurl(url, part, total, signal))) {
      const size = statSync(part).size;
      if (!total || size === total) return size;
    }
    return this.fetchResume(url, part, total, signal);
  }

  private async tryBits(url: string, part: string, total: number, signal: AbortSignal): Promise<boolean> {
    try {
      await this.waitWhileBusy(signal);
      const script = `Import-Module BitsTransfer -ErrorAction Stop; Start-BitsTransfer -Source '${ps(url)}' -Destination '${ps(part)}' -Description 'ocbridge update' -ErrorAction Stop`;
      const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        stdio: "ignore",
      });
      this.children.add(child);
      const timer = setInterval(() => this.trackProgress(part, total), 500);
      const code = await new Promise<number | null>((resolve) => child.on("exit", (value) => resolve(value)));
      clearInterval(timer);
      this.children.delete(child);
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

  private async tryCurl(url: string, part: string, total: number, signal: AbortSignal): Promise<boolean> {
    try {
      await this.waitWhileBusy(signal);
      const args = ["-L", "--fail", "--retry", "3", "--retry-delay", "2", "-C", "-", "-o", part, url];
      const child = spawn("curl.exe", args, { windowsHide: true, stdio: "ignore" });
      this.children.add(child);
      const timer = setInterval(() => this.trackProgress(part, total), 500);
      const code = await new Promise<number | null>((resolve) => {
        child.on("error", () => resolve(-1));
        child.on("exit", (value) => resolve(value));
      });
      clearInterval(timer);
      this.children.delete(child);
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

  private async fetchResume(url: string, part: string, total: number, signal: AbortSignal): Promise<number> {
    let start = existsSync(part) ? statSync(part).size : 0;
    const headers: Record<string, string> = { "user-agent": "ocbridge-updater" };
    if (start > 0) headers.range = `bytes=${start}-`;
    const response = await this.fetchImpl()(url, { headers, signal });
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
    let fd = openSync(part, "a");
    let received = start;
    try {
      for (;;) {
        if (this.cancelRequested) throw new Error("canceled");
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        writeSync(fd, value);
        received += value.length;
        this.setProgress(received, total);
        if (this.options.busy?.()) {
          closeSync(fd);
          await this.waitWhileBusy(signal);
          fd = openSync(part, "a");
        }
      }
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
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

async function contentLength(url: string, fetchImpl: typeof globalThis.fetch): Promise<number> {
  try {
    const response = await fetchImpl(url, { method: "HEAD", headers: { "user-agent": "ocbridge-updater" } });
    return Number(response.headers.get("content-length") ?? 0);
  } catch {
    return 0;
  }
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
