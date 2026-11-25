import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  candidatePorts,
  parsePortInfo,
  parsePortText,
  portFilePath,
  readPortFile,
  removePortFile,
  writePortFile,
} from "../src/web/portfile.ts";

function tempConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocbridge-port-"));
  return join(dir, "config.json");
}

describe("port.json discovery", () => {
  test("writes next to config.json and reads back", () => {
    const configFile = tempConfig();
    const file = portFilePath(configFile);
    expect(file).toBe(join(dirname(configFile), "port.json"));
    expect(readPortFile(file)).toBeUndefined();

    writePortFile(file, { port: 7791, pid: 4242, version: "0.8.4", startedAt: 1234 });
    expect(readPortFile(file)).toEqual({ port: 7791, pid: 4242, version: "0.8.4", startedAt: 1234 });
    expect(existsSync(`${file}.bak`)).toBe(false);

    removePortFile(file);
    expect(existsSync(file)).toBe(false);
  });

  test("tolerates partial and hand-edited files", () => {
    expect(parsePortInfo({ port: "7790" })).toEqual({ port: 7790, pid: 0, version: "", startedAt: 0 });
    expect(parsePortInfo({ port: 0 })).toBeUndefined();
    expect(parsePortInfo({ port: 70000 })).toBeUndefined();
    expect(parsePortInfo({ port: "abc" })).toBeUndefined();
    expect(parsePortInfo(null)).toBeUndefined();
    expect(parsePortText("{ broken")).toBeUndefined();
    expect(parsePortText('{"port":7789}')?.port).toBe(7789);
  });

  test("candidate order: published → env → default range, deduped", () => {
    const ports = candidatePorts({
      info: { port: 7790, pid: 1, version: "", startedAt: 0 },
      env: "7791",
      fallback: 7788,
      span: 4,
    });
    expect(ports).toEqual([7790, 7791, 7788, 7789]);
    expect(candidatePorts({ env: "7788", fallback: 7788, span: 3 })).toEqual([7788, 7789, 7790]);
    expect(candidatePorts({ env: "", fallback: 7788, span: 2 })).toEqual([7788, 7789]);
  });

  test("a corrupt file is ignored without throwing", () => {
    const configFile = tempConfig();
    const file = portFilePath(configFile);
    writeFileSync(file, "not json", "utf8");
    expect(readPortFile(file)).toBeUndefined();
    writeFileSync(file, '{"port":7789}', "utf8");
    expect(readPortFile(file)?.port).toBe(7789);
  });
});
