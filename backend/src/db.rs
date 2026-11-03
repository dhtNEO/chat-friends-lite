use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};
use std::str::FromStr;
use std::time::Duration;
use tracing::{error, info};

/// Tempo de retenção do chat efêmero: 7 dias em segundos (7 * 86400)
pub const CHAT_RETENTION_SECONDS: i64 = 7 * 86_400;

async fn prune_expired_data(pool: &SqlitePool) {
    // 1. Limpa sessões expiradas
    match sqlx::query("DELETE FROM sessions WHERE expires_at < unixepoch()")
        .execute(pool)
        .await
    {
        Ok(result) => {
            let count = result.rows_affected();
            if count > 0 {
                info!("Pruned {count} expired session(s)");
            }
        }
        Err(e) => {
            error!("Error purging expired sessions: {e}");
        }
    }

    // 2. Limpa mensagens (e fotos/reações em cascata via ON DELETE CASCADE) com mais de 7 dias
    match sqlx::query("DELETE FROM messages WHERE created_at < unixepoch() - ?1")
        .bind(CHAT_RETENTION_SECONDS)
        .execute(pool)
        .await
    {
        Ok(result) => {
            let count = result.rows_affected();
            if count > 0 {
                info!("Pruned {count} expired chat message(s) older than 7 days");
                let _ = sqlx::query("PRAGMA wal_checkpoint(PASSIVE)")
                    .execute(pool)
                    .await;
                let _ = sqlx::query("PRAGMA optimize").execute(pool).await;
            }
        }
        Err(e) => {
            error!("Error purging expired chat messages: {e}");
        }
    }
}

pub async fn init_db(database_url: &str) -> Result<SqlitePool, sqlx::Error> {
    let connect_options = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(connect_options)
        .await?;

    // Execute migrations located at backend/migrations
    sqlx::migrate!("./migrations").run(&pool).await?;
    info!("SQLite database initialized and migrations applied");

    // Executa limpeza inicial na subida e depois a cada 1 hora em background
    let cleanup_pool = pool.clone();
    tokio::spawn(async move {
        prune_expired_data(&cleanup_pool).await;

        let mut interval = tokio::time::interval(Duration::from_secs(3600));
        interval.tick().await; // consume immediate first tick

        loop {
            interval.tick().await;
            prune_expired_data(&cleanup_pool).await;
        }
    });

    Ok(pool)
}
