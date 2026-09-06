use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tracing::{info, warn};
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, ReadTxn, StateVector, Text, Transact, Update};

/// The authoritative Yjs document for one vault file (fully-qualified id is
/// `{baseRoom}:{docId}`), persisted to disk as a Yjs v1 full-state update.
pub(crate) struct RoomDoc {
    pub(crate) doc: Doc,
    pub(crate) path: PathBuf,
    version: Arc<AtomicU64>,
    last_written_version: Arc<AtomicU64>,
}

fn full_id_to_path(full_id: &str, data_dir: &Path) -> PathBuf {
    let (room, doc_id) = match full_id.split_once(':') {
        Some((r, d)) => (r, d),
        None => ("default", full_id),
    };

    let safe_room: String = room
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();

    let mut rel_path = PathBuf::new();
    let sanitized_doc = doc_id.replace('\\', "/");
    for part in sanitized_doc.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            continue;
        }
        let safe_part: String = part
            .chars()
            .map(|c| match c {
                ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
                _ => c,
            })
            .collect();
        rel_path.push(safe_part);
    }

    let file_name = match rel_path.file_name() {
        Some(name) => format!("{}.yjs", name.to_string_lossy()),
        None => "doc.yjs".to_string(),
    };
    rel_path.set_file_name(file_name);

    data_dir.join(safe_room).join("docs").join(rel_path)
}

fn full_id_to_dir_path(full_id: &str, data_dir: &Path) -> PathBuf {
    let (room, doc_id) = match full_id.split_once(':') {
        Some((r, d)) => (r, d),
        None => ("default", full_id),
    };

    let safe_room: String = room
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();

    let mut rel_path = PathBuf::new();
    let sanitized_doc = doc_id.replace('\\', "/");
    for part in sanitized_doc.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            continue;
        }
        let safe_part: String = part
            .chars()
            .map(|c| match c {
                ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
                _ => c,
            })
            .collect();
        rel_path.push(safe_part);
    }

    data_dir.join(safe_room).join("docs").join(rel_path)
}

fn binary_file_to_path(room_id: &str, raw_path: &str, data_dir: &Path) -> PathBuf {
    let safe_room: String = room_id
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();

    let mut rel_path = PathBuf::new();
    let sanitized = raw_path.replace('\\', "/");
    for part in sanitized.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            continue;
        }
        let safe_part: String = part
            .chars()
            .map(|c| match c {
                ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
                _ => c,
            })
            .collect();
        rel_path.push(safe_part);
    }
    data_dir.join(safe_room).join("files").join(rel_path)
}

fn count_files_recursive(dir: &Path) -> usize {
    let mut count = 0;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Ok(ft) = entry.file_type() {
                if ft.is_file() {
                    count += 1;
                } else if ft.is_dir() {
                    count += count_files_recursive(&entry.path());
                }
            }
        }
    }
    count
}

impl RoomDoc {
    fn load_or_create(full_id: &str, data_dir: &Path) -> Self {
        let path = full_id_to_path(full_id, data_dir);
        let doc = Doc::new();
        if path.exists() {
            match fs::read(&path) {
                Ok(bytes) if !bytes.is_empty() => match Update::decode_v1(&bytes) {
                    Ok(update) => {
                        doc.transact_mut().apply_update(update);
                        info!("loaded doc {full_id} from disk ({} bytes)", bytes.len());
                    }
                    Err(e) => warn!("failed to decode persisted update for {full_id}: {e}"),
                },
                Ok(_) => {}
                Err(e) => warn!("failed to read persistence file for {full_id}: {e}"),
            }
        }
        Self {
            doc,
            path,
            version: Arc::new(AtomicU64::new(0)),
            last_written_version: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Persist the full room state (diff against an empty state vector) asynchronously.
    fn persist(&self) {
        let v = self.version.fetch_add(1, Ordering::SeqCst);
        let txn = self.doc.transact();
        let snapshot = txn.encode_state_as_update_v1(&StateVector::default());
        drop(txn);

        let path = self.path.clone();
        let last_written = self.last_written_version.clone();
        let write_fn = move || {
            if v < last_written.load(Ordering::SeqCst) {
                return;
            }
            if let Some(parent) = path.parent() {
                if let Err(e) = fs::create_dir_all(parent) {
                    warn!("failed to create directory {}: {e}", parent.display());
                    return;
                }
            }
            let tmp_path = path.with_extension(format!("tmp.{}", Uuid::new_v4()));
            if let Err(e) = fs::write(&tmp_path, snapshot) {
                warn!("failed to write temp file {}: {e}", tmp_path.display());
                return;
            }
            if let Err(e) = fs::rename(&tmp_path, &path) {
                warn!("failed to rename temp file to {}: {e}", path.display());
                fs::remove_file(&tmp_path).ok();
                return;
            }
            last_written.fetch_max(v, Ordering::SeqCst);
        };

        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn_blocking(write_fn);
        } else {
            write_fn();
        }
    }

    /// Update the text content of the "content" YText type, persisting and returning the diff update.
    pub(crate) fn set_text_content(&self, new_text: &str) -> Vec<u8> {
        let text = self.doc.get_or_insert_text("content");
        let sv_before = self.doc.transact().state_vector();
        {
            let mut txn = self.doc.transact_mut();
            if text.get_string(&txn) == new_text {
                return Vec::new();
            }
            let current_len = text.len(&txn);
            if current_len > 0 {
                text.remove_range(&mut txn, 0, current_len);
            }
            text.push(&mut txn, new_text);
        }
        self.persist();
        self.diff_since(&sv_before)
    }

    /// Apply an incoming update, persisting the merged state.
    pub(crate) fn apply_update(&self, update_bytes: &[u8]) -> bool {
        match Update::decode_v1(update_bytes) {
            Ok(update) => {
                self.doc.transact_mut().apply_update(update);
                self.persist();
                true
            }
            Err(e) => {
                warn!("failed to decode update: {e}");
                false
            }
        }
    }

    /// Encode the difference between the client's state vector and our state.
    pub(crate) fn diff_since(&self, client_sv: &StateVector) -> Vec<u8> {
        let txn = self.doc.transact();
        txn.encode_diff_v1(client_sv)
    }

    /// Encode our current state vector (v1/lib0 format).
    pub(crate) fn state_vector_v1(&self) -> Vec<u8> {
        let txn = self.doc.transact();
        txn.state_vector().encode_v1()
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RoomInfo {
    pub id: String,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    #[serde(default)]
    pub description: String,
    #[serde(default, rename = "activePeers")]
    pub active_peers: usize,
    #[serde(default, rename = "docCount")]
    pub doc_count: usize,
}

fn load_or_init_rooms(data_dir: &Path) -> HashMap<String, RoomInfo> {
    let rooms_path = data_dir.join("rooms.json");
    if rooms_path.exists() {
        if let Ok(content) = fs::read_to_string(&rooms_path) {
            if let Ok(rooms) = serde_json::from_str::<Vec<RoomInfo>>(&content) {
                let mut map = HashMap::new();
                for r in rooms {
                    map.insert(r.id.clone(), r);
                }
                if !map.is_empty() {
                    return map;
                }
            }
        }
    }

    let mut map = HashMap::new();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    if let Ok(entries) = fs::read_dir(data_dir) {
        for entry in entries.flatten() {
            if let Ok(ft) = entry.file_type() {
                if ft.is_dir() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if !name.starts_with('.') && name != "test_data" {
                        map.insert(
                            name.clone(),
                            RoomInfo {
                                id: name,
                                created_at: now,
                                description: "Existing vault room".to_string(),
                                active_peers: 0,
                                doc_count: 0,
                            },
                        );
                    }
                }
            }
        }
    }

    if map.is_empty() {
        map.insert(
            "vault-a".to_string(),
            RoomInfo {
                id: "vault-a".to_string(),
                created_at: now,
                description: "Default vault room".to_string(),
                active_peers: 0,
                doc_count: 0,
            },
        );
    }

    save_rooms_to_disk(data_dir, &map);
    map
}

fn save_rooms_to_disk(data_dir: &Path, rooms: &HashMap<String, RoomInfo>) {
    let rooms_path = data_dir.join("rooms.json");
    let list: Vec<&RoomInfo> = rooms.values().collect();
    if let Ok(json) = serde_json::to_string_pretty(&list) {
        let tmp_path = rooms_path.with_extension(format!("tmp.{}", Uuid::new_v4()));
        if let Err(e) = fs::write(&tmp_path, json) {
            warn!("failed to write temp rooms file {}: {e}", tmp_path.display());
            return;
        }
        if let Err(e) = fs::rename(&tmp_path, &rooms_path) {
            warn!("failed to rename temp file to {}: {e}", rooms_path.display());
            fs::remove_file(&tmp_path).ok();
        }
    }
}

struct DocEntry {
    doc: Arc<Mutex<RoomDoc>>,
    /// Connection keys currently subscribed to this doc
    subscribers: Mutex<HashSet<u64>>,
}

struct PendingChunkUpload {
    path: String,
    binary: bool,
    total_size: usize,
    chunks: HashMap<usize, String>,
    updated_at: std::time::Instant,
}

/// Shared application state, safe to clone and pass across handlers.
#[derive(Clone)]
pub struct AppState {
    pub data_dir: Arc<PathBuf>,
    pub server_password: Arc<String>,
    pub admin_password: Arc<String>,
    pub(crate) registered_rooms: Arc<Mutex<HashMap<String, RoomInfo>>>,
    docs: Arc<Mutex<HashMap<String, DocEntry>>>,
    /// Per-connection outbound sender map keyed by unique connection key.
    pub(crate) connections: Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<Vec<u8>>>>>,
    /// Control connections per room_id: room_id -> HashMap<client_key, UnboundedSender<String>>
    pub(crate) control_rooms: Arc<Mutex<HashMap<String, HashMap<u64, mpsc::UnboundedSender<String>>>>>,
    /// Docs subscribed per connection: client_key -> HashSet<full_id>
    client_subscriptions: Arc<Mutex<HashMap<u64, HashSet<String>>>>,
    /// Awareness clocks per client & doc: client_key -> HashMap<full_id, HashMap<u32, u32>> (awareness_id -> last_clock)
    client_awareness_clocks: Arc<Mutex<HashMap<u64, HashMap<String, HashMap<u32, u32>>>>>,
    /// Latest awareness payload per doc & client: full_id -> HashMap<client_key, Vec<u8>>
    client_awareness_payloads: Arc<Mutex<HashMap<String, HashMap<u64, Vec<u8>>>>>,
    /// Pending chunked uploads with TTL: transfer_key -> PendingChunkUpload
    pending_chunks: Arc<Mutex<HashMap<String, PendingChunkUpload>>>,
}

impl AppState {
    pub fn new(data_dir: PathBuf, server_password: String, admin_password: String) -> Self {
        fs::create_dir_all(&data_dir).ok();
        let registered_rooms = load_or_init_rooms(&data_dir);
        Self {
            data_dir: Arc::new(data_dir),
            server_password: Arc::new(server_password),
            admin_password: Arc::new(admin_password),
            registered_rooms: Arc::new(Mutex::new(registered_rooms)),
            docs: Arc::new(Mutex::new(HashMap::new())),
            connections: Arc::new(Mutex::new(HashMap::new())),
            control_rooms: Arc::new(Mutex::new(HashMap::new())),
            client_subscriptions: Arc::new(Mutex::new(HashMap::new())),
            client_awareness_clocks: Arc::new(Mutex::new(HashMap::new())),
            client_awareness_payloads: Arc::new(Mutex::new(HashMap::new())),
            pending_chunks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Check if the provided password matches either the normal server password or admin password.
    pub fn verify_server_auth(&self, pass: &str) -> bool {
        if self.server_password.is_empty() {
            return true;
        }
        !pass.is_empty() && (pass == self.server_password.as_str() || pass == self.admin_password.as_str())
    }

    /// Check if the provided password matches the admin password.
    pub fn verify_admin_auth(&self, pass: &str) -> bool {
        !pass.is_empty() && pass == self.admin_password.as_str()
    }

    /// Check if a room exists in the server registry.
    pub async fn has_room(&self, room_id: &str) -> bool {
        let rooms = self.registered_rooms.lock().await;
        rooms.contains_key(room_id)
    }

    /// List all rooms with active stats.
    pub async fn list_rooms(&self) -> Vec<RoomInfo> {
        let rooms_guard = self.registered_rooms.lock().await;
        let control_guard = self.control_rooms.lock().await;
        let docs_guard = self.docs.lock().await;

        let mut list: Vec<RoomInfo> = Vec::new();
        for (id, info) in rooms_guard.iter() {
            let mut room = info.clone();
            
            // Count unique active clients in control channel
            let control_peers = control_guard.get(id).map(|m| m.len()).unwrap_or(0);
            
            // Count active doc subscribers for this room
            let mut doc_subscribers = HashSet::new();
            let mut doc_count = 0;
            let prefix = format!("{id}:");
            for (full_id, entry) in docs_guard.iter() {
                if full_id.starts_with(&prefix) {
                    doc_count += 1;
                    let subs = entry.subscribers.lock().await;
                    for s in subs.iter() {
                        doc_subscribers.insert(*s);
                    }
                }
            }

            // Count persistent documents on disk for this room
            let safe_room: String = id
                .chars()
                .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
                .collect();
            let docs_dir = self.data_dir.join(&safe_room).join("docs");
            let disk_doc_count = count_files_recursive(&docs_dir);

            room.active_peers = control_peers.max(doc_subscribers.len());
            room.doc_count = disk_doc_count.max(doc_count);
            list.push(room);
        }

        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }

    /// Create a new room in the server registry and initialize directory.
    pub async fn create_room(&self, room_id: &str, description: Option<String>) -> Result<RoomInfo, String> {
        let clean_id = room_id.trim();
        if clean_id.is_empty() {
            return Err("Room ID cannot be empty".to_string());
        }
        if clean_id.len() > 64 {
            return Err("Room ID cannot exceed 64 characters".to_string());
        }
        if clean_id == "." || clean_id == ".." || clean_id.starts_with('.') || clean_id.ends_with('.') {
            return Err("Room ID cannot be '.' or '..' or start/end with a dot".to_string());
        }
        if !clean_id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.') {
            return Err("Room ID can only contain letters, numbers, hyphens, underscores, and dots".to_string());
        }

        let mut rooms = self.registered_rooms.lock().await;
        if rooms.contains_key(clean_id) {
            return Err(format!("Room '{clean_id}' already exists"));
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let room_info = RoomInfo {
            id: clean_id.to_string(),
            created_at: now,
            description: description.unwrap_or_else(|| "Collaborative vault room".to_string()),
            active_peers: 0,
            doc_count: 0,
        };

        // Ensure room directories exist on disk
        let safe_room: String = clean_id
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        fs::create_dir_all(self.data_dir.join(&safe_room).join("docs")).ok();
        fs::create_dir_all(self.data_dir.join(&safe_room).join("files")).ok();

        rooms.insert(clean_id.to_string(), room_info.clone());
        save_rooms_to_disk(&self.data_dir, &rooms);
        info!("admin created room '{clean_id}'");
        Ok(room_info)
    }

    /// Delete a room from memory and disk.
    pub async fn delete_room(&self, room_id: &str) -> Result<(), String> {
        let mut rooms = self.registered_rooms.lock().await;
        if !rooms.contains_key(room_id) {
            return Err(format!("Room '{room_id}' not found"));
        }
        rooms.remove(room_id);
        save_rooms_to_disk(&self.data_dir, &rooms);
        drop(rooms);

        // 1. Notify and disconnect control room clients
        let mut control_rooms = self.control_rooms.lock().await;
        if let Some(room) = control_rooms.remove(room_id) {
            for (_, tx) in room {
                let _ = tx.send(r#"{"type":"room-deleted","message":"This room was deleted by an admin"}"#.to_string());
            }
        }
        drop(control_rooms);

        // 2. Remove all room docs from memory
        let prefix = format!("{room_id}:");
        let mut docs = self.docs.lock().await;
        let keys_to_remove: Vec<String> = docs.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
        for k in keys_to_remove {
            docs.remove(&k);
        }
        drop(docs);

        // 3. Remove physical room folder from disk
        let safe_room: String = room_id
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let room_dir = self.data_dir.join(safe_room);
        if room_dir.exists() {
            fs::remove_dir_all(&room_dir).ok();
        }

        // 4. Remove subscriptions for this room and close connection channels
        let client_keys_to_disconnect: Vec<u64> = {
            let mut client_subs = self.client_subscriptions.lock().await;
            let mut keys = Vec::new();
            for (key, subs) in client_subs.iter_mut() {
                subs.retain(|s| !s.starts_with(&prefix));
                if subs.is_empty() {
                    keys.push(*key);
                }
            }
            for k in &keys {
                client_subs.remove(k);
            }
            keys
        };

        {
            let mut conns = self.connections.lock().await;
            for key in client_keys_to_disconnect {
                conns.remove(&key);
            }
        }

        // 5. Clean up awareness payloads for this room
        {
            let mut map = self.client_awareness_payloads.lock().await;
            map.retain(|k, _| !k.starts_with(&prefix));
        }

        // 6. Clean up any pending chunk uploads for this room
        {
            let mut map = self.pending_chunks.lock().await;
            let chunk_prefix = format!("{room_id}:");
            map.retain(|k, _| !k.starts_with(&chunk_prefix));
        }

        info!("admin deleted room '{room_id}'");
        Ok(())
    }

    /// Register a subscriber (connection key) for a fully-qualified doc id.
    /// Returns the authoritative doc and the number of OTHER subscribers
    /// already present (peer count).
    pub async fn subscribe(&self, full_id: &str, client_key: u64) -> (Arc<Mutex<RoomDoc>>, usize) {
        {
            let mut client_subs = self.client_subscriptions.lock().await;
            client_subs.entry(client_key).or_default().insert(full_id.to_string());
        }
        let mut docs = self.docs.lock().await;
        let entry = docs.entry(full_id.to_string()).or_insert_with(|| {
            let room_doc = RoomDoc::load_or_create(full_id, &self.data_dir);
            DocEntry {
                doc: Arc::new(Mutex::new(room_doc)),
                subscribers: Mutex::new(HashSet::new()),
            }
        });
        let mut subs = entry.subscribers.lock().await;
        let peer_count = subs.len();
        subs.insert(client_key);
        (entry.doc.clone(), peer_count)
    }

    /// Remove a subscriber (connection key) from a doc and prune empty docs from RAM.
    pub async fn unsubscribe(&self, full_id: &str, client_key: u64) {
        {
            let mut client_subs = self.client_subscriptions.lock().await;
            if let Some(subs) = client_subs.get_mut(&client_key) {
                subs.remove(full_id);
            }
        }
        let mut docs = self.docs.lock().await;
        let should_remove = if let Some(entry) = docs.get(full_id) {
            let mut subs = entry.subscribers.lock().await;
            subs.remove(&client_key);
            subs.is_empty()
        } else {
            false
        };
        if should_remove {
            docs.remove(full_id);
        }
    }

    /// Unsubscribe a client from a doc and remove its awareness payload for that doc.
    pub async fn unsubscribe_doc(&self, full_id: &str, client_key: u64) {
        self.unsubscribe(full_id, client_key).await;
        let mut map = self.client_awareness_payloads.lock().await;
        if let Some(doc_map) = map.get_mut(full_id) {
            doc_map.remove(&client_key);
            if doc_map.is_empty() {
                map.remove(full_id);
            }
        }
    }

    /// Get the authoritative doc for a full id if it has been loaded.
    pub async fn get_doc(&self, full_id: &str) -> Option<Arc<Mutex<RoomDoc>>> {
        let docs = self.docs.lock().await;
        docs.get(full_id).map(|e| e.doc.clone())
    }

    /// List connection keys currently subscribed to this doc.
    pub async fn subscribers_of(&self, full_id: &str) -> Vec<u64> {
        let docs = self.docs.lock().await;
        if let Some(entry) = docs.get(full_id) {
            let subs = entry.subscribers.lock().await;
            subs.iter().copied().collect()
        } else {
            Vec::new()
        }
    }

    /// Register a connection's outbound channel.
    pub async fn register_connection(&self, key: u64, tx: mpsc::UnboundedSender<Vec<u8>>) {
        let mut conns = self.connections.lock().await;
        conns.insert(key, tx);
    }

    /// Unregister a connection's outbound channel.
    pub async fn unregister_connection(&self, key: u64) {
        let mut conns = self.connections.lock().await;
        conns.remove(&key);
    }

    /// Send a binary frame to a specific connection.
    pub async fn send_to(&self, key: u64, bytes: Vec<u8>) {
        let conns = self.connections.lock().await;
        if let Some(tx) = conns.get(&key) {
            let _ = tx.send(bytes);
        }
    }

    /// Send a binary frame to all subscribers of a doc except the sender with minimal allocations.
    pub async fn send_to_others(&self, full_id: &str, sender_key: u64, bytes: Vec<u8>) {
        let subscribers = self.subscribers_of(full_id).await;
        let recipients: Vec<u64> = subscribers.into_iter().filter(|&k| k != sender_key).collect();
        if recipients.is_empty() {
            return;
        }
        let conns = self.connections.lock().await;
        let last_idx = recipients.len() - 1;
        for (i, key) in recipients.into_iter().enumerate() {
            if let Some(tx) = conns.get(&key) {
                if i == last_idx {
                    let _ = tx.send(bytes);
                    return;
                } else {
                    let _ = tx.send(bytes.clone());
                }
            }
        }
    }

    /// Send a binary frame to all subscribers of a doc.
    pub async fn send_to_subscribers(&self, full_id: &str, bytes: Vec<u8>) {
        let subscribers = self.subscribers_of(full_id).await;
        if subscribers.is_empty() {
            return;
        }
        let conns = self.connections.lock().await;
        let last_idx = subscribers.len() - 1;
        for (i, key) in subscribers.into_iter().enumerate() {
            if let Some(tx) = conns.get(&key) {
                if i == last_idx {
                    let _ = tx.send(bytes);
                    return;
                } else {
                    let _ = tx.send(bytes.clone());
                }
            }
        }
    }

    /// Update the text content for a note document, persisting it and returning the diff update.
    pub async fn update_text_doc(&self, room_id: &str, raw_path: &str, new_text: &str) -> Vec<u8> {
        let full_id = format!("{room_id}:{raw_path}");
        let (doc, had_subscribers) = {
            let mut docs = self.docs.lock().await;
            let entry = docs.entry(full_id.clone()).or_insert_with(|| {
                let room_doc = RoomDoc::load_or_create(&full_id, &self.data_dir);
                DocEntry {
                    doc: Arc::new(Mutex::new(room_doc)),
                    subscribers: Mutex::new(HashSet::new()),
                }
            });
            let has_subs = !entry.subscribers.lock().await.is_empty();
            (entry.doc.clone(), has_subs)
        };

        let diff = {
            let room_doc = doc.lock().await;
            room_doc.set_text_content(new_text)
        };

        if !had_subscribers {
            let mut docs = self.docs.lock().await;
            if let Some(entry) = docs.get(&full_id) {
                if entry.subscribers.lock().await.is_empty() {
                    docs.remove(&full_id);
                }
            }
        }

        diff
    }

    /// Register a control channel connection.
    pub async fn register_control_client(&self, room_id: &str, key: u64, tx: mpsc::UnboundedSender<String>) {
        let mut rooms = self.control_rooms.lock().await;
        let room = rooms.entry(room_id.to_string()).or_default();
        room.insert(key, tx);
    }

    /// Unregister a control channel connection.
    pub async fn unregister_control_client(&self, room_id: &str, key: u64) {
        let mut rooms = self.control_rooms.lock().await;
        if let Some(room) = rooms.get_mut(room_id) {
            room.remove(&key);
            if room.is_empty() {
                rooms.remove(room_id);
            }
        }
    }

    /// Broadcast a control message string to all other clients in room_id with minimal allocations.
    pub async fn broadcast_control_msg(&self, room_id: &str, sender_key: u64, msg: String) {
        let rooms = self.control_rooms.lock().await;
        if let Some(room) = rooms.get(room_id) {
            let recipients: Vec<u64> = room.keys().copied().filter(|&k| k != sender_key).collect();
            if recipients.is_empty() {
                return;
            }
            let last_idx = recipients.len() - 1;
            for (i, key) in recipients.into_iter().enumerate() {
                if let Some(tx) = room.get(&key) {
                    if i == last_idx {
                        let _ = tx.send(msg);
                        return;
                    } else {
                        let _ = tx.send(msg.clone());
                    }
                }
            }
        }
    }

    /// Send a control message string directly to a specific client in room_id.
    pub async fn send_control_to(&self, room_id: &str, client_key: u64, msg: String) {
        let rooms = self.control_rooms.lock().await;
        if let Some(room) = rooms.get(room_id) {
            if let Some(tx) = room.get(&client_key) {
                let _ = tx.send(msg);
            }
        }
    }

    /// Record awareness client ID and clock for a connection and document.
    pub async fn record_awareness_client_clock(&self, client_key: u64, full_id: &str, awareness_id: u32, clock: u32) {
        let mut map = self.client_awareness_clocks.lock().await;
        map.entry(client_key)
            .or_default()
            .entry(full_id.to_string())
            .or_default()
            .insert(awareness_id, clock);
    }

    /// Take registered awareness client clocks for a specific document and connection.
    pub async fn take_awareness_client_clocks(&self, client_key: u64, full_id: &str) -> Vec<(u32, u32)> {
        let mut map = self.client_awareness_clocks.lock().await;
        if let Some(doc_map) = map.get_mut(&client_key) {
            if let Some(ids) = doc_map.remove(full_id) {
                return ids.into_iter().collect();
            }
        }
        Vec::new()
    }

    /// Take all registered awareness client clocks across all documents for a connection.
    pub async fn take_all_awareness_client_clocks(&self, client_key: u64) -> HashMap<String, Vec<(u32, u32)>> {
        let mut map = self.client_awareness_clocks.lock().await;
        if let Some(doc_map) = map.remove(&client_key) {
            doc_map
                .into_iter()
                .map(|(doc_id, set)| (doc_id, set.into_iter().collect()))
                .collect()
        } else {
            HashMap::new()
        }
    }

    /// Store the latest awareness payload for a client on a document.
    pub async fn store_awareness(&self, client_key: u64, full_id: &str, payload: Vec<u8>) {
        let mut map = self.client_awareness_payloads.lock().await;
        map.entry(full_id.to_string())
            .or_default()
            .insert(client_key, payload);
    }

    /// Retrieve all latest awareness payloads for a document from all clients.
    pub async fn get_all_awareness(&self, full_id: &str) -> Vec<Vec<u8>> {
        let map = self.client_awareness_payloads.lock().await;
        if let Some(doc_map) = map.get(full_id) {
            doc_map.values().cloned().collect()
        } else {
            Vec::new()
        }
    }

    /// Clean up awareness payloads when a client disconnects.
    pub async fn cleanup_awareness_payloads(&self, client_key: u64) {
        let mut map = self.client_awareness_payloads.lock().await;
        for doc_map in map.values_mut() {
            doc_map.remove(&client_key);
        }
    }

    /// Fully clean up a connection on disconnect:
    /// - Unsubscribes from all documents
    /// - Removes awareness payloads
    /// - Unregisters outbound sender
    /// - Returns all awareness client clocks for broadcasting removal
    pub async fn cleanup_connection(&self, client_key: u64) -> HashMap<String, Vec<(u32, u32)>> {
        // 1. Unsubscribe from all subscribed docs
        let subscribed_docs = {
            let mut subs = self.client_subscriptions.lock().await;
            subs.remove(&client_key).unwrap_or_default()
        };
        for full_id in subscribed_docs {
            self.unsubscribe(&full_id, client_key).await;
        }

        // 2. Clean up awareness payloads
        {
            let mut map = self.client_awareness_payloads.lock().await;
            for doc_map in map.values_mut() {
                doc_map.remove(&client_key);
            }
            map.retain(|_, doc_map| !doc_map.is_empty());
        }

        // 3. Unregister outbound channel
        {
            let mut conns = self.connections.lock().await;
            conns.remove(&client_key);
        }

        // 4. Take all awareness client clocks for broadcasting removal
        self.take_all_awareness_client_clocks(client_key).await
    }

    /// Save a binary file (e.g. image/attachment) to server disk atomically.
    pub fn save_binary_file(&self, room_id: &str, raw_path: &str, bytes: &[u8]) {
        let path = binary_file_to_path(room_id, raw_path, &self.data_dir);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).ok();
        }
        let tmp_path = path.with_extension(format!("tmp.{}", Uuid::new_v4()));
        if let Err(e) = fs::write(&tmp_path, bytes) {
            warn!("failed to write binary temp file {}: {e}", tmp_path.display());
            return;
        }
        if let Err(e) = fs::rename(&tmp_path, &path) {
            warn!("failed to rename binary temp file to {}: {e}", path.display());
            fs::remove_file(&tmp_path).ok();
        }
    }

    /// Record start of a chunked upload with 10-minute TTL cleanup.
    pub async fn start_chunk(&self, key: &str, path: &str, binary: bool, total_size: usize) {
        let mut map = self.pending_chunks.lock().await;
        let now = std::time::Instant::now();
        map.retain(|_, v| now.duration_since(v.updated_at).as_secs() < 600);
        map.insert(
            key.to_string(),
            PendingChunkUpload {
                path: path.to_string(),
                binary,
                total_size,
                chunks: HashMap::new(),
                updated_at: now,
            },
        );
    }

    /// Record a data chunk.
    pub async fn add_chunk(&self, key: &str, index: usize, data: String) {
        let mut map = self.pending_chunks.lock().await;
        if let Some(upload) = map.get_mut(key) {
            if data.len() <= 1024 * 1024 && upload.chunks.len() < 2000 {
                upload.chunks.insert(index, data);
                upload.updated_at = std::time::Instant::now();
            }
        }
    }

    /// Finish and assemble chunked upload, saving to disk and updating text doc if not binary.
    pub async fn finish_chunk(&self, room_id: &str, key: &str) -> Option<(String, bool, Vec<u8>)> {
        use base64::Engine;
        let upload = {
            let mut map = self.pending_chunks.lock().await;
            map.remove(key)
        };
        if let Some(upload) = upload {
            let mut indices: Vec<usize> = upload.chunks.keys().cloned().collect();
            indices.sort_unstable();
            if indices.is_empty() || indices[0] != 0 {
                warn!("chunk upload for {} missing chunk 0", upload.path);
                return None;
            }
            for i in 0..indices.len() {
                if indices[i] != i {
                    warn!("chunk upload for {} missing chunk index {i}", upload.path);
                    return None;
                }
            }
            let mut full_b64 = String::new();
            for idx in indices {
                if let Some(chunk) = upload.chunks.get(&idx) {
                    full_b64.push_str(chunk);
                }
            }
            if upload.total_size > 0 && full_b64.len() != upload.total_size {
                warn!(
                    "chunk upload for {} incomplete: expected {} bytes, got {}",
                    upload.path,
                    upload.total_size,
                    full_b64.len()
                );
                return None;
            }
            let mut update = Vec::new();
            if upload.binary {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&full_b64) {
                    self.save_binary_file(room_id, &upload.path, &bytes);
                }
            } else {
                self.save_binary_file(room_id, &upload.path, full_b64.as_bytes());
                update = self.update_text_doc(room_id, &upload.path, &full_b64).await;
            }
            Some((upload.path, upload.binary, update))
        } else {
            None
        }
    }

    /// Load a binary file from server disk.
    pub fn load_binary_file(&self, room_id: &str, raw_path: &str) -> Option<Vec<u8>> {
        let path = binary_file_to_path(room_id, raw_path, &self.data_dir);
        fs::read(&path).ok()
    }

    /// Delete a binary file or folder from server disk.
    pub fn delete_binary_file(&self, room_id: &str, raw_path: &str) {
        let path = binary_file_to_path(room_id, raw_path, &self.data_dir);
        if path.exists() {
            if path.is_dir() {
                fs::remove_dir_all(&path).ok();
            } else {
                fs::remove_file(&path).ok();
            }
        }
    }

    /// Rename a binary file on server disk.
    pub fn rename_binary_file(&self, room_id: &str, old_path: &str, new_path: &str) {
        let old_p = binary_file_to_path(room_id, old_path, &self.data_dir);
        let new_p = binary_file_to_path(room_id, new_path, &self.data_dir);
        if old_p.exists() {
            if let Some(parent) = new_p.parent() {
                fs::create_dir_all(parent).ok();
            }
            fs::rename(&old_p, &new_p).ok();
        }
    }

    /// Delete a Yjs document or directory from memory and disk.
    pub async fn delete_doc(&self, full_id: &str) {
        let prefix = format!("{full_id}/");
        let mut docs = self.docs.lock().await;
        if let Some(entry) = docs.remove(full_id) {
            let doc_guard = entry.doc.lock().await;
            if doc_guard.path.exists() {
                if doc_guard.path.is_dir() {
                    fs::remove_dir_all(&doc_guard.path).ok();
                } else {
                    fs::remove_file(&doc_guard.path).ok();
                }
            }
        } else {
            let path = full_id_to_path(full_id, &self.data_dir);
            if path.exists() {
                if path.is_dir() {
                    fs::remove_dir_all(&path).ok();
                } else {
                    fs::remove_file(&path).ok();
                }
            }
        }
        // Also remove any nested documents in RAM
        docs.retain(|k, _| !k.starts_with(&prefix));
        drop(docs);

        // Update client_subscriptions to remove deleted doc and nested docs
        {
            let mut client_subs = self.client_subscriptions.lock().await;
            for subs in client_subs.values_mut() {
                subs.remove(full_id);
                subs.retain(|s| !s.starts_with(&prefix));
            }
        }

        // Clean up client_awareness_payloads for deleted doc and nested docs
        {
            let mut map = self.client_awareness_payloads.lock().await;
            map.remove(full_id);
            map.retain(|k, _| !k.starts_with(&prefix));
        }

        // Also remove directory on disk if it was a folder
        let dir_path = full_id_to_dir_path(full_id, &self.data_dir);
        if dir_path.exists() && dir_path.is_dir() {
            fs::remove_dir_all(&dir_path).ok();
        }
    }

    /// Rename a Yjs document in memory and disk.
    pub async fn rename_doc(&self, old_full_id: &str, new_full_id: &str) {
        let old_prefix = format!("{old_full_id}/");
        let new_prefix = format!("{new_full_id}/");

        let mut docs = self.docs.lock().await;
        
        // Preserve any subscribers if an early MUX_SUBSCRIBE created a temporary entry
        let mut target_subs = HashSet::new();
        if let Some(entry) = docs.remove(new_full_id) {
            let doc_guard = entry.doc.lock().await;
            fs::remove_file(&doc_guard.path).ok();
            let subs = entry.subscribers.lock().await;
            target_subs.extend(subs.iter().copied());
        } else {
            let path = full_id_to_path(new_full_id, &self.data_dir);
            fs::remove_file(&path).ok();
        }

        if let Some(entry) = docs.remove(old_full_id) {
            let mut doc_guard = entry.doc.lock().await;
            let new_path = full_id_to_path(new_full_id, &self.data_dir);
            if doc_guard.path.exists() {
                if let Some(parent) = new_path.parent() {
                    fs::create_dir_all(parent).ok();
                }
                fs::rename(&doc_guard.path, &new_path).ok();
            }
            doc_guard.path = new_path;
            drop(doc_guard);

            // Merge any early subscribers into the renamed doc entry
            if !target_subs.is_empty() {
                let mut subs = entry.subscribers.lock().await;
                for s in target_subs {
                    subs.insert(s);
                }
            }

            docs.insert(new_full_id.to_string(), entry);
        } else {
            let old_path = full_id_to_path(old_full_id, &self.data_dir);
            let new_path = full_id_to_path(new_full_id, &self.data_dir);
            if old_path.exists() {
                if let Some(parent) = new_path.parent() {
                    fs::create_dir_all(parent).ok();
                }
                fs::rename(&old_path, &new_path).ok();
            }
        }

        // Also rename any nested documents in RAM
        let matching_nested: Vec<String> = docs
            .keys()
            .filter(|k| k.starts_with(&old_prefix))
            .cloned()
            .collect();
        for old_k in matching_nested {
            if let Some(entry) = docs.remove(&old_k) {
                let suffix = &old_k[old_prefix.len()..];
                let new_k = format!("{new_prefix}{suffix}");
                let mut doc_guard = entry.doc.lock().await;
                let new_path = full_id_to_path(&new_k, &self.data_dir);
                doc_guard.path = new_path;
                drop(doc_guard);
                docs.insert(new_k, entry);
            }
        }
        drop(docs);

        // Update client_subscriptions for renamed doc and any nested docs
        {
            let mut client_subs = self.client_subscriptions.lock().await;
            for subs in client_subs.values_mut() {
                if subs.remove(old_full_id) {
                    subs.insert(new_full_id.to_string());
                }
                let to_replace: Vec<String> = subs.iter().filter(|s| s.starts_with(&old_prefix)).cloned().collect();
                for s in to_replace {
                    subs.remove(&s);
                    subs.insert(format!("{new_prefix}{}", &s[old_prefix.len()..]));
                }
            }
        }

        // Migrate client_awareness_payloads for renamed doc and nested docs
        {
            let mut map = self.client_awareness_payloads.lock().await;
            if let Some(payloads) = map.remove(old_full_id) {
                map.entry(new_full_id.to_string()).or_default().extend(payloads);
            }
            let matching_nested: Vec<String> = map
                .keys()
                .filter(|k| k.starts_with(&old_prefix))
                .cloned()
                .collect();
            for old_k in matching_nested {
                if let Some(payloads) = map.remove(&old_k) {
                    let suffix = &old_k[old_prefix.len()..];
                    let new_k = format!("{new_prefix}{suffix}");
                    map.entry(new_k).or_default().extend(payloads);
                }
            }
        }

        // Also rename directory on disk if it was a folder
        let old_dir = full_id_to_dir_path(old_full_id, &self.data_dir);
        let new_dir = full_id_to_dir_path(new_full_id, &self.data_dir);
        if old_dir.exists() && old_dir.is_dir() {
            if let Some(parent) = new_dir.parent() {
                fs::create_dir_all(parent).ok();
            }
            fs::rename(&old_dir, &new_dir).ok();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_full_id_with_colons_and_subdirs_to_safe_path() {
        let data = Path::new("./test_data");
        let path = full_id_to_path("vault-a:folder/sub:folder/note?.md", data);
        assert!(path.to_str().unwrap().contains("vault-a"));
        assert!(!path.file_name().unwrap().to_str().unwrap().contains(':'));
        assert!(!path.file_name().unwrap().to_str().unwrap().contains('?'));
    }

    #[test]
    fn room_doc_persists_and_reloads_subdirs() {
        let dir = std::env::temp_dir().join(format!("collab_test_{}", std::process::id()));
        let full_id = "room1:notes/daily/2026-08-08.md";
        let doc1 = RoomDoc::load_or_create(full_id, &dir);
        doc1.persist();
        assert!(doc1.path.exists());

        let doc2 = RoomDoc::load_or_create(full_id, &dir);
        assert_eq!(doc1.path, doc2.path);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn auth_and_room_management() {
        let dir = std::env::temp_dir().join(format!("collab_test_auth_{}", std::process::id()));
        let state = AppState::new(dir.clone(), "userpass123".to_string(), "adminpass456".to_string());

        // Auth checks
        assert!(state.verify_server_auth("userpass123"));
        assert!(state.verify_server_auth("adminpass456"));
        assert!(!state.verify_server_auth("wrongpass"));
        assert!(!state.verify_server_auth(""));

        assert!(state.verify_admin_auth("adminpass456"));
        assert!(!state.verify_admin_auth("userpass123"));
        assert!(!state.verify_admin_auth("wrongpass"));

        // Default room exists
        assert!(state.has_room("vault-a").await);
        assert!(!state.has_room("nonexistent").await);

        // Admin create room
        let new_room = state.create_room("project-alpha", Some("Alpha vault".into())).await;
        assert!(new_room.is_ok());
        assert!(state.has_room("project-alpha").await);

        // Duplicate room fails
        let dup = state.create_room("project-alpha", None).await;
        assert!(dup.is_err());

        // Invalid room ID fails
        let invalid = state.create_room("bad name with spaces!", None).await;
        assert!(invalid.is_err());

        // List rooms
        let rooms = state.list_rooms().await;
        assert!(rooms.iter().any(|r| r.id == "vault-a"));
        assert!(rooms.iter().any(|r| r.id == "project-alpha"));

        // Delete room
        let del = state.delete_room("project-alpha").await;
        assert!(del.is_ok());
        assert!(!state.has_room("project-alpha").await);

        let _ = fs::remove_dir_all(&dir);
    }
}