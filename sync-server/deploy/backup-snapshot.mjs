import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";

export async function createSnapshot(database, snapshot) {
  const source = new DatabaseSync(database, { readOnly: true });
  try {
    await backup(source, snapshot);
  } finally {
    source.close();
  }
  const copy = new DatabaseSync(snapshot);
  try {
    copy.exec("PRAGMA journal_mode = DELETE");
  } finally {
    copy.close();
  }
  checkSnapshot(snapshot);
  await chmod(snapshot, 0o600);
}

export function checkSnapshot(snapshot) {
  const copy = new DatabaseSync(snapshot, { readOnly: true });
  try {
    const result = copy.prepare("PRAGMA integrity_check").all();
    if (result.length !== 1 || result[0].integrity_check !== "ok") {
      throw new Error("Backup failed SQLite integrity check");
    }
    copy.prepare("SELECT id, revision FROM accounts LIMIT 1").get();
  } finally {
    copy.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

async function main() {
  const [destination] = process.argv.slice(2);
  const database = process.env.FINESHELL_SYNC_DATABASE;
  if (!database || !destination) {
    throw new Error("Set FINESHELL_SYNC_DATABASE and pass a destination directory");
  }

  process.umask(0o077);
  const directory = resolve(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(directory, ".fineshell-backup-"));
  const snapshot = join(temporary, "vault.sqlite");
  try {
    await createSnapshot(database, snapshot);
    const name = new Date().toISOString().replaceAll(":", "").replace(".", "-");
    const file = join(directory, "vault-" + name + ".sqlite");
    await rename(snapshot, file);
    console.log(file);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
