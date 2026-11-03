use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub database_url: String,
    pub static_dir: String,
    pub server_invite_code: String,
    pub livekit_api_key: String,
    pub livekit_api_secret: String,
    pub livekit_url: String,
    pub duckdns_domain: Option<String>,
    pub duckdns_token: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let port = match env::var("PORT") {
            Ok(p) => p
                .parse::<u16>()
                .map_err(|e| format!("Invalid PORT environment variable: {e}"))?,
            Err(_) => 8080,
        };

        let database_url = env::var("DATABASE_URL")
            .unwrap_or_else(|_| "sqlite:///data/chatfriends.db?mode=rwc".to_string());

        let static_dir = env::var("STATIC_DIR")
            .unwrap_or_else(|_| "/app/static".to_string());

        let server_invite_code = env::var("SERVER_INVITE_CODE")
            .map_err(|_| "Missing required environment variable: SERVER_INVITE_CODE".to_string())?;

        let livekit_api_key = env::var("LIVEKIT_API_KEY")
            .map_err(|_| "Missing required environment variable: LIVEKIT_API_KEY".to_string())?;

        let livekit_api_secret = env::var("LIVEKIT_API_SECRET")
            .map_err(|_| "Missing required environment variable: LIVEKIT_API_SECRET".to_string())?;

        let livekit_url = env::var("LIVEKIT_URL")
            .map_err(|_| "Missing required environment variable: LIVEKIT_URL".to_string())?
            .trim()
            .trim_end_matches('/')
            .trim_end_matches("/rtc")
            .to_string();

        let duckdns_domain = env::var("DUCKDNS_DOMAIN")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let duckdns_token = env::var("DUCKDNS_TOKEN")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        Ok(Self {
            port,
            database_url,
            static_dir,
            server_invite_code,
            livekit_api_key,
            livekit_api_secret,
            livekit_url,
            duckdns_domain,
            duckdns_token,
        })
    }
}
