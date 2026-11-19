import { describe, expect, test } from "bun:test";
import {
  cargoPackageVersion,
  validateReleaseRepository,
  validateReleaseVersion,
} from "./check-release-version";

const versions = {
  cargo: "1.2.3",
  packageJson: "1.2.3",
  tauri: "1.2.3",
};

describe("release version validation", () => {
  test("accepts a tag matching all application versions", () => {
    expect(validateReleaseVersion("v1.2.3", versions)).toBe("1.2.3");
  });

  test("rejects invalid tags and version mismatches", () => {
    expect(() => validateReleaseVersion("release-1.2.3", versions)).toThrow(
      "格式无效",
    );
    expect(() =>
      validateReleaseVersion("v1.2.4", versions),
    ).toThrow("与应用版本");
    expect(() =>
      validateReleaseVersion("v1.2.3", {
        ...versions,
        cargo: "1.2.2",
      }),
    ).toThrow("版本不一致");
  });

  test("reads the version from the Cargo package section", () => {
    expect(
      cargoPackageVersion(`
[package]
name = "fineshell"
version = "1.2.3"

[dependencies]
library = { version = "9.9.9" }
`),
    ).toBe("1.2.3");
  });
});

describe("release update channel", () => {
  const endpoints = [
    "https://github.com/makessr/FineShell/releases/latest/download/latest.json",
  ];
  const zhandu = [
    "https://github.com/makessr/ZhanDu/releases/latest/download/latest.json",
  ];

  test("allows the repository configured in the app", () => {
    expect(() => validateReleaseRepository(endpoints, "makessr/fineshell"))
      .not.toThrow();
  });

  test("rejects publishing from the independent repo before the channel cutover", () => {
    expect(() => validateReleaseRepository(endpoints, "makessr/ZhanDu"))
      .toThrow("应用更新渠道与发布仓库不一致");
    expect(() => validateReleaseRepository([], "makessr/ZhanDu"))
      .toThrow("应用更新渠道与发布仓库不一致");
  });

  test("requires the migration draft mode to build the ZhanDu client from FineShell", () => {
    expect(() => validateReleaseRepository(zhandu, "makessr/FineShell"))
      .toThrow("应用更新渠道与发布仓库不一致");
    expect(() => validateReleaseRepository(zhandu, "makessr/fineshell", true))
      .not.toThrow();
    expect(() => validateReleaseRepository(zhandu, "makessr/ZhanDu"))
      .not.toThrow();
  });

  test("limits migration drafts to FineShell and a single official ZhanDu endpoint", () => {
    expect(() => validateReleaseRepository(zhandu, "makessr/ZhanDu", true))
      .toThrow("只能由 makessr/FineShell 构建");
    expect(() => validateReleaseRepository([...zhandu, ...endpoints], "makessr/FineShell", true))
      .toThrow("必须配置一个更新地址");
    for (const endpoint of [
      endpoints[0],
      zhandu[0].replace("/makessr/", "/another/"),
      zhandu[0].replace("/ZhanDu/", "/ZhanDu-preview/"),
      zhandu[0] + "?channel=preview",
    ]) {
      expect(() => validateReleaseRepository([endpoint], "makessr/FineShell", true))
        .toThrow("渠道迁移草稿的客户端更新地址不正确");
    }
  });
});
