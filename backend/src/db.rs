use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};
use std::str::FromStr;
use std::time::Duration;
use tracing::{error, info};

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

    // Background worker: clean expired sessions every 1 hour
    let cleanup_pool = pool.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3600));
        interval.tick().await; // consume immediate first tick

        loop {
            interval.tick().await;
            match sqlx::query("DELETE FROM sessions WHERE expires_at < unixepoch()")
                .execute(&cleanup_pool)
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
        }
    });

    Ok(pool)
}
