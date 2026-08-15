use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tracing::{info, warn};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

/// The authoritative Yjs document for one vault file (fully-qualified id is
/// `{baseRoom}:{docId}`), persisted to disk as a Yjs v1 full-state update.
pub(crate) struct RoomDoc {
    pub(crate) doc: Doc,
    pub(crate) path: PathBuf,
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
        Self { doc, path }
    }

    /// Persist the full room state (diff against an empty state vector).
    fn persist(&self) {
        if let Some(parent) = self.path.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                warn!("failed to create directory {}: {e}", parent.display());
                return;
            }
        }
        let txn = self.doc.transact();
        let snapshot = txn.encode_state_as_update_v1(&StateVector::default());
        drop(txn);
        if let Err(e) = fs::write(&self.path, snapshot) {
            warn!("failed to persist {}: {e}", self.path.display());
        }
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
        fs::write(rooms_path, json).ok();
    }
}

struct DocEntry {
    doc: Arc<Mutex<RoomDoc>>,
    /// Connection keys currently subscribed to this doc
    subscribers: Mutex<HashSet<u64>>,
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
    /// Awareness IDs per client & doc: client_key -> HashMap<full_id, HashSet<u32>>
    client_awareness_ids: Arc<Mutex<HashMap<u64, HashMap<String, HashSet<u32>>>>>,
    /// Latest awareness payload per doc & client: full_id -> HashMap<client_key, Vec<u8>>
    client_awareness_payloads: Arc<Mutex<HashMap<String, HashMap<u64, Vec<u8>>>>>,
    /// Pending chunked uploads: transfer_key -> (path, binary, chunks_map)
    pending_chunks: Arc<Mutex<HashMap<String, (String, bool, HashMap<usize, String>)>>>,
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
            client_awareness_ids: Arc::new(Mutex::new(HashMap::new())),
            client_awareness_payloads: Arc::new(Mutex::new(HashMap::new())),
            pending_chunks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Check if the provided password matches either the normal server password or admin password.
    pub fn verify_server_auth(&self, pass: &str) -> bool {
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

            room.active_peers = control_peers.max(doc_subscribers.len());
            room.doc_count = doc_count;
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

        info!("admin deleted room '{room_id}'");
        Ok(())
    }

    /// Register a subscriber (connection key) for a fully-qualified doc id.
    /// Returns the authoritative doc and the number of OTHER subscribers
    /// already present (peer count).
    pub async fn subscribe(&self, full_id: &str, client_key: u64) -> (Arc<Mutex<RoomDoc>>, usize) {
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

    /// Record awareness client ID for a connection and document.
    pub async fn add_awareness_client_id(&self, client_key: u64, full_id: &str, awareness_id: u32) {
        let mut map = self.client_awareness_ids.lock().await;
        map.entry(client_key)
            .or_default()
            .entry(full_id.to_string())
            .or_default()
            .insert(awareness_id);
    }

    /// Take registered awareness client IDs for a specific document and connection.
    pub async fn take_awareness_client_ids(&self, client_key: u64, full_id: &str) -> Vec<u32> {
        let mut map = self.client_awareness_ids.lock().await;
        if let Some(doc_map) = map.get_mut(&client_key) {
            if let Some(ids) = doc_map.remove(full_id) {
                return ids.into_iter().collect();
            }
        }
        Vec::new()
    }

    /// Take all registered awareness client IDs across all documents for a connection.
    pub async fn take_all_awareness_client_ids(&self, client_key: u64) -> HashMap<String, Vec<u32>> {
        let mut map = self.client_awareness_ids.lock().await;
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

    /// Save a binary file (e.g. image/attachment) to server disk.
    pub fn save_binary_file(&self, room_id: &str, raw_path: &str, bytes: &[u8]) {
        let path = binary_file_to_path(room_id, raw_path, &self.data_dir);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).ok();
        }
        if let Err(e) = fs::write(&path, bytes) {
            warn!("failed to save binary file {}: {e}", path.display());
        }
    }

    /// Record start of a chunked upload.
    pub async fn start_chunk(&self, key: &str, path: &str, binary: bool) {
        let mut map = self.pending_chunks.lock().await;
        map.insert(key.to_string(), (path.to_string(), binary, HashMap::new()));
    }

    /// Record a data chunk.
    pub async fn add_chunk(&self, key: &str, index: usize, data: String) {
        let mut map = self.pending_chunks.lock().await;
        if let Some((_, _, chunks)) = map.get_mut(key) {
            chunks.insert(index, data);
        }
    }

    /// Finish and assemble chunked upload, saving to disk.
    pub async fn finish_chunk(&self, room_id: &str, key: &str) -> Option<(String, bool)> {
        use base64::Engine;
        let mut map = self.pending_chunks.lock().await;
        if let Some((path, binary, chunks)) = map.remove(key) {
            let mut indices: Vec<usize> = chunks.keys().cloned().collect();
            indices.sort_unstable();
            let mut full_b64 = String::new();
            for idx in indices {
                if let Some(chunk) = chunks.get(&idx) {
                    full_b64.push_str(chunk);
                }
            }
            if binary {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&full_b64) {
                    self.save_binary_file(room_id, &path, &bytes);
                }
            }
            Some((path, binary))
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
    }

    /// Rename a Yjs document in memory and disk.
    pub async fn rename_doc(&self, old_full_id: &str, new_full_id: &str) {
        let mut docs = self.docs.lock().await;
        
        if let Some(entry) = docs.remove(new_full_id) {
            let doc_guard = entry.doc.lock().await;
            fs::remove_file(&doc_guard.path).ok();
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