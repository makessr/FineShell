use std::{collections::BTreeMap, time::Duration};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use reqwest::{Client, Method, StatusCode, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    cloud_backup::{
        crypto::{decrypt_payload, encrypt_payload, generate_recovery_key, random_master_key, unwrap_master_key, wrap_master_key},
        types::WrappedMasterKey,
    },
    credentials::{delete_backup_credential, read_backup_credential, restore_backup_credential},
    managed_keys::{install_sync_key, read_sync_key},
    protocol::{CommandError, CommandResult},
};

const SERVICE: &str = "com.fineshell.app.host-sync";
const MAX_RESPONSE: usize = 8 * 1024 * 1024 + 4096;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Login {
    account_id: String,
    token: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Vault {
    version: u8,
    wrapped_key: WrappedMasterKey,
    nonce: String,
    ciphertext: String,
}

#[derive(Deserialize)]
struct RemoteVault {
    revision: u64,
    vault: Option<Vault>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    server: String,
    email: String,
    account_id: String,
    token: String,
    key: [u8; 32],
    wrapped_key: WrappedMasterKey,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Account {
    server: String,
    email: String,
    account_id: String,
}

impl Device {
    fn account(&self) -> Account {
        Account {
            server: self.server.clone(),
            email: self.email.clone(),
            account_id: self.account_id.clone(),
        }
    }
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Record {
    metadata: Value,
    secret: Option<String>,
    private_key: Option<String>,
}

#[derive(Deserialize, Serialize, Default, PartialEq, Eq)]
struct Records {
    hosts: BTreeMap<String, Record>,
    keys: BTreeMap<String, Record>,
    proxies: BTreeMap<String, Record>,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct Configuration {
    hosts: Vec<Value>,
    keys: Vec<Value>,
    proxies: Vec<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialStatus {
    kind: &'static str,
    owner_id: String,
    exists: bool,
}

#[derive(Serialize)]
pub(crate) struct AppliedConfiguration {
    #[serde(flatten)]
    configuration: Configuration,
    credentials: Vec<CredentialStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncResult {
    base: Vault,
    expected_local: Option<Vault>,
}

fn error(operation: &'static str, message: impl Into<String>) -> CommandError {
    CommandError::from_message(operation, message.into())
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, "device").map_err(|e| format!("无法访问系统凭据库：{e}"))
}

fn load_device() -> Result<Option<Device>, String> {
    match entry()?.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| "同步登录信息无效".to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("无法读取同步登录信息：{e}")),
    }
}

fn require_device(account_id: &str) -> Result<Device, String> {
    load_device()?
        .filter(|device| device.account_id == account_id)
        .ok_or_else(|| "请先登录 FineShell 账号".to_string())
}

fn server_url(input: &str) -> Result<String, String> {
    let url = Url::parse(input.trim()).map_err(|_| "同步服务地址无效")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.host_str().is_none()
        || !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("请输入 HTTPS 同步服务地址，本机开发可用 HTTP".to_string());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

async fn request<T: DeserializeOwned>(
    server: &str,
    method: Method,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> Result<T, String> {
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "无法初始化同步客户端")?;
    let mut request = client.request(method, format!("{server}/v1/{path}"));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let mut response = request.send().await.map_err(|_| "同步服务连接失败")?;
    match response.status() {
        StatusCode::OK => {}
        StatusCode::UNAUTHORIZED => return Err("账号、密码或登录状态无效，请重新登录".into()),
        StatusCode::CONFLICT => return Err("资源发生冲突，请重试或检查账号是否已注册".into()),
        StatusCode::TOO_MANY_REQUESTS => return Err("请求过于频繁，请稍后再试".into()),
        status => return Err(format!("同步服务返回 HTTP {status}")),
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取同步响应失败")? {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err("同步数据超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "同步服务响应无效".into())
}

fn seal(device: &Device, revision: u64, records: &Records) -> Result<Vault, String> {
    // Bind the encrypted content to this protocol and account.
    let bytes = serde_json::to_vec(&("fineshell-host-sync-v1", &device.account_id, revision, records))
        .map_err(|_| "无法编码主机数据")?;
    let (nonce, ciphertext) = encrypt_payload(&device.key, &bytes)?;
    Ok(Vault {
        version: 1,
        wrapped_key: device.wrapped_key.clone(),
        nonce,
        ciphertext,
    })
}

fn open(device: &Device, vault: &Vault) -> Result<(u64, Records), String> {
    if vault.version != 1 {
        return Err("主机同步数据版本不受支持".into());
    }
    let bytes = decrypt_payload(&device.key, &vault.nonce, &vault.ciphertext)
        .map_err(|_| "无法解密同步数据，请重新登录并检查恢复密钥")?;
    let (format, account, revision, records): (String, String, u64, Records) =
        serde_json::from_slice(&bytes).map_err(|_| "主机同步数据无效")?;
    if format != "fineshell-host-sync-v1" || account != device.account_id {
        return Err("同步数据账号不匹配".into());
    }
    Ok((revision, records))
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    value[name]
        .as_str()
        .filter(|part| !part.is_empty())
        .ok_or_else(|| format!("同步记录缺少字段 {name}"))
}

fn insert_records(
    values: Vec<Value>,
    mut build: impl FnMut(Value, &str) -> Result<Record, String>,
) -> Result<BTreeMap<String, Record>, String> {
    values.into_iter().map(|value| {
        let id = field(&value, "id")?.to_string();
        let record = build(value, &id)?;
        Ok((id, record))
    }).collect()
}

fn portable_key(metadata: &mut Value) -> Result<String, String> {
    let key = read_sync_key(field(metadata, "privateKeyPath")?)?;
    metadata.as_object_mut().ok_or("SSH 密钥配置无效")?.remove("privateKeyPath");
    Ok(key)
}

fn capture(configuration: Configuration) -> Result<Records, String> {
    let hosts = insert_records(configuration.hosts, |mut metadata, id| {
        let fields = metadata.as_object_mut().ok_or("主机配置无效")?;
        fields.remove("lastConnectedAt");
        fields.remove("hostFingerprint");
        let (secret, private_key) = match field(&metadata, "authMethod")? {
            "password" => (read_backup_credential("hostPassword", id)?, None),
            "privateKey" if metadata["sshKeyId"].is_null() => (
                read_backup_credential("privateKeyPassphrase", id)?,
                Some(portable_key(&mut metadata)?),
            ),
            "privateKey" | "agent" => (None, None),
            _ => return Err("不支持的 SSH 认证类型".into()),
        };
        Ok(Record { metadata, secret, private_key })
    })?;
    let keys = insert_records(configuration.keys, |mut metadata, id| {
        let private_key = Some(portable_key(&mut metadata)?);
        metadata.as_object_mut().ok_or("SSH 密钥配置无效")?.remove("source");
        Ok(Record {
            metadata,
            secret: read_backup_credential("privateKeyPassphrase", id)?,
            private_key,
        })
    })?;
    let proxies = insert_records(configuration.proxies, |metadata, id| {
        Ok(Record {
            metadata,
            secret: read_backup_credential("proxyPassword", id)?,
            private_key: None,
        })
    })?;
    Ok(Records { hosts, keys, proxies })
}

fn validate_links(records: &Records) -> Result<(), String> {
    for (id, host) in &records.hosts {
        if let Some(key_id) = host.metadata["sshKeyId"].as_str() {
            if !records.keys.contains_key(key_id) {
                return Err("同步后的主机缺少关联的 SSH 密钥".into());
            }
        }
        if let Some(proxy_id) = host.metadata["proxyId"].as_str() {
            if !records.proxies.contains_key(proxy_id) {
                return Err("同步后的主机缺少关联的代理".into());
            }
        }
        if let Some(jump_id) = host.metadata["jumpHostId"].as_str() {
            let jump = records.hosts.get(jump_id).ok_or("同步后的主机缺少关联的跳板机")?;
            if id == jump_id || !jump.metadata["jumpHostId"].is_null() {
                return Err("同步后的跳板机设置不支持多级引用".into());
            }
        }
    }
    Ok(())
}

fn merge_map(
    base: &BTreeMap<String, Record>,
    local: BTreeMap<String, Record>,
    cloud: &BTreeMap<String, Record>,
    keep_local: Option<bool>,
) -> Result<BTreeMap<String, Record>, String> {
    let mut merged = BTreeMap::new();
    let ids: std::collections::BTreeSet<_> =
        base.keys().chain(local.keys()).chain(cloud.keys()).collect();
    for id in ids {
        let previous = base.get(id);
        let here = local.get(id);
        let there = cloud.get(id);
        let resolved = if here == there || there == previous {
            here
        } else if here == previous {
            there
        } else if let Some(local_wins) = keep_local {
            if local_wins { here } else { there }
        } else {
            return Err("同步冲突：两台设备修改了同一项，请在主机同步设置中选择保留哪一方".into());
        };
        if let Some(record) = resolved {
            merged.insert(id.clone(), Record {
                metadata: record.metadata.clone(),
                secret: record.secret.clone(),
                private_key: record.private_key.clone(),
            });
        }
    }
    Ok(merged)
}

fn put_secret(kind: &str, id: &str, secret: Option<&str>) -> Result<(), String> {
    if read_backup_credential(kind, id)?.as_deref() == secret {
        return Ok(());
    }
    match secret {
        Some(secret) => restore_backup_credential(kind, id, secret),
        None => delete_backup_credential(kind, id),
    }
}

fn install_key(
    key: &str,
    old: Option<&Value>,
    stable_id: Option<&str>,
) -> Result<String, String> {
    if let Some(path) = old.and_then(|value| value["privateKeyPath"].as_str()) {
        if read_sync_key(path).is_ok_and(|contents| contents == key) {
            return Ok(path.to_string());
        }
    }
    let id = stable_id.map(str::to_owned)
        .unwrap_or_else(|| format!("sync-{}", URL_SAFE_NO_PAD.encode(random_master_key())));
    install_sync_key(&id, key)
}

fn apply_records(records: Records, current: Configuration) -> Result<AppliedConfiguration, String> {
    validate_links(&records)?;
    let old_hosts = current.hosts.iter().filter_map(|host| Some((host["id"].as_str()?, host))).collect::<BTreeMap<_, _>>();
    let old_keys = current.keys.iter().filter_map(|key| Some((key["id"].as_str()?, key))).collect::<BTreeMap<_, _>>();
    let mut result = Configuration { hosts: Vec::new(), keys: Vec::new(), proxies: Vec::new() };

    // Install key files before changing any keyring entries.
    let mut pending_secrets = Vec::new();
    for (id, mut record) in records.keys {
        let old = old_keys.get(id.as_str()).copied();
        if let Some(key) = &record.private_key {
            let path = install_key(key, old, Some(&id))?;
            record.metadata["source"] = json!(if path.starts_with("managed://") { "managed" } else { "file" });
            record.metadata["privateKeyPath"] = json!(path);
        }
        pending_secrets.push(("privateKeyPassphrase", id, record.secret));
        result.keys.push(record.metadata);
    }
    for (id, record) in records.proxies {
        pending_secrets.push(("proxyPassword", id, record.secret));
        result.proxies.push(record.metadata);
    }
    for (id, mut record) in records.hosts {
        let old = old_hosts.get(id.as_str()).copied();
        if let Some(key) = &record.private_key {
            record.metadata["privateKeyPath"] = json!(install_key(key, old, None)?);
            pending_secrets.push(("privateKeyPassphrase", id, record.secret));
        } else if record.metadata["authMethod"] == "password" {
            pending_secrets.push(("hostPassword", id, record.secret));
        }
        result.hosts.push(record.metadata);
    }
    let mut undo = Vec::new();
    let mut credentials = Vec::new();
    for (kind, id, secret) in pending_secrets {
        let outcome = (|| {
            let previous = read_backup_credential(kind, &id)?;
            put_secret(kind, &id, secret.as_deref())?;
            Ok::<_, String>(previous)
        })();
        match outcome {
            Ok(previous) => {
                credentials.push(CredentialStatus {
                    kind,
                    owner_id: id.clone(),
                    exists: secret.is_some(),
                });
                undo.push((kind, id, previous));
            }
            Err(failure) => {
                for (kind, id, previous) in undo.into_iter().rev() {
                    if put_secret(kind, &id, previous.as_deref()).is_err() {
                        return Err(format!("{failure}；部分系统凭据无法恢复，请重试同步"));
                    }
                }
                return Err(failure);
            }
        }
    }
    Ok(AppliedConfiguration { configuration: result, credentials })
}

#[tauri::command]
pub(crate) fn host_sync_recovery_key() -> String {
    generate_recovery_key()
}

#[tauri::command]
pub(crate) fn host_sync_account() -> CommandResult<Option<Account>> {
    load_device().map(|device| device.map(|device| device.account()))
        .map_err(|e| error("host_sync_account", e))
}

#[tauri::command]
pub(crate) async fn host_sync_login(
    server: String, email: String, password: String, recovery_key: String, register: bool,
    bound_account: Option<String>,
) -> CommandResult<Account> {
    let result = async {
        let server = server_url(&server)?;
        let email = email.trim().to_ascii_lowercase();
        if password == recovery_key {
            return Err("账号密码和恢复密钥必须不同".into());
        }
        let normalized: String = recovery_key.chars().filter(|ch| *ch != '-' && !ch.is_ascii_whitespace()).collect();
        if normalized.len() != 64 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("请输入完整的 64 位十六进制恢复密钥".into());
        }
        if register && bound_account.is_some() {
            return Err("此 FineShell 配置已绑定同步账号".into());
        }
        let path = if register { "register" } else { "login" };
        let login: Login = request(&server, Method::POST, path, None, Some(json!({ "email": email, "password": password }))).await?;
        if bound_account.as_ref().is_some_and(|id| id != &login.account_id) {
            return Err("此 FineShell 配置已绑定另一个同步账号".into());
        }
        let remote: RemoteVault = request(&server, Method::GET, "vault", Some(&login.token), None).await?;
        let (key, wrapped_key) = if let Some(vault) = &remote.vault {
            if vault.version != 1 || vault.wrapped_key.algorithm != "XChaCha20-Poly1305"
                || vault.wrapped_key.kdf != "Argon2id"
            {
                return Err("同步仓库版本不受支持".into());
            }
            let key = unwrap_master_key(&vault.wrapped_key, &recovery_key, true)
                .map_err(|_| "恢复密钥不正确")?;
            (key, vault.wrapped_key.clone())
        } else {
            if bound_account.is_some() {
                return Err("已绑定账号的同步仓库不存在，请检查同步服务".into());
            }
            let key = random_master_key();
            let wrapped = wrap_master_key(&key, &recovery_key, true)?;
            (key, wrapped)
        };
        let device = Device { server, email, account_id: login.account_id, token: login.token, key, wrapped_key };
        // Establish the recovery key before another device can initialize the same account.
        if let Some(vault) = &remote.vault {
            if open(&device, vault)?.0 != remote.revision {
                return Err("云端同步版本异常".into());
            }
        } else if remote.revision == 0 {
            let vault = seal(&device, 1, &Records::default())?;
            request::<Value>(&device.server, Method::PUT, "vault", Some(&device.token), Some(json!({ "revision": 0, "vault": vault }))).await?;
        } else {
            return Err("云端同步仓库数据不完整".into());
        }
        let encoded = serde_json::to_string(&device).map_err(|_| "无法保存同步登录信息")?;
        entry()?.set_password(&encoded).map_err(|_| "无法保存同步登录信息到系统凭据库")?;
        Ok(device.account())
    }.await;
    result.map_err(|e: String| error("host_sync_login", e))
}

#[tauri::command]
pub(crate) async fn host_sync_logout() -> CommandResult<()> {
    let result = async {
        if let Some(device) = load_device()? {
            // Clear device credentials even when the service is offline.
            entry()?.delete_credential().map_err(|_| "无法清除同步登录信息")?;
            let _ = request::<Value>(&device.server, Method::POST, "logout", Some(&device.token), None).await;
        }
        Ok(())
    }.await;
    result.map_err(|e: String| error("host_sync_logout", e))
}

#[tauri::command]
pub(crate) async fn host_sync_exchange(
    account_id: String, configuration: Configuration, base: Option<Vault>, keep_local: Option<bool>,
) -> CommandResult<SyncResult> {
    let result = async {
        let device = require_device(&account_id)?;
        let local = capture(configuration)?;
        let RemoteVault { revision, vault } =
            request(&device.server, Method::GET, "vault", Some(&device.token), None).await?;
        let vault = vault.ok_or("同步账号尚未初始化")?;
        let (signed_revision, cloud) = open(&device, &vault)?;
        let (previous_revision, previous) = base.as_ref().map(|vault| open(&device, vault))
            .transpose()?.unwrap_or_default();
        if signed_revision != revision || revision < previous_revision
            || (revision == previous_revision && previous != cloud)
        {
            return Err("云端同步版本异常，请检查同步服务的数据".into());
        }
        let expected_local = (previous != cloud)
            .then(|| seal(&device, revision, &local)).transpose()?;
        let Records { hosts, keys, proxies } = local;
        let combined = Records {
            hosts: merge_map(&previous.hosts, hosts, &cloud.hosts, keep_local)?,
            keys: merge_map(&previous.keys, keys, &cloud.keys, keep_local)?,
            proxies: merge_map(&previous.proxies, proxies, &cloud.proxies, keep_local)?,
        };
        validate_links(&combined)?;
        let base = if combined == cloud {
            vault
        } else {
            let vault = seal(&device, revision.checked_add(1).ok_or("同步版本超出范围")?, &combined)?;
            request::<Value>(&device.server, Method::PUT, "vault", Some(&device.token), Some(json!({ "revision": revision, "vault": vault }))).await?;
            vault
        };
        Ok(SyncResult { base, expected_local })
    }.await;
    result.map_err(|e: String| error("host_sync_exchange", e))
}

#[tauri::command]
pub(crate) fn host_sync_apply(
    account_id: String, vault: Vault, expected_local: Vault, configuration: Configuration,
) -> CommandResult<AppliedConfiguration> {
    (|| {
        let device = require_device(&account_id)?;
        let (_, records) = open(&device, &vault)?;
        if open(&device, &expected_local)?.1 != capture(Configuration {
            hosts: configuration.hosts.clone(),
            keys: configuration.keys.clone(),
            proxies: configuration.proxies.clone(),
        })? {
            return Err("本机 SSH 凭据刚发生变化，将在下一次同步时重试".into());
        }
        apply_records(records, configuration)
    })().map_err(|e| error("host_sync_apply", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(name: &str) -> (String, Record) {
        ("host".into(), Record {
            metadata: json!({ "id": "host", "name": name }),
            secret: None,
            private_key: None,
        })
    }

    #[test]
    fn merges_remote_delete_and_detects_concurrent_edits() {
        let base = BTreeMap::from([host("original")]);
        let cloud = BTreeMap::new();
        let removed = merge_map(&base, BTreeMap::from([host("original")]), &cloud, None).unwrap();
        assert!(removed.is_empty());
        assert!(merge_map(&base, BTreeMap::from([host("edited")]), &cloud, None).is_err());
        let kept = merge_map(&base, BTreeMap::from([host("edited")]), &cloud, Some(true)).unwrap();
        assert_eq!(kept["host"].metadata["name"], "edited");
    }

    #[test]
    fn vault_binds_revision_and_account() {
        let recovery = generate_recovery_key();
        let key = random_master_key();
        let mut device = Device {
            server: "http://localhost".into(),
            email: "test@example.com".into(),
            account_id: "first".into(),
            token: String::new(),
            key,
            wrapped_key: wrap_master_key(&key, &recovery, true).unwrap(),
        };
        let vault = seal(&device, 17, &Records::default()).unwrap();
        assert_eq!(open(&device, &vault).unwrap().0, 17);
        device.account_id = "second".into();
        assert!(open(&device, &vault).is_err());
    }
}
