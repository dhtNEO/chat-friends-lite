use std::time::Duration;
use tracing::{error, info, warn};

pub fn start_duckdns_updater(domain: Option<String>, token: Option<String>) {
    let (domain, token) = match (domain, token) {
        (Some(d), Some(t)) if !d.is_empty() && !t.is_empty() => (d, t),
        _ => {
            info!("DuckDNS updater disabled (domain or token not configured)");
            return;
        }
    };

    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        let url = format!(
            "https://www.duckdns.org/update?domains={}&token={}&ip=",
            domain, token
        );

        let mut interval = tokio::time::interval(Duration::from_secs(300));
        info!("DuckDNS updater active for domain: {}", domain);

        loop {
            interval.tick().await;

            match client.get(&url).send().await {
                Ok(response) => {
                    match response.text().await {
                        Ok(body) => {
                            let status = body.trim();
                            if status == "OK" {
                                info!("DuckDNS update successful for domain: {}", domain);
                            } else {
                                warn!("DuckDNS returned non-OK response ({}): {}", domain, status);
                            }
                        }
                        Err(e) => {
                            warn!("Failed to read DuckDNS response: {}", e);
                        }
                    }
                }
                Err(e) => {
                    error!("DuckDNS request failed: {}", e);
                }
            }
        }
    });
}
