use crate::auth::{extract_cookie_value, hash_token, AuthUser, SESSION_COOKIE_NAME};
use crate::AppState;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header::HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::FromRow;
use tracing::{debug, error, info};

#[derive(Debug, Serialize, Deserialize, FromRow, Clone)]
pub struct ChatMessage {
    pub id: i64,
    pub user_id: i64,
    pub username: String,
    pub display_name: String,
    pub avatar_color: String,
    pub content: String,
    pub created_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct MessagesQuery {
    pub before_id: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct CreateMessageRequest {
    pub content: String,
}

pub async fn get_messages(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(query): Query<MessagesQuery>,
) -> Result<Json<Vec<ChatMessage>>, (StatusCode, Json<serde_json::Value>)> {
    let limit = query.limit.unwrap_or(50).clamp(1, 100);

    let mut messages = if let Some(before) = query.before_id {
        sqlx::query_as::<_, ChatMessage>(
            r#"
            SELECT m.id, m.user_id, u.username, u.display_name, u.avatar_color, m.content, m.created_at
            FROM messages m
            JOIN users u ON u.id = m.user_id
            WHERE m.id < ?1
            ORDER BY m.id DESC
            LIMIT ?2
            "#,
        )
        .bind(before)
        .bind(limit)
        .fetch_all(&state.db)
        .await
    } else {
        sqlx::query_as::<_, ChatMessage>(
            r#"
            SELECT m.id, m.user_id, u.username, u.display_name, u.avatar_color, m.content, m.created_at
            FROM messages m
            JOIN users u ON u.id = m.user_id
            ORDER BY m.id DESC
            LIMIT ?1
            "#,
        )
        .bind(limit)
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
    messages.reverse();

    Ok(Json(messages))
}

pub async fn create_message(
    State(state): State<AppState>,
    user: AuthUser,
    Json(payload): Json<CreateMessageRequest>,
) -> Result<(StatusCode, Json<ChatMessage>), (StatusCode, Json<serde_json::Value>)> {
    let content = payload.content.trim().to_string();
    let char_count = content.chars().count();
    if char_count == 0 || char_count > 2000 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Message content must be between 1 and 2000 characters" })),
        ));
    }

    #[derive(FromRow)]
    struct NewMessageRow {
        id: i64,
        created_at: i64,
    }

    let inserted = sqlx::query_as::<_, NewMessageRow>(
        r#"
        INSERT INTO messages (user_id, content)
        VALUES (?1, ?2)
        RETURNING id, created_at
        "#,
    )
    .bind(user.id)
    .bind(&content)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Database error: {e}") })),
        )
    })?;

    let message = ChatMessage {
        id: inserted.id,
        user_id: user.id,
        username: user.username,
        display_name: user.display_name,
        avatar_color: user.avatar_color,
        content,
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
