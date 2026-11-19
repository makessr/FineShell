import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { startSshFixture } from "./ssh-fixture.mjs";
import { evaluate, findWindow, invoke, until } from "./webview.mjs";

const [port, baseline, target, marker, ssh2Path, transitionInstaller, binary, baselinePid] = process.argv.slice(2);
const { default: ssh2 } = await import(pathToFileURL(resolve(ssh2Path)).href);
const run = promisify(execFile);
const otaScript = fileURLToPath(new URL("./ota.mjs", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "fineshell-ota-credentials-"));
const suffix = randomUUID();
const passwordId = "ota-password-" + suffix;
const keyHostId = "ota-key-host-" + suffix;
const keyId = "ota-key-" + suffix;

function storedConfiguration(seed) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("fineshell.config");
    request.onupgradeneeded = () => request.transaction.abort();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("configuration")) {
        db.close();
        reject(new Error("Configuration database is not ready"));
        return;
      }
      const tx = db.transaction("configuration", seed ? "readwrite" : "readonly");
      const store = tx.objectStore("configuration");
      const item = store.get("primary");
      let result;
      item.onsuccess = () => {
        const current = item.result ?? { id: "primary" };
        result = { hosts: current.hosts ?? [], sshKeys: current.sshKeys ?? [] };
        if (seed) store.put({ ...current, ...seed });
      };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

async function runOta(phase) {
  const { stdout } = await run(process.execPath, [otaScript, phase, port, baseline, target, marker]);
  process.stdout.write(stdout);
}

async function installTransition(oldView) {
  await evaluate(oldView, (marker) => localStorage.setItem("fineshell-ota-smoke-marker", marker), marker);
  await invoke(oldView, "plugin:window|close", { label: "main" }).catch(() => {});
  await until("Exit the baseline test application", () => {
    try {
      process.kill(Number(baselinePid), 0);
      return false;
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
  }, 15_000);
  const folder = dirname(binary);
  await run(transitionInstaller, ["/S", "/D=" + folder], { windowsHide: true, timeout: 90_000 });
  console.log("Transition installer completed in the baseline installation directory.");
  await new Promise((resolve, reject) => {
    const app = spawn(binary, [], { cwd: folder, windowsHide: true, stdio: "ignore" });
    app.once("error", reject);
    app.once("spawn", () => { app.unref(); resolve(); });
  });
}

async function startSignedMirror(configPath) {
  const { certificate, key, installer, signature } = JSON.parse(await readFile(configPath, "utf8"));
  const source = "https://github.com/makessr/FineShell/releases";
  const manifestPath = "/" + source + "/latest/download/latest.json";
  const downloadUrl = source + "/download/v" + target + "/FineShell-bridge.exe";
  const platform = { url: downloadUrl, signature: (await readFile(signature, "utf8")).trim() };
  assert.ok(platform.signature);
  const manifest = JSON.stringify({
    version: target,
    platforms: { "windows-x86_64": platform, "windows-x86_64-nsis": platform },
  });
  const size = (await stat(installer)).size;
  const counts = { manifest: 0, installer: 0 };
  const server = createServer({ cert: await readFile(certificate), key: await readFile(key) }, (req, res) => {
    if (req.method === "GET" && req.url === manifestPath) {
      counts.manifest++;
      res.writeHead(200, { "Content-Type": "application/json" }).end(manifest);
    } else if (req.method === "GET" && req.url === "/" + downloadUrl) {
      const stream = createReadStream(installer);
      stream.on("error", (error) => res.destroy(error));
      counts.installer++;
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": size });
      stream.pipe(res);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: "https://127.0.0.1:" + server.address().port + "/",
    counts,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

async function installSignedTransition(oldView, mirror) {
  await evaluate(oldView, (marker) => localStorage.setItem("fineshell-ota-smoke-marker", marker), marker);
  const update = await invoke(oldView, "application_update_check", {
    request: { route: "custom", customUrl: mirror.url },
  });
  assert.equal(update?.currentVersion, baseline);
  assert.equal(update?.version, target);
  assert.equal(update?.route, "自定义镜像");
  assert.ok(mirror.counts.manifest > 0);
  await evaluate(oldView, (updateId) => {
    const api = window.__TAURI_INTERNALS__;
    const channelId = api.transformCallback(() => {});
    void api.invoke("application_update_download_and_install", {
      updateId, onEvent: "__CHANNEL__:" + channelId,
    }).catch((error) => {
      window.__otaInstallError = error?.message ?? String(error);
    });
  }, update.updateId);
  console.log("The installed v0.5.1 client found the signed candidate through its custom HTTPS update route.");
}

async function connectSavedHost(view, host, method, fixture) {
  await evaluate(view, () => document.querySelector(".terminal-home-tab")?.click());
  await until("Connect to saved " + method + " host", () => evaluate(view, (name) => {
    const row = [...document.querySelectorAll("tr")].find((item) => item.textContent.includes(name));
    const button = [...(row?.querySelectorAll("button") ?? [])].find((item) => item.textContent.trim() === "连接");
    if (!button) return false;
    button.click();
    return true;
  }, host.name));
  await until("Authenticate using saved " + method, async () => {
    const connected = await evaluate(view, (fingerprint) => {
      const modal = document.querySelector(".fingerprint-confirm-modal");
      if (modal) {
        if (!modal.textContent.includes(fingerprint)) throw new Error("Loopback fixture fingerprint mismatched");
        [...modal.querySelectorAll("button")]
          .find((button) => button.textContent.trim() === "信任并连接")?.click();
      }
      return !!document.querySelector(".terminal-status-connected") && !!document.querySelector(".xterm");
    }, fixture.fingerprint);
    return connected && fixture.counts[method] > 0;
  });
  console.log("Upgraded FineShell opened a terminal using saved " + method + " authentication.");
}

let fixture;
let mirror;
try {
  fixture = await startSshFixture(ssh2, directory);
  const oldView = await findWindow(port, "main");
  assert.equal(await invoke(oldView, "plugin:app|version"), baseline);
  const initial = await until("Initialize baseline profile", () => evaluate(oldView, storedConfiguration));
  assert.equal(initial.hosts.length, 0);
  assert.equal(initial.sshKeys.length, 0);
  const common = { address: "127.0.0.1", port: fixture.port, group: "OTA test",
    connectTimeoutSeconds: 8, keepAliveIntervalSeconds: 15, autoReconnect: false, maxReconnectAttempts: 0 };
  const hosts = [
    { ...common, id: passwordId, name: "OTA password host", username: "fineshell-password", authMethod: "password" },
    { ...common, id: keyHostId, name: "OTA key host", username: "fineshell-key", authMethod: "privateKey", sshKeyId: keyId },
  ];
  const imported = await invoke(oldView, "managed_ssh_key_import", {
    keyId, privateKey: await readFile(fixture.deviceKeyFile, "utf8"),
  });
  assert.equal(imported.reference, "managed://" + keyId);
  await rm(fixture.deviceKeyFile);
  await invoke(oldView, "store_host_password", { hostId: passwordId, password: fixture.password });
  await invoke(oldView, "store_private_key_passphrase", { hostId: keyId, passphrase: fixture.keyPassphrase });
  await evaluate(oldView, storedConfiguration, { hosts, sshKeys: [{
    id: keyId, name: "OTA managed key", privateKeyPath: imported.reference, source: "managed",
  }] });
  console.log("Baseline saved two hosts, a managed encrypted key, and credentials in the Windows credential store.");
  const signedUpdateConfig = process.env.FINESHELL_OTA_MIRROR_FIXTURE;
  if (signedUpdateConfig) {
    mirror = await startSignedMirror(signedUpdateConfig);
    await installSignedTransition(oldView, mirror);
  } else if (transitionInstaller) {
    await installTransition(oldView);
  } else {
    await runOta("update");
  }

  const newView = await until("Restart into " + target, async () => {
    const view = await findWindow(port, "main");
    if (mirror) {
      const error = await evaluate(view, () => window.__otaInstallError);
      if (error) throw new Error(error);
    }
    return await invoke(view, "plugin:app|version") === target ? view : false;
  }, 150_000);
  await runOta("verify");
  if (mirror) {
    assert.ok(mirror.counts.installer > 0, "The updater did not request the signed mirror installer");
    console.log("The original updater downloaded, verified, and installed the signed candidate.");
  }
  if (transitionInstaller || mirror) {
    await until("ZhanDu transition branding", () => evaluate(newView, () =>
      document.title === "栈渡" &&
      document.querySelector(".application-titlebar-brand")?.innerText.trim() === "栈渡"));
    console.log("The upgraded desktop displays the ZhanDu name.");
  }
  const after = await evaluate(newView, storedConfiguration);
  assert.deepEqual(after.hosts.map(({ id }) => id).sort(), [passwordId, keyHostId].sort());
  assert.equal(after.sshKeys.find(({ id }) => id === keyId)?.privateKeyPath, imported.reference);
  assert.deepEqual(fixture.counts, { password: 0, publickey: 0 });
  await connectSavedHost(newView, hosts[0], "password", fixture);
  await connectSavedHost(newView, hosts[1], "publickey", fixture);

  await invoke(newView, "delete_host_password", { hostId: passwordId });
  await invoke(newView, "delete_private_key_passphrase", { hostId: keyId });
  await invoke(newView, "managed_ssh_key_delete", { keyId });
} finally {
  await mirror?.close();
  await fixture?.close();
  await rm(directory, { recursive: true, force: true });
}
