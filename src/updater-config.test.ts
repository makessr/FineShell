import { describe, expect, test } from "bun:test";
import tauriConfig from "../src-tauri/tauri.conf.json";

describe("updater endpoints", () => {
  test("uses the GitHub Release updater manifest", () => {
    expect(tauriConfig.plugins.updater.endpoints).toEqual([
      "https://github.com/makessr/FineShell/releases/latest/download/latest.json",
    ]);
  });
});
