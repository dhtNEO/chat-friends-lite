use crate::auth::{extract_cookie_value, hash_token, AuthUser, SESSION_COOKIE_NAME};
use crate::db::CHAT_RETENTION_SECONDS;
use crate::AppState;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header::HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::FromRow;
use std::collections::HashMap;
use tracing::{debug, error, info};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReactionGroup {
    pub emoji: String,
    pub count: usize,
    pub users: Vec<String>,
}

#[derive(Debug, FromRow)]
struct MessageRow {
    pub id: i64,
    pub user_id: i64,
    pub username: String,
    pub display_name: String,
    pub avatar_color: String,
    pub content: String,
    pub image_url: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, FromRow)]
struct ReactionRow {
    pub message_id: i64,
    pub username: String,
    pub emoji: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub id: i64,
    pub user_id: i64,
    pub username: String,
    pub display_name: String,
    pub avatar_color: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    pub reactions: Vec<ReactionGroup>,
    pub created_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct MessagesQuery {
    pub before_id: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct CreateMessageRequest {
    #[serde(default)]
    pub content: String,
    pub image_url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ToggleReactionRequest {
    pub emoji: String,
}

fn aggregate_reactions(rows: Vec<ReactionRow>) -> Vec<ReactionGroup> {
    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, Vec<String>> = HashMap::new();

    for r in rows {
        if !map.contains_key(&r.emoji) {
            order.push(r.emoji.clone());
        }
        map.entry(r.emoji).or_default().push(r.username);
    }

    order
        .into_iter()
        .filter_map(|emoji| {
            let users = map.remove(&emoji)?;
            Some(ReactionGroup {
                emoji,
                count: users.len(),
                users,
            })
        })
        .collect()
}

pub async fn get_messages(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(query): Query<MessagesQuery>,
) -> Result<Json<Vec<ChatMessage>>, (StatusCode, Json<serde_json::Value>)> {
    let limit = query.limit.unwrap_or(50).clamp(1, 100);

    let mut rows = if let Some(before) = query.before_id {
        sqlx::query_as::<_, MessageRow>(
            r#"
            SELECT m.id, m.user_id, u.username, u.display_name, u.avatar_color, m.content,
                   CASE
                     WHEN m.image_url IS NOT NULL AND m.image_url LIKE 'data:%'
                     THEN '/api/messages/' || m.id || '/image'
                     ELSE m.image_url
                   END AS image_url,
                   m.created_at
            FROM messages m
            JOIN users u ON u.id = m.user_id
            WHERE m.id < ?1 AND m.created_at >= unixepoch() - ?3
            ORDER BY m.id DESC
            LIMIT ?2
            "#,
        )
        .bind(before)
        .bind(limit)
        .bind(CHAT_RETENTION_SECONDS)
        .fetch_all(&state.db)
        .await
    } else {
        sqlx::query_as::<_, MessageRow>(
            r#"
            SELECT m.id, m.user_id, u.username, u.display_name, u.avatar_color, m.content,
                   CASE
                     WHEN m.image_url IS NOT NULL AND m.image_url LIKE 'data:%'
                     THEN '/api/messages/' || m.id || '/image'
                     ELSE m.image_url
                   END AS image_url,
                   m.created_at
            FROM messages m
            JOIN users u ON u.id = m.user_id
            WHERE m.created_at >= unixepoch() - ?2
            ORDER BY m.id DESC
            LIMIT ?1
            "#,
        )
        .bind(limit)
        .bind(CHAT_RETENTION_SECONDS)
        .fetch_all(&state.db)
        .await
    }
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Database error: {e}") })),
        )
    })?;

    // Invert to chronological order (oldest first)
    rows.reverse();

    // Filtra apenas as reações das mensagens carregadas na janela atual (usa idx_message_reactions_msg)
    let reaction_rows = if let (Some(first), Some(last)) = (rows.first(), rows.last()) {
        sqlx::query_as::<_, ReactionRow>(
            r#"
            SELECT message_id, username, emoji
            FROM message_reactions
            WHERE message_id BETWEEN ?1 AND ?2
            ORDER BY created_at ASC
            "#,
        )
        .bind(first.id)
        .bind(last.id)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default()
    } else {
        Vec::new()
    };

    let mut by_msg: HashMap<i64, Vec<ReactionRow>> = HashMap::new();
    for r in reaction_rows {
        by_msg.entry(r.message_id).or_default().push(r);
    }

    let messages = rows
        .into_iter()
        .map(|row| {
            let reactions = by_msg
                .remove(&row.id)
                .map(aggregate_reactions)
                .unwrap_or_default();
            ChatMessage {
                id: row.id,
                user_id: row.user_id,
                username: row.username,
                display_name: row.display_name,
                avatar_color: row.avatar_color,
                content: row.content,
                image_url: row.image_url,
                reactions,
                created_at: row.created_at,
            }
        })
        .collect();

    Ok(Json(messages))
}

pub async fn create_message(
    State(state): State<AppState>,
    user: AuthUser,
    Json(payload): Json<CreateMessageRequest>,
) -> Result<(StatusCode, Json<ChatMessage>), (StatusCode, Json<serde_json::Value>)> {
    let content = payload.content.trim().to_string();
    let image_url = payload
        .image_url
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let char_count = content.chars().count();
    if char_count > 2000 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Message content must be at most 2000 characters" })),
        ));
    }

    if char_count == 0 && image_url.is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Message must contain text or an image" })),
        ));
    }

    if let Some(ref img) = image_url {
        if !img.starts_with("data:image/") || img.len() > 5_000_000 {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Invalid or oversized image attachment" })),
            ));
        }
    }

    #[derive(FromRow)]
    struct NewMessageRow {
        id: i64,
        created_at: i64,
    }

    let inserted = sqlx::query_as::<_, NewMessageRow>(
        r#"
        INSERT INTO messages (user_id, content, image_url)
        VALUES (?1, ?2, ?3)
        RETURNING id, created_at
        "#,
    )
    .bind(user.id)
    .bind(&content)
    .bind(&image_url)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Database error: {e}") })),
        )
    })?;

    let public_image_url = image_url.as_ref().map(|raw| {
        if raw.starts_with("data:") {
            format!("/api/messages/{}/image", inserted.id)
        } else {
            raw.clone()
        }
    });

    let message = ChatMessage {
        id: inserted.id,
        user_id: user.id,
        username: user.username,
        display_name: user.display_name,
        avatar_color: user.avatar_color,
        content,
        image_url: public_image_url,
        reactions: Vec::new(),
        created_at: inserted.created_at,
    };

    let event = json!({
        "type": "chat_message",
        "message": &message,
    });

    if let Ok(event_str) = serde_json::to_string(&event) {
        let _ = state.chat_tx.send(event_str);
    }

    Ok((StatusCode::CREATED, Json(message)))
}

fn decode_base64(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity((input.len() * 3) / 4);
    let mut buf: u32 = 0;
    let mut bits: u8 = 0;

    for &b in input.as_bytes() {
        let val = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return None,
        };
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}

pub async fn get_message_image(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(message_id): Path<i64>,
) -> Response {
    let row: Option<(Option<String>,)> = sqlx::query_as(
        r#"
        SELECT image_url
        FROM messages
        WHERE id = ?1 AND created_at >= unixepoch() - ?2
        "#,
    )
    .bind(message_id)
    .bind(CHAT_RETENTION_SECONDS)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();

    let Some((Some(data_uri),)) = row else {
        return StatusCode::NOT_FOUND.into_response();
    };

    if let Some(rest) = data_uri.strip_prefix("data:")
        && let Some((meta, b64_data)) = rest.split_once(";base64,")
        && let Some(bytes) = decode_base64(b64_data)
    {
        let content_type = if meta.is_empty() { "image/webp" } else { meta };
        return (
            StatusCode::OK,
            [
                (axum::http::header::CONTENT_TYPE, content_type.to_string()),
                (
                    axum::http::header::CACHE_CONTROL,
                    "public, max-age=31536000, immutable".to_string(),
                ),
            ],
            bytes,
        )
            .into_response();
    }

    StatusCode::NOT_FOUND.into_response()
}

pub async fn toggle_reaction(
    State(state): State<AppState>,
    user: AuthUser,
    Path(message_id): Path<i64>,
    Json(payload): Json<ToggleReactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let emoji = payload.emoji.trim().to_string();
    if emoji.is_empty() || emoji.len() > 32 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid emoji" })),
        ));
    }

    let existing: Option<(i64,)> = sqlx::query_as(
        r#"
        SELECT 1
        FROM message_reactions
        WHERE message_id = ?1 AND user_id = ?2 AND emoji = ?3
        "#,
    )
    .bind(message_id)
    .bind(user.id)
    .bind(&emoji)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Database error: {e}") })),
        )
    })?;

    if existing.is_some() {
        sqlx::query(
            r#"
            DELETE FROM message_reactions
            WHERE message_id = ?1 AND user_id = ?2 AND emoji = ?3
            "#,
        )
        .bind(message_id)
        .bind(user.id)
        .bind(&emoji)
        .execute(&state.db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("Database error: {e}") })),
            )
        })?;
    } else {
        sqlx::query(
            r#"
            INSERT INTO message_reactions (message_id, user_id, username, emoji)
            VALUES (?1, ?2, ?3, ?4)
            "#,
        )
        .bind(message_id)
        .bind(user.id)
        .bind(&user.username)
        .bind(&emoji)
        .execute(&state.db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("Database error: {e}") })),
            )
        })?;
    }

    let rows = sqlx::query_as::<_, ReactionRow>(
        r#"
        SELECT message_id, username, emoji
        FROM message_reactions
        WHERE message_id = ?1
        ORDER BY created_at ASC
        "#,
    )
    .bind(message_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let reactions = aggregate_reactions(rows);

    let event = json!({
        "type": "message_reactions",
        "message_id": message_id,
        "reactions": &reactions,
    });

    if let Ok(event_str) = serde_json::to_string(&event) {
        let _ = state.chat_tx.send(event_str);
    }

    Ok(Json(json!({
        "message_id": message_id,
        "reactions": reactions,
    })))
}

pub async fn ws_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let raw_token = match extract_cookie_value(&headers, SESSION_COOKIE_NAME) {
        Some(t) if !t.is_empty() => t,
        _ => return StatusCode::UNAUTHORIZED.into_response(),
    };

    let token_hash = hash_token(&raw_token);
    let maybe_user = sqlx::query_as::<_, AuthUser>(
        r#"
        SELECT u.id, u.username, u.display_name, u.avatar_color, u.mic_gain
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?1 AND s.expires_at > unixepoch()
        "#,
    )
    .bind(token_hash)
    .fetch_optional(&state.db)
    .await;

    let user = match maybe_user {
        Ok(Some(u)) => u,
        _ => return StatusCode::UNAUTHORIZED.into_response(),
    };

    ws.on_upgrade(move |socket| handle_socket(socket, state, user))
}

async fn handle_socket(mut socket: WebSocket, state: AppState, user: AuthUser) {
    info!(
        "WebSocket client connected: {} (id: {})",
        user.username, user.id
    );

    let mut rx = state.chat_tx.subscribe();

    // Send initial connection presence/acknowledgement
    let welcome = json!({
        "type": "connected",
        "user": {
            "id": user.id,
            "username": user.username,
            "display_name": user.display_name
        }
    });
    if let Ok(welcome_str) = serde_json::to_string(&welcome)
        && socket
            .send(Message::Text(welcome_str.into()))
            .await
            .is_err()
    {
        return;
    }

    loop {
        tokio::select! {
            broadcast_msg = rx.recv() => {
                match broadcast_msg {
                    Ok(text) => {
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        debug!("Client {} lagged by {} broadcast messages", user.username, skipped);
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
            client_msg = socket.recv() => {
                match client_msg {
                    Some(Ok(Message::Text(text))) => {
                        let trimmed = text.trim();
                        if trimmed == "ping"
                            && socket.send(Message::Text("pong".into())).await.is_err()
                        {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        break;
                    }
                    Some(Err(err)) => {
                        error!("WebSocket error for user {}: {}", user.username, err);
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    info!("WebSocket disconnected for user: {}", user.username);
}
