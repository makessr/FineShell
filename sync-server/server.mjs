import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const derive = promisify(scrypt);
const maxVaultBytes = 8 * 1024 * 1024;
const sessionLifetime = 30 * 24 * 60 * 60 * 1000;
const hashToken = (token) => createHash("sha256").update(token).digest("hex");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(request, limit) {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw new HttpError(415, "Expected application/json");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw new HttpError(413, "Request too large");
    }
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || Array.isArray(data) || typeof data !== "object") throw new Error();
    return data;
  } catch {
    throw new HttpError(400, "Invalid JSON object");
  }
}

function send(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function credentials(body) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = body.password;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254 ||
      typeof password !== "string" || password.length < 12 || Buffer.byteLength(password) > 1024) {
    throw new HttpError(400, "Enter a valid email and a password of at least 12 characters");
  }
  return { email, password };
}

function validateVault(vault) {
  const key = vault?.wrappedKey;
  const base64 = (value, bytes) => typeof value === "string" &&
    Buffer.from(value, "base64").length === bytes &&
    Buffer.from(value, "base64").toString("base64") === value;
  if (vault?.version !== 1 || key?.algorithm !== "XChaCha20-Poly1305" ||
      key.kdf !== "Argon2id" || !base64(key.salt, 16) || !base64(key.nonce, 24) ||
      !base64(key.ciphertext, 48) || !base64(vault.nonce, 24) ||
      typeof vault.ciphertext !== "string" || vault.ciphertext.length < 24 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(vault.ciphertext)) {
    throw new HttpError(400, "Invalid encrypted vault");
  }
  return {
    version: 1,
    wrappedKey: {
      algorithm: key.algorithm, kdf: key.kdf, salt: key.salt,
      nonce: key.nonce, ciphertext: key.ciphertext,
    },
    nonce: vault.nonce,
    ciphertext: vault.ciphertext,
  };
}

export function createSyncServer(databasePath) {
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, vault TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS session_expiration ON sessions(expires_at);
  `);
  const readAccount = db.prepare("SELECT id, salt, password_hash FROM accounts WHERE email = ?");
  const createAccount = db.prepare("INSERT OR IGNORE INTO accounts (id, email, salt, password_hash) VALUES (?, ?, ?, ?)");
  const readVault = db.prepare("SELECT revision, vault FROM accounts WHERE id = ?");
  const writeVault = db.prepare("UPDATE accounts SET revision = revision + 1, vault = ? WHERE id = ? AND revision = ?");
  const readSession = db.prepare("SELECT account_id FROM sessions WHERE token_hash = ? AND expires_at > ?");
  const createSession = db.prepare("INSERT INTO sessions VALUES (?, ?, ?)");
  const deleteSession = db.prepare("DELETE FROM sessions WHERE token_hash = ?");
  const pruneSessions = db.prepare("DELETE FROM sessions WHERE expires_at <= ?");
  const dummySalt = randomBytes(16);
  const attempts = new Map();
  let deriving = 0;

  async function authenticate(request, register) {
    const { email, password } = credentials(await readJson(request, 4096));
    const now = Date.now();
    const recent = (attempts.get(email) ?? []).filter((time) => now - time < 60_000);
    if (recent.length >= 8 || deriving >= 4 || (attempts.size >= 10_000 && !attempts.has(email))) {
      throw new HttpError(429, "Too many attempts. Try again later");
    }
    attempts.set(email, [...recent, now]);
    const existing = readAccount.get(email);
    const salt = register ? randomBytes(16) : existing ? Buffer.from(existing.salt, "hex") : dummySalt;
    deriving++;
    let derived;
    try {
      derived = await derive(password, salt, 32);
    } finally {
      deriving--;
    }
    let accountId;
    if (register) {
      accountId = randomBytes(16).toString("hex");
      if (!createAccount.run(accountId, email, salt.toString("hex"), derived.toString("hex")).changes) {
        throw new HttpError(409, "This account already exists");
      }
    } else {
      if (!existing || !timingSafeEqual(derived, Buffer.from(existing.password_hash, "hex"))) {
        throw new HttpError(401, "Invalid account or password");
      }
      accountId = existing.id;
    }
    pruneSessions.run(now);
    const token = randomBytes(32).toString("base64url");
    createSession.run(hashToken(token), accountId, now + sessionLifetime);
    return { accountId, token };
  }

  const server = createServer(async (request, response) => {
    try {
      const { method, url } = request;
      if (method === "GET" && url === "/healthz") {
        db.prepare("SELECT 1 FROM accounts LIMIT 1").get();
        send(response, 200, { service: "fineshell-sync", status: "ok" });
        return;
      }
      if (method === "POST" && (url === "/v1/register" || url === "/v1/login")) {
        send(response, 200, await authenticate(request, url === "/v1/register"));
        return;
      }
      if (url !== "/v1/vault" && url !== "/v1/logout") {
        throw new HttpError(404, "Not found");
      }
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? "");
      const tokenHash = match && hashToken(match[1]);
      const session = tokenHash && readSession.get(tokenHash, Date.now());
      if (!session) throw new HttpError(401, "Sign in again");
      if (url === "/v1/logout" && method === "POST") {
        deleteSession.run(tokenHash);
        send(response, 200, {});
      } else if (url === "/v1/vault" && method === "GET") {
        const { revision, vault } = readVault.get(session.account_id);
        send(response, 200, { revision, vault: vault && JSON.parse(vault) });
      } else if (url === "/v1/vault" && method === "PUT") {
        const { revision, vault } = await readJson(request, maxVaultBytes);
        if (!Number.isSafeInteger(revision) || revision < 0) {
          throw new HttpError(400, "Invalid vault revision");
        }
        const encrypted = validateVault(vault);
        if (!readSession.get(tokenHash, Date.now())) {
          throw new HttpError(401, "Sign in again");
        }
        if (!writeVault.run(JSON.stringify(encrypted), session.account_id, revision).changes) {
          throw new HttpError(409, "Vault changed. Read the current revision and try again");
        }
        send(response, 200, { revision: revision + 1 });
      } else {
        throw new HttpError(405, "Method not allowed");
      }
    } catch (error) {
      if (error instanceof HttpError) {
        send(response, error.status, { error: error.message });
      } else {
        console.error("Sync request failed", error.code ?? error.name);
        send(response, 500, { error: "Sync server error" });
      }
    }
  });
  const sweep = setInterval(() => {
    const cutoff = Date.now() - 60_000;
    for (const [email, times] of attempts) {
      if (times.at(-1) < cutoff) attempts.delete(email);
    }
  }, 60_000).unref();
  server.on("close", () => {
    clearInterval(sweep);
    db.close();
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const databasePath = process.env.FINESHELL_SYNC_DATABASE;
  if (!databasePath) throw new Error("Set FINESHELL_SYNC_DATABASE to a persistent SQLite file");
  const port = Number(process.env.FINESHELL_SYNC_PORT ?? 8787);
  createSyncServer(databasePath).listen(port, "127.0.0.1", () => {
    console.log(`FineShell sync listening on 127.0.0.1:${port}`);
  });
}
