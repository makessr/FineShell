import {
  updateCargoLockVersion,
  updateCargoPackageVersion,
  updateJsonVersion,
} from "../prepare-release";

const [version, publicKeyFile] = process.argv.slice(2);
if (!version || !publicKeyFile || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
  throw new Error("Use this candidate builder only on a disposable hosted runner.");
}

const packageFile = Bun.file("package.json");
const tauriFile = Bun.file("src-tauri/tauri.conf.json");
const cargoFile = Bun.file("src-tauri/Cargo.toml");
const lockFile = Bun.file("src-tauri/Cargo.lock");
const config = await tauriFile.json();
const previousVersion = config.version;
config.version = version;
config.bundle.createUpdaterArtifacts = false;
config.plugins.updater.pubkey = (await Bun.file(publicKeyFile).text()).trim();
if (!config.plugins.updater.pubkey) throw new Error("Missing rehearsal public key.");
config.plugins.updater.endpoints = [
  "https://github.com/makessr/ZhanDu/releases/latest/download/latest.json",
];

await Promise.all([
  Bun.write(packageFile, updateJsonVersion(await packageFile.text(), version)),
  Bun.write(tauriFile, JSON.stringify(config, null, 2) + "\n"),
  Bun.write(cargoFile, updateCargoPackageVersion(await cargoFile.text(), version)),
  Bun.write(lockFile, updateCargoLockVersion(await lockFile.text(), previousVersion, version)),
]);
