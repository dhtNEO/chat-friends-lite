mod auth;
mod chat;
mod config;
mod db;
mod duckdns;
mod media;

use axum::{
    routing::{get, post, put},
    Json, Router,
};
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::{
    compression::CompressionLayer,
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing::info;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<config::Config>,
    pub db: sqlx::SqlitePool,
    pub chat_tx: broadcast::Sender<String>,
}

async fn health_check() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok" }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,chat_friends_backend=debug,tower_http=info".into()),
        )
        .init();

    info!("Starting Chat Friends Backend v2.0...");

    let config = Arc::new(config::Config::from_env().map_err(|e| {
        tracing::error!("Configuration error: {e}");
        e
    })?);

    info!("Connecting to SQLite database: {}", config.database_url);
    let pool = db::init_db(&config.database_url).await?;

    // Background updater for DuckDNS
    duckdns::start_duckdns_updater(
        config.duckdns_domain.clone(),
        config.duckdns_token.clone(),
    );

    // Channel for real-time WebSocket chat and room events
    let (chat_tx, _) = broadcast::channel::<String>(256);

    let state = AppState {
        config: config.clone(),
        db: pool,
        chat_tx,
    };

    let api_routes = Router::new()
        .route("/health", get(health_check))
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(auth::me))
        .route(
            "/messages",
            get(chat::get_messages).post(chat::create_message),
        )
        .route("/media/token", post(media::generate_token))
        .route("/media/preferences", put(media::set_audio_preference))
        .route("/media/mic-gain", put(media::set_mic_gain));

    let index_file = ServeFile::new(format!("{}/index.html", config.static_dir));
    let serve_dir = ServeDir::new(&config.static_dir).fallback(index_file);

    let app = Router::new()
        .nest("/api", api_routes)
        .route("/ws", get(chat::ws_handler))
        .fallback_service(serve_dir)
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    info!("Server listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("Server shutdown completed gracefully.");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {
            info!("Received SIGINT (Ctrl+C), initiating graceful shutdown");
        },
        _ = terminate => {
            info!("Received SIGTERM, initiating graceful shutdown");
        },
    }
}
