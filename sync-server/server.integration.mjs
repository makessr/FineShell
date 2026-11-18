import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { createSyncServer } from "./server.mjs";

test("sync isolates accounts and accepts only the current revision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fineshell-sync-"));
  const database = join(dir, "vault.sqlite");
  let server = createSyncServer(database);
  try {
    const start = async () => {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      return `http://127.0.0.1:${server.address().port}/v1`;
    };
    let origin = await start();
    const health = await fetch(new URL("/healthz", origin));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { service: "fineshell-sync", status: "ok" });
    async function call(path, { method = "GET", token, body } = {}) {
      const response = await fetch(`${origin}/${path}`, {
        method,
        headers: {
          ...(token && { authorization: `Bearer ${token}` }),
          ...(body && { "content-type": "application/json" }),
        },
        body: body && JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    }
    const body = { email: "owner@example.com", password: "test-only-password" };
    const registered = await call("register", { method: "POST", body });
    assert.equal(registered.status, 200);
    const first = registered.data;
    const login = await call("login", { method: "POST", body });
    assert.equal(login.data.accountId, first.accountId);
    assert.notEqual(login.data.token, first.token);
    assert.equal((await call("login", {
      method: "POST", body: { ...body, password: "incorrect-password" },
    })).status, 401);
    const other = await call("register", {
      method: "POST", body: { ...body, email: "other@example.com" },
    });
    const bytes = (length) => randomBytes(length).toString("base64");
    const vault = {
      version: 1,
      wrappedKey: { algorithm: "XChaCha20-Poly1305", kdf: "Argon2id",
        salt: bytes(16), nonce: bytes(24), ciphertext: bytes(48) },
      nonce: bytes(24), ciphertext: bytes(96),
    };
    assert.equal((await call("vault")).status, 401);
    assert.equal((await call("vault", {
      method: "PUT", token: first.token, body: { revision: 0, vault: { hosts: [] } },
    })).status, 400);
    const writes = await Promise.all([first, login.data].map(({ token }) => call("vault", {
      method: "PUT", token, body: { revision: 0, vault },
    })));
    assert.deepEqual(writes.map(({ status }) => status).sort(), [200, 409]);
    assert.deepEqual((await call("vault", { token: other.data.token })).data,
      { revision: 0, vault: null });
    await new Promise((resolve) => server.close(resolve));
    server = createSyncServer(database);
    origin = await start();
    assert.deepEqual((await call("vault", { token: login.data.token })).data,
      { revision: 1, vault });
    assert.equal((await call("logout", { method: "POST", token: first.token })).status, 200);
    assert.equal((await call("vault", { token: first.token })).status, 401);
    assert.equal((await call("vault", { token: login.data.token })).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
