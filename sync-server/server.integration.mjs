import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { createSyncServer } from "./server.mjs";

test("migrates a legacy session without forcing the device to log in", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fineshell-legacy-sync-"));
  const database = join(dir, "vault.sqlite");
  const token = randomBytes(32).toString("base64url");
  const db = new DatabaseSync(database);
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, vault TEXT
    ) STRICT;
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
      expires_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO accounts (id, email, salt, password_hash) VALUES ('legacy', 'legacy@example.com', '', '');
  `);
  db.prepare("INSERT INTO sessions VALUES (?, 'legacy', ?)").run(
    createHash("sha256").update(token).digest("hex"), Date.now() + 60_000,
  );
  db.close();
  const server = createSyncServer(database);
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/devices`, {
      headers: { authorization: "Bearer " + token },
    });
    assert.equal(response.status, 200);
    const [device] = await response.json();
    assert.match(device.id, /^[a-f0-9]{32}$/);
    assert.equal(device.current, true);
    assert.equal(device.lastSyncAt, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

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
    const login = await call("login", { method: "POST", body: { ...body, deviceName: "Second" } });
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
    const devices = await call("devices", { token: first.token });
    assert.equal(devices.data.length, 2);
    const current = devices.data.find((item) => item.current);
    const second = devices.data.find((item) => !item.current);
    assert.equal(second.name, "Second");
    assert.equal((await call("devices/synced", { method: "POST", token: login.data.token })).status, 200);
    assert.ok((await call("devices", { token: first.token })).data.find((item) => item.id === second.id).lastSyncAt);
    assert.equal((await call("devices/" + current.id, { method: "DELETE", token: first.token })).status, 400);
    assert.equal((await call("devices/" + second.id, { method: "DELETE", token: other.data.token })).status, 404);

    const snapshot = join(dir, "restored.sqlite");
    const db = new DatabaseSync(database, { readOnly: true });
    await backup(db, snapshot);
    db.close();
    const nextVault = { ...vault, ciphertext: bytes(128) };
    assert.equal((await call("vault", {
      method: "PUT", token: first.token, body: { revision: 1, vault: nextVault },
    })).data.revision, 2);
    await new Promise((resolve) => server.close(resolve));
    server = createSyncServer(snapshot);
    origin = await start();
    assert.deepEqual((await call("vault", { token: login.data.token })).data,
      { revision: 1, vault });
    const repaired = { ...nextVault, ciphertext: bytes(144) };
    assert.equal((await call("vault/recover", {
      method: "POST", token: first.token, body: { revision: 1, nextRevision: 2, vault: repaired },
    })).status, 400);
    assert.equal((await call("vault/recover", {
      method: "POST", token: first.token, body: { revision: 1, nextRevision: 3, vault: repaired },
    })).data.revision, 3);
    assert.equal((await call("vault/recover", {
      method: "POST", token: first.token, body: { revision: 1, nextRevision: 4, vault: repaired },
    })).status, 409);
    assert.deepEqual((await call("vault", { token: login.data.token })).data, { revision: 3, vault: repaired });
    assert.equal((await call("devices/" + second.id, { method: "DELETE", token: first.token })).status, 200);
    assert.equal((await call("vault", { token: login.data.token })).status, 401);
    assert.equal((await call("logout", { method: "POST", token: first.token })).status, 200);
    assert.equal((await call("vault", { token: first.token })).status, 401);
    assert.equal((await call("devices", { token: first.token })).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
