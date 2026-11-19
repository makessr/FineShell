import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSyncServer } from "../../sync-server/server.mjs";
import { evaluate, findWindow, invoke, until } from "./webview.mjs";
import { startSshFixture } from "./ssh-fixture.mjs";

const [portA, portB, ssh2Path] = process.argv.slice(2);
if (!portA || !portB || !ssh2Path || portA === portB) {
  throw new Error("Usage: node sync.mjs <device-a-port> <device-b-port> <ssh2-module-entry>");
}
const { default: ssh2 } = await import(pathToFileURL(resolve(ssh2Path)).href);
const directory = await mkdtemp(join(tmpdir(), "fineshell-desktop-smoke-"));
let fixture;
let server;

function configuration(seed, includeBase = false) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("fineshell.config");
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => request.transaction.abort();
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("configuration")) {
        db.close();
        reject(new Error("Waiting for FineShell to initialize its test configuration"));
        return;
      }
      const tx = db.transaction("configuration", seed ? "readwrite" : "readonly");
      const store = tx.objectStore("configuration");
      const item = store.get("primary");
      let result;
      item.onsuccess = () => {
        const current = item.result ?? { id: "primary" };
        if (seed) {
          store.put({ ...current, ...seed });
        } else {
          result = { hosts: current.hosts ?? [], keys: current.sshKeys ?? [], synced: !!current.hostSyncBase,
            ...(includeBase && { base: JSON.parse(current.hostSyncBase) }) };
        }
      };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

async function click(view, text) {
  return until(text, () => evaluate(view, (text) => {
    const button = [...document.querySelectorAll("button, [role=menuitem], .arco-menu-item")]
      .find((item) => item.textContent.trim() === text);
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }, text));
}

async function settings(view, port) {
  await invoke(view, "open_settings_window");
  const panel = await findWindow(port, "settings");
  await click(panel, "主机同步");
  return panel;
}

function fill(view, values) {
  return until("Sync settings input", () => evaluate(view, (values) => {
    const fields = Object.entries(values).map(([name, value]) => {
      const label = [...document.querySelectorAll("label")].find((element) => element.textContent.trim() === name);
      return [label?.querySelector("input"), value];
    });
    if (fields.some(([input]) => !input)) return false;
    for (const [input, value] of fields) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return true;
  }, values));
}

async function readKey(view, text) {
  return until("Generated recovery key", () => evaluate(view, (text) => {
    const label = [...document.querySelectorAll("label")].find((item) => item.textContent.trim() === text);
    return label?.querySelector("input")?.value;
  }, text));
}

try {
  const a = await findWindow(portA, "main");
  const b = await findWindow(portB, "main");
  for (const view of [a, b]) {
    assert.equal(await invoke(view, "host_sync_account"), null, "Use two fresh isolated test profiles");
    const initial = await until("Initialized desktop configuration", () => evaluate(view, configuration));
    assert.deepEqual(initial, { hosts: [], keys: [], synced: false });
  }
  fixture = await startSshFixture(ssh2, directory);
  server = createSyncServer(join(directory, "sync.sqlite"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = "http://127.0.0.1:" + server.address().port;
  const email = "windows-fixture@example.test";
  const password = randomBytes(24).toString("base64url");
  const common = { address: "127.0.0.1", port: fixture.port, group: "Smoke group",
    connectTimeoutSeconds: 8, keepAliveIntervalSeconds: 15, autoReconnect: false, maxReconnectAttempts: 0 };
  const hosts = [
    { ...common, id: "smoke-password", name: "Smoke password host", username: "fineshell-password", authMethod: "password" },
    { ...common, id: "smoke-key", name: "Smoke key host", username: "fineshell-key", authMethod: "privateKey", sshKeyId: "smoke-key-file" },
  ];
  await invoke(a, "store_host_password", { hostId: "smoke-password", password: fixture.password });
  await invoke(a, "store_private_key_passphrase", { hostId: "smoke-key-file", passphrase: fixture.keyPassphrase });
  await evaluate(a, configuration, { hosts, sshKeys: [{ id: "smoke-key-file", name: "Smoke identity",
    privateKeyPath: fixture.deviceKeyFile, source: "file" }] });

  const setupA = await settings(a, portA);
  const setupB = await settings(b, portB);
  const form = { "同步服务地址": address, "邮箱": email, "账号密码": password };
  await fill(setupA, form);
  await click(setupA, "创建账号");
  const original = await readKey(setupA, "恢复密钥");
  await fill(setupA, { "粘贴恢复密钥以确认已保存": original });
  await click(setupA, "创建账号并同步");
  await until("Device A uploads host credentials", async () => (await evaluate(a, configuration)).synced);
  await fill(setupB, { ...form, "恢复密钥": original });
  await click(setupB, "登录并同步");
  await until("Device B automatically receives both hosts and the managed key", async () => {
    const state = await evaluate(b, configuration);
    return state.synced && state.hosts.length === 2 &&
      state.keys.some((key) => key.privateKeyPath === "managed://smoke-key-file");
  });

  for (const [host, method] of [[hosts[0], "password"], [hosts[1], "publickey"]]) {
    await evaluate(b, () => document.querySelector(".terminal-home-tab")?.click());
    await until("Connect to " + host.name, () => evaluate(b, (name) => {
      const row = [...document.querySelectorAll("tr")].find((item) => item.textContent.includes(name));
      const button = [...(row?.querySelectorAll("button") ?? [])].find((item) => item.textContent.trim() === "连接");
      if (!button) return false;
      button.click();
      return true;
    }, host.name));
    await until("Authenticate and open the SSH session", async () => {
      const state = await evaluate(b, (fingerprint) => {
        const modal = document.querySelector(".fingerprint-confirm-modal");
        if (modal) {
          if (!modal.textContent.includes(fingerprint)) throw new Error("Test SSH host key mismatch");
          [...modal.querySelectorAll("button")].find((button) => button.textContent.trim() === "信任并连接")?.click();
        }
        return !!document.querySelector(".terminal-status-connected") && !!document.querySelector(".xterm") &&
          document.body.innerText.includes("fineshell-smoke.txt");
      }, fixture.fingerprint);
      return fixture.counts[method] > 0 && state;
    });
    console.log("设备 B 使用同步过来的 " + method + " 登录，并读取了 SFTP 测试目录。");
  }

  const peer = await invoke(b, "host_sync_account");
  await click(setupA, "更换恢复密钥");
  const replacement = await readKey(setupA, "新恢复密钥");
  assert(replacement && replacement !== original, "Generated a distinct recovery key");
  await fill(setupA, { "粘贴新密钥以确认已保存": replacement });
  await click(setupA, "更换并撤销其他设备");
  await until("Device A completed key rotation", () => evaluate(setupA, () =>
    ![...document.querySelectorAll("label")].some((label) => label.textContent.trim() === "新恢复密钥")));
  await assert.rejects(invoke(b, "host_sync_devices", { accountId: peer.accountId }), /请重新登录/);
  const login = { server: address, email, password, register: false, boundAccount: peer.accountId };
  await assert.rejects(invoke(b, "host_sync_login", { ...login, recoveryKey: original }), /恢复密钥不正确/);
  await invoke(b, "host_sync_login", { ...login, recoveryKey: replacement });
  const devices = await invoke(b, "host_sync_devices", { accountId: peer.accountId });
  assert.equal(devices.length, 2);
  const { hosts: syncedHosts, keys, base } = await evaluate(b, configuration, null, true);
  const resumed = await invoke(b, "host_sync_exchange", {
    accountId: peer.accountId, base, configuration: { hosts: syncedHosts, keys, proxies: [] },
  });
  assert.equal(resumed.conflicts?.length ?? 0, 0);
  assert.ok(resumed.inspection?.revision, "Recovered device received a verified sync revision");
  assert.notEqual(resumed.base.wrappedKey.salt, base.wrappedKey.salt);
  console.log("旧恢复密钥失效，旧会话已撤销，设备 B 使用新密钥重新登录并继续同步。");
} finally {
  if (server?.listening) await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  await fixture?.close();
  await rm(directory, { recursive: true, force: true });
}
