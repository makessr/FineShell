import { describe, expect, test } from "bun:test";
import tauriConfig from "../src-tauri/tauri.conf.json";

describe("updater endpoints", () => {
  test("uses the independent ZhanDu manifest after the cutover", () => {
    expect(tauriConfig.plugins.updater.endpoints).toEqual([
      "https://github.com/makessr/ZhanDu/releases/latest/download/latest.json",
    ]);
  });
});
