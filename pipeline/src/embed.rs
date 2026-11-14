//! Voyage multimodal embeddings: turns a frame and/or text into a 1024-number
//! vector for Atlas Vector Search. It only produces vectors; naming what is in
//! a frame is the extraction model's job.

use std::{
    sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed},
    time::Duration,
};

use anyhow::{bail, Context};
use serde::Deserialize;
use serde_json::json;

pub const MODEL: &str = "voyage-multimodal-3.5";
pub const DIMENSIONS: usize = 1024;
const ATLAS_URL: &str = "https://ai.mongodb.com/v1/multimodalembeddings";
const VOYAGE_URL: &str = "https://api.voyageai.com/v1/multimodalembeddings";
/// How many times each key is tried before a request is given up on.
const ROUNDS: usize = 4;

/// One thing to embed: text, optionally together with a JPEG (base64, no data-URL prefix).
pub struct Input<'a> {
    pub text: String,
    pub jpeg_b64: Option<&'a str>,
}

#[derive(Deserialize)]
struct ApiResponse {
    data: Vec<ApiItem>,
    usage: Option<ApiUsage>,
}

#[derive(Deserialize)]
struct ApiItem {
    embedding: Vec<f32>,
    #[serde(default)]
    index: usize,
}

#[derive(Deserialize)]
struct ApiUsage {
    total_tokens: u64,
}

struct ApiKey {
    /// The environment variable it came from. Safe to log; the secret is not.
    name: String,
    secret: String,
    url: &'static str,
    /// Set once the service rejects the key, so it is not tried again.
    rejected: AtomicBool,
}

/// Spreads requests across every configured key and moves to the next one
/// when a key is rate-limited or rejected.
pub struct Embedder {
    http: reqwest::Client,
    keys: Vec<ApiKey>,
    next: AtomicUsize,
}

impl Embedder {
    /// `keys` are (environment variable name, secret) pairs. Keys created in
    /// Atlas start with "al-" and use the Atlas endpoint; all others are
    /// Voyage account keys.
    pub fn new(keys: Vec<(String, String)>) -> anyhow::Result<Self> {
        if keys.is_empty() {
            bail!("no embedding API key configured");
        }
        let mut keys: Vec<ApiKey> = keys
            .into_iter()
            .map(|(name, secret)| {
                let url = if secret.starts_with("al-") { ATLAS_URL } else { VOYAGE_URL };
                ApiKey { name, secret, url, rejected: AtomicBool::new(false) }
            })
            .collect();
        // Atlas model keys first: that endpoint answers about twice as fast.
        keys.sort_by_key(|k| k.url != ATLAS_URL);
        // One shared client keeps TLS connections open between requests.
        let http = reqwest::Client::builder().timeout(Duration::from_secs(60)).build()?;
        Ok(Self { http, keys, next: AtomicUsize::new(0) })
    }

    pub fn key_names(&self) -> Vec<&str> {
        self.keys.iter().map(|k| k.name.as_str()).collect()
    }

    /// Embeds all inputs in one request and returns one vector per input, in
    /// order, plus the tokens used. `input_type` is "document" for stored
    /// memories and "query" for questions.
    pub async fn embed(&self, inputs: &[Input<'_>], input_type: &str) -> anyhow::Result<(Vec<Vec<f32>>, u64)> {
        if inputs.is_empty() {
            return Ok((Vec::new(), 0));
        }
        let api_inputs: Vec<_> = inputs
            .iter()
            .map(|input| {
                let mut content = Vec::new();
                if !input.text.is_empty() {
                    content.push(json!({ "type": "text", "text": input.text }));
                }
                if let Some(b64) = input.jpeg_b64 {
                    content.push(json!({ "type": "image_base64", "image_base64": format!("data:image/jpeg;base64,{b64}") }));
                }
                json!({ "content": content })
            })
            .collect();
        let body = json!({ "inputs": api_inputs, "model": MODEL, "input_type": input_type, "output_dimension": DIMENSIONS });

        // Each request starts on the next key in turn. A failed attempt moves
        // straight to the following key; the backoff sleep only happens once
        // every key has had a try.
        let n = self.keys.len();
        // Someone is waiting on a query, so it starts on the fastest key.
        // Stored memories are spread across all keys.
        let first = if input_type == "query" { 0 } else { self.next.fetch_add(1, Relaxed) };
        let max_attempts = ROUNDS * n;
        let mut delay = Duration::from_millis(250);
        for attempt in 0..max_attempts {
            let key = &self.keys[(first + attempt) % n];
            let last = attempt + 1 == max_attempts;
            if key.rejected.load(Relaxed) && !last && self.keys.iter().any(|k| !k.rejected.load(Relaxed)) {
                continue;
            }
            match self.http.post(key.url).bearer_auth(&key.secret).json(&body).send().await {
                Ok(resp) if resp.status().is_success() => {
                    let mut parsed: ApiResponse = resp.json().await.context("parsing embedding response")?;
                    if parsed.data.len() != inputs.len() {
                        bail!("embedding API returned {} vectors for {} inputs", parsed.data.len(), inputs.len());
                    }
                    parsed.data.sort_by_key(|item| item.index);
                    let tokens = parsed.usage.map_or(0, |u| u.total_tokens);
                    return Ok((parsed.data.into_iter().map(|item| item.embedding).collect(), tokens));
                }
                Ok(resp) => {
                    let status = resp.status();
                    // A rejected key (401/403) is worth retrying only if another key can take over.
                    let rejected = matches!(status.as_u16(), 401 | 403) && n > 1;
                    if rejected {
                        key.rejected.store(true, Relaxed);
                    }
                    let retryable = rejected || status.as_u16() == 429 || status.is_server_error();
                    if !retryable || last {
                        let detail = resp.text().await.unwrap_or_default();
                        bail!("embedding API returned {status} for {}: {detail}", key.name);
                    }
                    tracing::warn!(%status, key = %key.name, "embedding request failed, trying again");
                }
                Err(e) if last => return Err(e).context("embedding request failed"),
                Err(e) => tracing::warn!(key = %key.name, "embedding request error, trying again: {e}"),
            }
            if (attempt + 1) % n != 0 {
                continue;
            }
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
        unreachable!("the last attempt always returns")
    }
}
