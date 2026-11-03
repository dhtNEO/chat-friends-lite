use crate::AppState;
use argon2::{
    password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier},
    Argon2,
};
use axum::{
    extract::{FromRef, FromRequestParts, State},
    http::{
        header::{HeaderMap, HeaderValue, COOKIE, SET_COOKIE},
        request::Parts,
        StatusCode,
    },
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::FromRow;

pub const SESSION_COOKIE_NAME: &str = "cf_session";
pub const SESSION_TTL_SECONDS: i64 = 2592000; // 30 days

const AVATAR_PALETTE: &[&str] = &[
    "#5865F2", // Discord Blurple
    "#57F287", // Green
    "#FEE75C", // Yellow
    "#EB459E", // Fuchsia
    "#ED4245", // Red
    "#9B59B6", // Purple
    "#1ABC9C", // Turquoise
    "#E67E22", // Carrot Orange
    "#3498DB", // Dodger Blue
    "#2ECC71", // Emerald
];

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct AuthUser {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub avatar_color: String,
    pub mic_gain: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct AudioPreference {
    pub target_username: String,
    pub stream_type: String,
    pub volume: i64,
}

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub display_name: String,
    pub password: String,
    pub invite_code: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct MeResponse {
    pub user: AuthUser,
    pub audio_preferences: Vec<AudioPreference>,
}

pub fn extract_cookie_value(headers: &HeaderMap, cookie_name: &str) -> Option<String> {
    headers.get(COOKIE)?.to_str().ok().and_then(|cookies| {
        for piece in cookies.split(';') {
            let mut parts = piece.trim().splitn(2, '=');
            if let (Some(name), Some(val)) = (parts.next(), parts.next())
                && name == cookie_name
            {
                return Some(val.to_string());
            }
        }
        None
    })
}

pub fn generate_raw_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("failed to generate random session token");
    hex::encode(bytes)
}

pub fn hash_token(raw_token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw_token.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn build_session_cookie(raw_token: &str) -> String {
    format!(
        "{SESSION_COOKIE_NAME}={raw_token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_TTL_SECONDS}"
    )
}

pub fn build_clear_cookie() -> String {
    format!("{SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0")
}

pub fn hash_password(password: &str) -> Result<String, String> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| format!("Password hashing error: {e}"))
}

pub fn verify_password(password: &str, stored_hash: &str) -> bool {
    if let Ok(parsed) = PasswordHash::new(stored_hash) {
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    } else {
        false
    }
}

pub fn pick_avatar_color(username: &str) -> &'static str {
    let sum = username
        .bytes()
        .fold(0usize, |acc, b| acc.wrapping_add(b as usize));
    AVATAR_PALETTE[sum % AVATAR_PALETTE.len()]
}

impl<S> FromRequestParts<S> for AuthUser
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = StatusCode;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let app_state = AppState::from_ref(state);
        let raw_token = match extract_cookie_value(&parts.headers, SESSION_COOKIE_NAME) {
            Some(t) if !t.is_empty() => t,
            _ => return Err(StatusCode::UNAUTHORIZED),
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
        .fetch_optional(&app_state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        match maybe_user {
            Some(user) => Ok(user),
            None => Err(StatusCode::UNAUTHORIZED),
        }
    }
}

pub async fn register(
    State(state): State<AppState>,
    Json(payload): Json<RegisterRequest>,
) -> Result<Response, (StatusCode, Json<serde_json::Value>)> {
    let invite_code = payload.invite_code.trim();
    if invite_code != state.config.server_invite_code {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "Invalid invite code" })),
        ));
    }

    let username = payload.username.trim().to_lowercase();
    if username.len() < 3 || username.len() > 32 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Username must be between 3 and 32 characters" })),
        ));
    }
    if !username
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
    {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Username may only contain letters, numbers, dot or underscore" })),
        ));
    }

    let display_name = payload.display_name.trim();
    if display_name.is_empty() || display_name.len() > 32 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Display name must be between 1 and 32 characters" })),
        ));
    }

    if payload.password.len() < 6 || payload.password.len() > 128 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Password must be at least 6 characters" })),
        ));
    }

    let password_hash = hash_password(&payload.password).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        )
    })?;

    let avatar_color = pick_avatar_color(&username);

    let insert_result = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO users (username, display_name, password_hash, avatar_color, mic_gain)
        VALUES (?1, ?2, ?3, ?4, 100)
        RETURNING id
        "#,
    )
    .bind(&username)
    .bind(display_name)
    .bind(&password_hash)
    .bind(avatar_color)
    .fetch_one(&state.db)
    .await;

    let user_id = match insert_result {
        Ok(id) => id,
        Err(sqlx::Error::Database(db_err)) if db_err.is_unique_violation() => {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({ "error": "Username already taken" })),
            ));
        }
        Err(e) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("Database error: {e}") })),
            ));
        }
    };

    let raw_token = generate_raw_token();
    let token_hash = hash_token(&raw_token);

    sqlx::query(
        r#"
        INSERT INTO sessions (token_hash, user_id, expires_at)
        VALUES (?1, ?2, unixepoch() + ?3)
        "#,
    )
    .bind(token_hash)
    .bind(user_id)
    .bind(SESSION_TTL_SECONDS)
    .execute(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Session error: {e}") })),
        )
    })?;

    let user = AuthUser {
        id: user_id,
        username,
        display_name: display_name.to_string(),
        avatar_color: avatar_color.to_string(),
        mic_gain: 100,
    };

    let mut response = Json(user).into_response();
    if let Ok(cookie_val) = HeaderValue::from_str(&build_session_cookie(&raw_token)) {
        response.headers_mut().insert(SET_COOKIE, cookie_val);
    }

    Ok(response)
}

pub async fn login(
    State(state): State<AppState>,
    Json(payload): Json<LoginRequest>,
) -> Result<Response, (StatusCode, Json<serde_json::Value>)> {
    let username = payload.username.trim().to_lowercase();

    #[derive(FromRow)]
    struct StoredUser {
        id: i64,
        username: String,
        display_name: String,
        password_hash: String,
        avatar_color: String,
        mic_gain: i64,
    }

    let user = sqlx::query_as::<_, StoredUser>(
        r#"
        SELECT id, username, display_name, password_hash, avatar_color, mic_gain
        FROM users
        WHERE username = ?1 COLLATE NOCASE
        "#,
    )
    .bind(&username)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Database error: {e}") })),
        )
    })?;

    let user = match user {
        Some(u) => u,
        None => {
            return Err((
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "Invalid username or password" })),
            ));
        }
    };

    if !verify_password(&payload.password, &user.password_hash) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Invalid username or password" })),
        ));
    }

    let raw_token = generate_raw_token();
    let token_hash = hash_token(&raw_token);

    sqlx::query(
        r#"
        INSERT INTO sessions (token_hash, user_id, expires_at)
        VALUES (?1, ?2, unixepoch() + ?3)
        "#,
    )
    .bind(token_hash)
    .bind(user.id)
    .bind(SESSION_TTL_SECONDS)
    .execute(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Session error: {e}") })),
        )
    })?;

    let auth_user = AuthUser {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        avatar_color: user.avatar_color,
        mic_gain: user.mic_gain,
    };

    let mut response = Json(auth_user).into_response();
    if let Ok(cookie_val) = HeaderValue::from_str(&build_session_cookie(&raw_token)) {
        response.headers_mut().insert(SET_COOKIE, cookie_val);
    }

    Ok(response)
}

pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(raw_token) = extract_cookie_value(&headers, SESSION_COOKIE_NAME) {
        let token_hash = hash_token(&raw_token);
        let _ = sqlx::query("DELETE FROM sessions WHERE token_hash = ?1")
            .bind(token_hash)
            .execute(&state.db)
            .await;
    }

    let mut response = Json(json!({ "status": "logged_out" })).into_response();
    if let Ok(cookie_val) = HeaderValue::from_str(&build_clear_cookie()) {
        response.headers_mut().insert(SET_COOKIE, cookie_val);
    }
    response
}

pub async fn me(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<MeResponse>, (StatusCode, Json<serde_json::Value>)> {
    let prefs = sqlx::query_as::<_, AudioPreference>(
        r#"
        SELECT target_username, stream_type, volume
        FROM audio_preferences
        WHERE user_id = ?1
        "#,
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Database error: {e}") })),
        )
    })?;

    Ok(Json(MeResponse {
        user,
        audio_preferences: prefs,
    }))
}
