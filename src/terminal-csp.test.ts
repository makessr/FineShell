import { expect, test } from "bun:test";

test("keeps startup styles external so Tauri can load xterm's runtime styles", async () => {
  // A static inline style makes Tauri add a style-src nonce, which causes
  // WebViews to ignore 'unsafe-inline' for xterm's runtime style elements.
  const entry = await Bun.file(new URL("../index.html", import.meta.url)).text();
  expect(entry).not.toMatch(/<style(?:\s|>)/i);
  expect(entry).toContain('<link rel="stylesheet" href="/startup.css"');
});
