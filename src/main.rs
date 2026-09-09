mod protocol;
mod state;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::mpsc;
use tower_http::cors::CorsLayer;
use tracing::{info, warn};
use yrs::updates::decoder::Decode;
use yrs::StateVector;

use crate::protocol::{
    read_var_str, read_var_uint, read_var_u8slice,
    write_var_string, write_var_uint, write_var_u8array,
};
use crate::state::AppState;

const DEFAULT_HOST: &str = "0.0.0.0";
const DEFAULT_PORT: u16 = 5612;
const DEFAULT_DATA_DIR: &str = "./data";

// Mux message types (matching the reference mux-protocol.ts)
const MUX_SYNC: u32 = 0;
const MUX_AWARENESS: u32 = 1;
const MUX_SUBSCRIBE: u32 = 2;
const MUX_UNSUBSCRIBE: u32 = 3;
const MUX_SUBSCRIBED: u32 = 4;
const MUX_SYNC_REQUEST: u32 = 6;

// Yjs sync message subtypes inside the SYNC payload
const YJS_SYNC_STEP1: u32 = 0;
const YJS_SYNC_STEP2: u32 = 1;
const YJS_SYNC_UPDATE: u32 = 2;

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);

const DEFAULT_SERVER_PASSWORD: &str = "changethispassword";
const DEFAULT_ADMIN_PASSWORD: &str = "adminchangethispassword";

#[derive(serde::Deserialize)]
struct AdminVerifyRequest {
    #[serde(rename = "adminPassword", default)]
    admin_password: String,
}

#[derive(serde::Deserialize)]
struct AdminCreateRoomRequest {
    #[serde(rename = "roomId")]
    room_id: String,
    #[serde(default)]
    description: Option<String>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "synqra_server=info,tower_http=info".into()),
        )
        .init();

    let host = env_var("HOST", DEFAULT_HOST);
    let port: u16 = env_parse("PORT", DEFAULT_PORT);
    let data_dir = env_var("DATA_DIR", DEFAULT_DATA_DIR);
    let server_password = env_var("SERVER_PASSWORD", DEFAULT_SERVER_PASSWORD);
    let admin_password = env_var("ADMIN_PASSWORD", DEFAULT_ADMIN_PASSWORD);

    info!("data directory: {data_dir} (per-file vault docs are persisted here)");
    if server_password == DEFAULT_SERVER_PASSWORD {
        warn!("Using default SERVER_PASSWORD='{DEFAULT_SERVER_PASSWORD}'. Set SERVER_PASSWORD in your environment / Portainer stack for security!");
    }
    if admin_password == DEFAULT_ADMIN_PASSWORD {
        warn!("Using default ADMIN_PASSWORD='{DEFAULT_ADMIN_PASSWORD}'. Set ADMIN_PASSWORD in your environment / Portainer stack for security!");
    }

    let state = AppState::new(data_dir.into(), server_password, admin_password);
    let app = Router::new()
        .route("/health", get(health))
        .route("/ws/{room_id}", get(ws_handler))
        .route("/ws-mux/{room_id}", get(ws_handler))
        .route("/ws-control/{room_id}", get(ws_control_handler))
        .route("/file/{room_id}/{*file_path}", get(file_download_handler))
        // Client REST API
        .route("/api/rooms", get(client_list_rooms))
        // Admin REST API
        .route("/api/admin/verify", post(admin_verify))
        .route("/api/admin/rooms", get(admin_list_rooms).post(admin_create_room))
        .route("/api/admin/rooms/{room_id}", delete(admin_delete_room))
        .with_state(state)
        .layer(CorsLayer::permissive());

    let addr = format!("{host}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("failed to bind to {addr}: {e}"));

    info!("synqra-server listening on http://{addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
    info!("synqra-server shutdown gracefully");
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            sig.recv().await;
        } else {
            std::future::pending::<()>().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("Shutdown signal received, draining connections...");
}

fn env_var(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_parse<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn extract_admin_token(
    headers: &axum::http::HeaderMap,
    query: &HashMap<String, String>,
) -> String {
    if let Some(auth_header) = headers.get("authorization").and_then(|h| h.to_str().ok()) {
        if let Some(token) = auth_header.strip_prefix("Bearer ") {
            return token.trim().to_string();
        }
        return auth_header.trim().to_string();
    }
    if let Some(pass) = headers.get("x-admin-password").and_then(|h| h.to_str().ok()) {
        return pass.trim().to_string();
    }
    query.get("adminPassword").or_else(|| query.get("password")).cloned().unwrap_or_default()
}

fn extract_server_token(
    headers: &axum::http::HeaderMap,
    query: &HashMap<String, String>,
) -> String {
    if let Some(auth_header) = headers.get("authorization").and_then(|h| h.to_str().ok()) {
        if let Some(token) = auth_header.strip_prefix("Bearer ") {
            return token.trim().to_string();
        }
        return auth_header.trim().to_string();
    }
    if let Some(pass) = headers.get("x-server-password").and_then(|h| h.to_str().ok()) {
        return pass.trim().to_string();
    }
    query.get("password").or_else(|| query.get("serverPassword")).cloned().unwrap_or_default()
}

async fn health() -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "service": "synqra-server",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

async fn admin_verify(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    body: Option<Json<AdminVerifyRequest>>,
) -> impl IntoResponse {
    let mut pass = extract_admin_token(&headers, &query);
    if pass.is_empty() {
        if let Some(Json(req)) = body {
            pass = req.admin_password;
        }
    }

    if state.verify_admin_auth(&pass) {
        (axum::http::StatusCode::OK, Json(json!({ "status": "ok", "authenticated": true }))).into_response()
    } else {
        (axum::http::StatusCode::UNAUTHORIZED, Json(json!({ "error": "Invalid admin password", "authenticated": false }))).into_response()
    }
}

async fn client_list_rooms(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let pass = extract_server_token(&headers, &query);
    if !state.verify_server_auth(&pass) {
        return (axum::http::StatusCode::UNAUTHORIZED, Json(json!({ "error": "Unauthorized" }))).into_response();
    }

    let rooms = state.list_rooms().await;
    (axum::http::StatusCode::OK, Json(json!({ "rooms": rooms }))).into_response()
}

async fn admin_list_rooms(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let pass = extract_admin_token(&headers, &query);
    if !state.verify_admin_auth(&pass) {
        return (axum::http::StatusCode::UNAUTHORIZED, Json(json!({ "error": "Unauthorized" }))).into_response();
    }

    let rooms = state.list_rooms().await;
    (axum::http::StatusCode::OK, Json(json!({ "rooms": rooms }))).into_response()
}

async fn admin_create_room(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    Json(req): Json<AdminCreateRoomRequest>,
) -> impl IntoResponse {
    let pass = extract_admin_token(&headers, &query);
    if !state.verify_admin_auth(&pass) {
        return (axum::http::StatusCode::UNAUTHORIZED, Json(json!({ "error": "Unauthorized" }))).into_response();
    }

    match state.create_room(&req.room_id, req.description).await {
        Ok(room) => (axum::http::StatusCode::CREATED, Json(json!({ "status": "created", "room": room }))).into_response(),
        Err(e) => (axum::http::StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

async fn admin_delete_room(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    Path(room_id): Path<String>,
) -> impl IntoResponse {
    let pass = extract_admin_token(&headers, &query);
    if !state.verify_admin_auth(&pass) {
        return (axum::http::StatusCode::UNAUTHORIZED, Json(json!({ "error": "Unauthorized" }))).into_response();
    }

    match state.delete_room(&room_id).await {
        Ok(_) => (axum::http::StatusCode::OK, Json(json!({ "status": "deleted", "roomId": room_id }))).into_response(),
        Err(e) => (axum::http::StatusCode::NOT_FOUND, Json(json!({ "error": e }))).into_response(),
    }
}

async fn ws_control_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(room_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> axum::response::Response {
    let password = params.get("password").or_else(|| params.get("auth")).cloned().unwrap_or_default();
    if !state.verify_server_auth(&password) {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Invalid server password" })),
        )
            .into_response();
    }

    if !state.has_room(&room_id).await {
        return (
            axum::http::StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("Room '{room_id}' does not exist on this server") })),
        )
            .into_response();
    }

    ws.on_upgrade(move |socket| handle_control_socket(socket, state, room_id))
        .into_response()
}

async fn file_download_handler(
    State(state): State<AppState>,
    Path((room_id, file_path)): Path<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
) -> axum::response::Response {
    let password = params.get("password").or_else(|| params.get("auth")).cloned().unwrap_or_default();
    if !state.verify_server_auth(&password) {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            [("content-type", "application/json")],
            json!({ "error": "Invalid server password" }).to_string(),
        )
            .into_response();
    }

    if !state.has_room(&room_id).await {
        return (
            axum::http::StatusCode::NOT_FOUND,
            [("content-type", "application/json")],
            json!({ "error": format!("Room '{room_id}' not found") }).to_string(),
        )
            .into_response();
    }

    let decoded_path = percent_encoding::percent_decode_str(&file_path).decode_utf8_lossy();
    if let Some(bytes) = state.load_binary_file(&room_id, &decoded_path) {
        (
            axum::http::StatusCode::OK,
            [("content-type", "application/octet-stream")],
            bytes,
        )
            .into_response()
    } else {
        (
            axum::http::StatusCode::NOT_FOUND,
            [("content-type", "application/json")],
            json!({ "error": "File not found" }).to_string(),
        )
            .into_response()
    }
}

fn encode_mux_update(doc_id: &str, update_bytes: &[u8]) -> Vec<u8> {
    let mut inner = Vec::new();
    write_var_uint(&mut inner, YJS_SYNC_UPDATE);
    write_var_u8array(&mut inner, update_bytes);
    let mut frame = Vec::new();
    write_var_string(&mut frame, doc_id);
    write_var_uint(&mut frame, MUX_SYNC);
    write_var_u8array(&mut frame, &inner);
    frame
}

async fn process_control_file_op(state: &AppState, room_id: &str, text: &str) {
    use base64::Engine;
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(text) {
        if val.get("type").and_then(|v| v.as_str()) == Some("file-op") {
            if let Some(op) = val.get("op") {
                let op_type = op.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match op_type {
                    "create" | "modify" => {
                        let is_binary = op.get("binary").and_then(|v| v.as_bool()).unwrap_or(false);
                        if let (Some(path), Some(content)) = (
                            op.get("path").and_then(|v| v.as_str()),
                            op.get("content").and_then(|v| v.as_str()),
                        ) {
                            if is_binary {
                                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(content) {
                                    state.save_binary_file(room_id, path, &bytes);
                                }
                            } else {
                                state.save_binary_file(room_id, path, content.as_bytes());
                                let update = state.update_text_doc(room_id, path, content).await;
                                if !update.is_empty() {
                                    let frame = encode_mux_update(path, &update);
                                    let full_id = format!("{room_id}:{path}");
                                    state.send_to_subscribers(&full_id, frame).await;
                                }
                            }
                        }
                    }
                    "delete" => {
                        if let Some(path) = op.get("path").and_then(|v| v.as_str()) {
                            let full_id = format!("{room_id}:{path}");
                            state.delete_binary_file(room_id, path);
                            state.delete_doc(&full_id).await;
                        }
                    }
                    "rename" => {
                        if let (Some(old_p), Some(new_p)) = (
                            op.get("oldPath").and_then(|v| v.as_str()),
                            op.get("newPath").and_then(|v| v.as_str()),
                        ) {
                            let old_full = format!("{room_id}:{old_p}");
                            let new_full = format!("{room_id}:{new_p}");
                            state.rename_binary_file(room_id, old_p, new_p);
                            state.rename_doc(&old_full, &new_full).await;
                        }
                    }
                    "chunk-start" => {
                        let path = op.get("path").and_then(|v| v.as_str()).unwrap_or("");
                        let binary = op.get("binary").and_then(|v| v.as_bool()).unwrap_or(false);
                        let transfer_id = op.get("transferId").and_then(|v| v.as_str()).unwrap_or(path);
                        let total_size = op.get("totalSize").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                        const MAX_CHUNK_TRANSFER_SIZE: usize = 70 * 1024 * 1024;
                        if total_size > 0 && total_size <= MAX_CHUNK_TRANSFER_SIZE {
                            let scoped_key = format!("{room_id}:{transfer_id}");
                            state.start_chunk(&scoped_key, path, binary, total_size).await;
                        }
                    }
                    "chunk-data" => {
                        let path = op.get("path").and_then(|v| v.as_str()).unwrap_or("");
                        let transfer_id = op.get("transferId").and_then(|v| v.as_str()).unwrap_or(path);
                        let index = op.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                        let data = op.get("data").and_then(|v| v.as_str()).unwrap_or("");
                        let scoped_key = format!("{room_id}:{transfer_id}");
                        state.add_chunk(&scoped_key, index, data.to_string()).await;
                    }
                    "chunk-end" => {
                        let path = op.get("path").and_then(|v| v.as_str()).unwrap_or("");
                        let transfer_id = op.get("transferId").and_then(|v| v.as_str()).unwrap_or(path);
                        let scoped_key = format!("{room_id}:{transfer_id}");
                        if let Some((path, binary, update)) = state.finish_chunk(room_id, &scoped_key).await {
                            if !binary && !update.is_empty() {
                                let frame = encode_mux_update(&path, &update);
                                let full_id = format!("{room_id}:{path}");
                                state.send_to_subscribers(&full_id, frame).await;
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

async fn handle_control_socket(
    socket: WebSocket,
    state: AppState,
    room_id: String,
) {
    let client_key = {
        static COUNTER: AtomicU64 = AtomicU64::new(1);
        COUNTER.fetch_add(1, Ordering::Relaxed)
    };

    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    state.register_control_client(&room_id, client_key, tx).await;

    let mut writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    tokio::select! {
        _ = &mut writer => {}
        _ = async {
            loop {
                let msg = match tokio::time::timeout(std::time::Duration::from_secs(75), receiver.next()).await {
                    Ok(Some(msg)) => msg,
                    Ok(None) => break,
                    Err(_) => {
                        warn!("control socket timed out client={client_key} room={room_id}");
                        break;
                    }
                };

                match msg {
                    Ok(Message::Text(text)) => {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                            if let Some(msg_type) = val.get("type").and_then(|v| v.as_str()) {
                                if msg_type == "ping" {
                                    state.send_control_to(&room_id, client_key, r#"{"type":"pong"}"#.to_string()).await;
                                    continue;
                                } else if msg_type == "pong" {
                                    // Heartbeat response, do not broadcast
                                    continue;
                                }
                            }
                        }
                        process_control_file_op(&state, &room_id, &text).await;
                        state.broadcast_control_msg(&room_id, client_key, text.to_string()).await;
                    }
                    Ok(Message::Close(_)) => break,
                    Ok(Message::Ping(_)) => {}
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        } => {}
    }

    state.unregister_control_client(&room_id, client_key).await;
    writer.abort();
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(base_room): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> axum::response::Response {
    let password = params.get("password").or_else(|| params.get("auth")).cloned().unwrap_or_default();
    if !state.verify_server_auth(&password) {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Invalid server password" })),
        )
            .into_response();
    }

    if !state.has_room(&base_room).await {
        return (
            axum::http::StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("Room '{base_room}' does not exist on this server") })),
        )
            .into_response();
    }

    let display_name = params
        .get("display_name")
        .cloned()
        .unwrap_or_else(|| "Anonymous".to_string());
    ws.on_upgrade(move |socket| handle_socket(socket, state, base_room, display_name))
        .into_response()
}

async fn handle_socket(
    socket: WebSocket,
    state: AppState,
    base_room: String,
    display_name: String,
) {
    let client_key = {
        static COUNTER: AtomicU64 = AtomicU64::new(1);
        COUNTER.fetch_add(1, Ordering::Relaxed)
    };

    info!("client joined session={base_room} client={client_key} display={display_name}");

    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();

    state.register_connection(client_key, tx).await;

    let mut writer = tokio::spawn(async move {
        let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
        heartbeat.tick().await;
        loop {
            tokio::select! {
                bytes = rx.recv() => {
                    match bytes {
                        Some(bytes) => {
                            if sender.send(Message::Binary(bytes.into())).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
                _ = heartbeat.tick() => {
                    if sender.send(Message::Ping(Default::default())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    tokio::select! {
        _ = &mut writer => {}
        _ = async {
            loop {
                let msg = match tokio::time::timeout(std::time::Duration::from_secs(75), receiver.next()).await {
                    Ok(Some(msg)) => msg,
                    Ok(None) => break,
                    Err(_) => {
                        warn!("client timed out client={client_key} room={base_room}");
                        break;
                    }
                };

                match msg {
                    Ok(Message::Binary(bytes)) => {
                        if let Err(e) = handle_frame(&state, &base_room, client_key, &bytes).await {
                            warn!("protocol error client={client_key}: {e}");
                            break;
                        }
                    }
                    Ok(Message::Close(_)) => break,
                    Ok(Message::Ping(_)) => {}
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        } => {}
    }

    let all_removals = state.cleanup_connection(client_key).await;
    for (full_id, client_clocks) in all_removals {
        if !client_clocks.is_empty() {
            let doc_id = full_id.split_once(':').map(|(_, d)| d).unwrap_or(&full_id);
            broadcast_awareness_removal(&state, &full_id, doc_id, &client_clocks).await;
        }
    }

    writer.abort();
    info!("client left session={base_room} client={client_key}");
}

async fn broadcast_awareness_removal(
    state: &AppState,
    full_id: &str,
    doc_id: &str,
    client_clocks: &[(u32, u32)],
) {
    if client_clocks.is_empty() {
        return;
    }
    let mut removal_payload = Vec::new();
    write_var_uint(&mut removal_payload, client_clocks.len() as u32);
    for (id, clock) in client_clocks {
        write_var_uint(&mut removal_payload, *id);
        write_var_uint(&mut removal_payload, clock.saturating_add(1));
        write_var_string(&mut removal_payload, "null");
    }
    let mut frame = Vec::new();
    write_var_string(&mut frame, doc_id);
    write_var_uint(&mut frame, MUX_AWARENESS);
    write_var_u8array(&mut frame, &removal_payload);
    state.send_to_others(full_id, 0, frame).await;
}

/// Process a binary mux frame: relay to peers and persist authoritative updates.
async fn handle_frame(
    state: &AppState,
    base_room: &str,
    client_key: u64,
    frame: &[u8],
) -> Result<(), String> {
    let mut pos = 0usize;
    let doc_id = read_var_str(frame, &mut pos).ok_or("missing docId")?;
    let msg_type = read_var_uint(frame, &mut pos).ok_or("missing msgType")?;
    let payload = if pos < frame.len() {
        let mut p = pos;
        read_var_u8slice(frame, &mut p).ok_or("bad payload")?
    } else {
        &[]
    };

    let full_id = format!("{base_room}:{doc_id}");

    match msg_type {
        MUX_SUBSCRIBE => {
            let (doc, peer_count) = state.subscribe(&full_id, client_key).await;

            let mut payload = Vec::new();
            write_var_uint(&mut payload, peer_count as u32);
            let mut msg = Vec::new();
            write_var_string(&mut msg, doc_id);
            write_var_uint(&mut msg, MUX_SUBSCRIBED);
            write_var_u8array(&mut msg, &payload);
            state.send_to(client_key, msg).await;

            if peer_count > 0 {
                let mut req = Vec::new();
                write_var_string(&mut req, doc_id);
                write_var_uint(&mut req, MUX_SYNC_REQUEST);
                state.send_to_others(&full_id, client_key, req).await;
            }

            let doc_guard = doc.lock().await;
            let full_update = doc_guard.diff_since(&StateVector::default());
            let server_sv = doc_guard.state_vector_v1();
            drop(doc_guard);

            let mut inner = Vec::new();
            write_var_uint(&mut inner, YJS_SYNC_STEP2);
            write_var_u8array(&mut inner, &full_update);
            let mut reply = Vec::new();
            write_var_string(&mut reply, doc_id);
            write_var_uint(&mut reply, MUX_SYNC);
            write_var_u8array(&mut reply, &inner);
            state.send_to(client_key, reply).await;

            let mut inner = Vec::new();
            write_var_uint(&mut inner, YJS_SYNC_STEP1);
            write_var_u8array(&mut inner, &server_sv);
            let mut reply = Vec::new();
            write_var_string(&mut reply, doc_id);
            write_var_uint(&mut reply, MUX_SYNC);
            write_var_u8array(&mut reply, &inner);
            state.send_to(client_key, reply).await;

            let awareness_payloads = state.get_all_awareness(&full_id).await;
            for payload in awareness_payloads {
                state.send_to(client_key, payload).await;
            }

            Ok(())
        }
        MUX_UNSUBSCRIBE => {
            state.unsubscribe_doc(&full_id, client_key).await;
            let client_clocks = state.take_awareness_client_clocks(client_key, &full_id).await;
            if !client_clocks.is_empty() {
                broadcast_awareness_removal(state, &full_id, doc_id, &client_clocks).await;
            }
            Ok(())
        }
        MUX_SYNC => {
            let mut p = 0usize;
            let sync_type = read_var_uint(payload, &mut p).ok_or("bad sync frame")?;
            match sync_type {
                YJS_SYNC_STEP1 => {
                    let sv_bytes = read_var_u8slice(payload, &mut p).ok_or("bad sv")?;
                    let client_sv =
                        StateVector::decode_v1(sv_bytes).map_err(|e| format!("bad sv: {e}"))?;

                    let doc = match state.get_doc(&full_id).await {
                        Some(d) => d,
                        None => {
                            let (d, _) = state.subscribe(&full_id, client_key).await;
                            d
                        }
                    };
                    let doc_guard = doc.lock().await;
                    let diff = doc_guard.diff_since(&client_sv);
                    let sv = doc_guard.state_vector_v1();
                    drop(doc_guard);

                    let mut inner = Vec::new();
                    write_var_uint(&mut inner, YJS_SYNC_STEP2);
                    write_var_u8array(&mut inner, &diff);
                    let mut reply = Vec::new();
                    write_var_string(&mut reply, doc_id);
                    write_var_uint(&mut reply, MUX_SYNC);
                    write_var_u8array(&mut reply, &inner);
                    state.send_to(client_key, reply).await;

                    let mut inner = Vec::new();
                    write_var_uint(&mut inner, YJS_SYNC_STEP1);
                    write_var_u8array(&mut inner, &sv);
                    let mut reply = Vec::new();
                    write_var_string(&mut reply, doc_id);
                    write_var_uint(&mut reply, MUX_SYNC);
                    write_var_u8array(&mut reply, &inner);
                    state.send_to(client_key, reply).await;
                    Ok(())
                }
                YJS_SYNC_STEP2 | YJS_SYNC_UPDATE => {
                    let update_bytes = read_var_u8slice(payload, &mut p).ok_or("bad update")?;

                    if let Some(doc) = state.get_doc(&full_id).await {
                        let guard = doc.lock().await;
                        let applied = guard.apply_update(update_bytes);
                        drop(guard);
                        if !applied {
                            warn!("failed to apply update client={client_key} doc={full_id}");
                        }
                    }

                    state
                        .send_to_others(&full_id, client_key, frame.to_vec())
                        .await;
                    Ok(())
                }
                _ => Ok(()),
            }
        }
        MUX_AWARENESS => {
            let mut p = 0usize;
            if let Some(len) = read_var_uint(payload, &mut p) {
                for _ in 0..len {
                    if let Some(client_id) = read_var_uint(payload, &mut p) {
                        let clock = read_var_uint(payload, &mut p).unwrap_or(0);
                        state.record_awareness_client_clock(client_key, &full_id, client_id, clock).await;
                        let _ = read_var_str(payload, &mut p); // state
                    }
                }
            }
            state.store_awareness(client_key, &full_id, frame.to_vec()).await;
            state
                .send_to_others(&full_id, client_key, frame.to_vec())
                .await;
            Ok(())
        }
        MUX_SYNC_REQUEST => {
            state
                .send_to_others(&full_id, client_key, frame.to_vec())
                .await;
            Ok(())
        }
        _ => Ok(()),
    }
}