use crate::auth::AuthUser;
use crate::AppState;
use axum::{extract::State, http::StatusCode, Json};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize)]
pub struct LiveKitVideoGrant {
    #[serde(rename = "roomJoin")]
    pub room_join: bool,
    pub room: String,
    #[serde(rename = "canPublish")]
    pub can_publish: bool,
    #[serde(rename = "canSubscribe")]
    pub can_subscribe: bool,
    #[serde(rename = "canPublishData")]
    pub can_publish_data: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LiveKitClaims {
    pub iss: String,
    pub sub: String,
    pub name: String,
    pub nbf: usize,
    pub exp: usize,
    pub video: LiveKitVideoGrant,
}

#[derive(Debug, Serialize)]
pub struct MediaTokenResponse {
    pub token: String,
    pub url: String,
}

#[derive(Debug, Deserialize)]
pub struct PreferenceRequest {
    pub target_username: String,
    pub stream_type: String,
    pub volume: i64,
}

#[derive(Debug, Deserialize)]
pub struct MicGainRequest {
    pub mic_gain: i64,
}

pub async fn generate_token(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<MediaTokenResponse>, (StatusCode, Json<serde_json::Value>)> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as usize;

    let exp = now + (12 * 3600); // 12 hours

    let claims = LiveKitClaims {
        iss: state.config.livekit_api_key.clone(),
        sub: user.username,
        name: user.display_name,
        nbf: now,
        exp,
        video: LiveKitVideoGrant {
            room_join: true,
            room: "principal".to_string(),
            can_publish: true,
            can_subscribe: true,
            can_publish_data: true,
        },
    };

    let header = Header::new(Algorithm::HS256);
    let key = EncodingKey::from_secret(state.config.livekit_api_secret.as_bytes());

    let token = encode(&header, &claims, &key).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Token generation failed: {e}") })),
        )
    })?;

    Ok(Json(MediaTokenResponse {
        token,
        url: state.config.livekit_url.clone(),
    }))
}

pub async fn set_audio_preference(
    State(state): State<AppState>,
    user: AuthUser,
    Json(payload): Json<PreferenceRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let target = payload.target_username.trim().to_lowercase();
    if target.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "target_username cannot be empty" })),
        ));
    }

    let stream = payload.stream_type.trim().to_lowercase();
    if stream != "voice" && stream != "screen" {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "stream_type must be either 'voice' or 'screen'" })),
        ));
    }

    if payload.volume < 0 || payload.volume > 200 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "volume must be between 0 and 200" })),
        ));
    }

    sqlx::query(
        r#"
        INSERT INTO audio_preferences (user_id, target_username, stream_type, volume, updated_at)
        VALUES (?1, ?2, ?3, ?4, unixepoch())
        ON CONFLICT (user_id, target_username, stream_type)
        DO UPDATE SET volume = excluded.volume, updated_at = unixepoch()
        "#,
    )
    .bind(user.id)
    .bind(&target)
    .bind(&stream)
    .bind(payload.volume)
    .execute(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Database error: {e}") })),
        )
    })?;

    Ok(Json(json!({ "status": "updated" })))
}

pub async fn set_mic_gain(
    State(state): State<AppState>,
    user: AuthUser,
    Json(payload): Json<MicGainRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    if payload.mic_gain < 0 || payload.mic_gain > 200 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "mic_gain must be between 0 and 200" })),
        ));
    }

    sqlx::query(
        r#"
        UPDATE users
        SET mic_gain = ?1
        WHERE id = ?2
        "#,
    )
    .bind(payload.mic_gain)
    .bind(user.id)
    .execute(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Database error: {e}") })),
        )
    })?;

    Ok(Json(json!({
        "status": "updated",
        "mic_gain": payload.mic_gain
    })))
}
