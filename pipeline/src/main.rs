//! Stream pipeline: glasses frames and speech in, governed memories out to MongoDB Atlas.
//!
//!   ingest (frame / utterance)  ->  per-user state in RAM  ->  change gate
//!   ->  extract items  ->  policy  ->  embed  ->  reconcile into `memories`
//!   ->  `audit_events` row per decision, `observations` row per capture

mod api;
mod embed;
mod gate;
mod gemini;
mod policy;
mod process;
mod store;

use std::{
    collections::{HashMap, HashSet, VecDeque},
    fmt::Display,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering::Relaxed},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::Context;
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, FromRequest, Multipart, Query, Request, State},
    http::{header::CONTENT_TYPE, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex};

use process::Trigger;

pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
/// Speech older than this is no longer attached to anything.
const UTTERANCE_KEEP_MS: u64 = 30_000;
/// A spoken note is paired with the current view only if the frame is this recent.
const FRESH_FRAME_MS: u64 = 3_000;
/// A user who has sent nothing for this long is dropped from memory.
const SESSION_IDLE_MS: u64 = 10 * 60 * 1000;
/// How long the gate waits before retrying a user whose last observation failed.
const RETRY_PAUSE_MS: u64 = 5_000;

pub struct Config {
    bind: String,
    mongodb_uri: String,
    db: String,
    /// (variable name, secret) for VOYAGE_API_KEY and every VOYAGE_API_KEY_*.
    voyage_keys: Vec<(String, String)>,
    gemini_key: Option<String>,
    gemini_model: Option<String>,
    gemini_thinking_level: Option<String>,
    gate_tick_ms: u64,
    /// Hash bits that must differ before a frame counts as a new view (0-64).
    phash_threshold: u32,
    /// Frames blurrier than this are skipped. 0 accepts every frame.
    min_sharpness: f64,
    pub observation_ttl_hours: i64,
    /// Live guidance: the lowest vector-search score that counts as "this view is remembered".
    pub guide_min_score: f64,
    /// Live guidance: how long before the same thing is spoken to the same user again.
    pub guide_repeat_ms: u64,
    /// When false, live frames are only searched, never sent to the extraction model.
    index_live_frames: bool,
    /// The address clients reach this server at, for links in events. Taken from the request when not set.
    pub public_base: Option<String>,
}

fn env_or(key: &str, default: &str) -> String {
    env_opt(key).unwrap_or_else(|| default.to_string())
}

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn env_num<T: FromStr>(key: &str, default: T) -> T {
    env_opt(key).and_then(|v| v.parse().ok()).unwrap_or(default)
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let mongodb_uri = env_opt("MONGODB_URI")
            .or_else(|| env_opt("MDB_MCP_CONNECTION_STRING"))
            .context("set MONGODB_URI (or MDB_MCP_CONNECTION_STRING) to the Atlas connection string")?;

        // Several team members' keys can be used at once: VOYAGE_API_KEY_D, _U, _A and so on.
        let mut voyage_keys: Vec<(String, String)> = std::env::vars()
            .filter(|(name, _)| name == "VOYAGE_API_KEY" || name.starts_with("VOYAGE_API_KEY_"))
            .map(|(name, secret)| (name, secret.trim().to_string()))
            .filter(|(_, secret)| !secret.is_empty())
            .collect();
        voyage_keys.sort();
        let mut seen = HashSet::new();
        voyage_keys.retain(|(_, secret)| seen.insert(secret.clone()));
        if voyage_keys.is_empty() {
            anyhow::bail!("set VOYAGE_API_KEY (or VOYAGE_API_KEY_<NAME> for several keys)");
        }

        Ok(Self {
            bind: env_or("BIND_ADDR", "0.0.0.0:8080"),
            mongodb_uri,
            // DB_NAME is the name used in .env.example and db/setup.js.
            db: env_opt("DB_NAME").or_else(|| env_opt("MONGODB_DB")).unwrap_or_else(|| "hackathon".to_string()),
            voyage_keys,
            gemini_key: env_opt("GEMINI_API_KEY"),
            gemini_model: env_opt("GEMINI_MODEL"),
            gemini_thinking_level: env_opt("GEMINI_THINKING_LEVEL"),
            gate_tick_ms: env_num("GATE_TICK_MS", 1500).max(100),
            phash_threshold: env_num("PHASH_THRESHOLD", 10),
            min_sharpness: env_num("MIN_SHARPNESS", 0.0),
            observation_ttl_hours: env_num("OBSERVATION_TTL_HOURS", 24),
            guide_min_score: env_num("GUIDE_MIN_SCORE", 0.80),
            guide_repeat_ms: env_num("GUIDE_REPEAT_SECS", 30_u64) * 1000,
            index_live_frames: env_or("INDEX_LIVE_FRAMES", "true") != "false",
            public_base: env_opt("PUBLIC_BASE"),
        })
    }
}

#[derive(Clone)]
pub struct Frame {
    pub jpeg: Bytes,
    pub at_ms: u64,
    pub hash: u64,
    pub sharpness: f64,
    pub request_id: Option<String>,
}

struct Utterance {
    text: String,
    at_ms: u64,
}

/// Everything held in RAM for one user. Frames never touch the disk.
struct Session {
    venue_id: String,
    session_id: String,
    latest: Option<Frame>,
    last_indexed_hash: Option<u64>,
    last_indexed_at: u64,
    pending: VecDeque<Utterance>,
    /// Set while an observation is being processed, so triggers cannot pile up.
    busy: Arc<AtomicBool>,
    last_seen_ms: u64,
    /// After a failure the gate leaves the session alone until this time.
    hold_until_ms: u64,
    /// Failures in a row, so a fault that will not go away is retried less and less often.
    failures: u32,
    /// When each remembered thing was last spoken to this user by live guidance.
    spoken: HashMap<String, u64>,
}

impl Session {
    fn new(user_id: &str, venue_id: &str) -> Self {
        Self {
            venue_id: venue_id.to_string(),
            session_id: format!("{user_id}-{}", now_ms()),
            latest: None,
            last_indexed_hash: None,
            last_indexed_at: 0,
            pending: VecDeque::new(),
            busy: Arc::default(),
            last_seen_ms: now_ms(),
            hold_until_ms: 0,
            failures: 0,
            spoken: HashMap::new(),
        }
    }

    /// Called on every request. Moving to another space starts from a clean view.
    fn enter(&mut self, venue_id: &str, session_id: Option<String>) {
        self.last_seen_ms = now_ms();
        if self.venue_id != venue_id {
            self.venue_id = venue_id.to_string();
            self.latest = None;
            self.last_indexed_hash = None;
            self.pending.clear();
        }
        if let Some(id) = session_id {
            self.session_id = id;
        }
    }
}

#[derive(Default)]
pub struct Stats {
    frames_in: AtomicU64,
    utterances_in: AtomicU64,
    gate_checks: AtomicU64,
    gate_skips: AtomicU64,
    triggers_visual: AtomicU64,
    triggers_speech: AtomicU64,
    pub observations_logged: AtomicU64,
    pub memories_added: AtomicU64,
    pub memories_reinforced: AtomicU64,
    pub memories_superseded: AtomicU64,
    pub views_stored: AtomicU64,
    pub failed: AtomicU64,
    pub queries_denied: AtomicU64,
    pub guides: AtomicU64,
    pub guide_ms: AtomicU64,
    pub processed: AtomicU64,
    pub extract_ms: AtomicU64,
    pub embed_ms: AtomicU64,
    pub store_ms: AtomicU64,
}

pub struct App {
    pub cfg: Config,
    pub stats: Stats,
    pub embedder: embed::Embedder,
    /// None when no extraction model is configured: captures are logged but no memories are made.
    pub gemini: Option<gemini::Gemini>,
    pub store: store::Store,
    /// For fetching photos the glasses hand over as links.
    pub http: reqwest::Client,
    /// The live feed: everything sent here reaches the dashboards listening on /api/events.
    pub events: broadcast::Sender<api::BusEvent>,
    sessions: Mutex<HashMap<String, Session>>,
}

impl App {
    /// Sends an event to the live feed. Nobody listening is not an error.
    pub fn emit(&self, space_id: &str, name: &'static str, data: Value) {
        let _ = self.events.send(api::BusEvent { space_id: space_id.to_string(), name, data });
    }

    /// Takes in one JPEG for a user: checks it, keeps it as their latest frame
    /// in memory, and tells the live feed.
    pub async fn accept_frame(&self, user_id: &str, venue_id: &str, jpeg: Bytes, session_id: Option<String>, request_id: Option<String>, base: &str) -> Result<Frame, String> {
        if jpeg.is_empty() {
            return Err("the frame is empty".into());
        }
        // Decoding and hashing are CPU work; keep them off the async threads.
        let bytes = jpeg.clone();
        let info = tokio::task::spawn_blocking(move || gate::analyse(&bytes)).await.map_err(|e| e.to_string())?.map_err(|e| format!("not a readable JPEG: {e:#}"))?;
        let frame = Frame { jpeg, at_ms: now_ms(), hash: info.hash, sharpness: info.sharpness, request_id };

        self.stats.frames_in.fetch_add(1, Relaxed);
        {
            let mut sessions = self.sessions.lock().await;
            let session = sessions.entry(user_id.to_string()).or_insert_with(|| Session::new(user_id, venue_id));
            session.enter(venue_id, session_id);
            session.latest = Some(frame.clone());
        }
        let ts = mongodb::bson::DateTime::from_millis(frame.at_ms as i64).try_to_rfc3339_string().unwrap_or_default();
        self.emit(venue_id, "frame", json!({ "user_id": user_id, "ts": ts, "image_url": format!("{base}/api/frame/latest?user_id={user_id}&t={}", frame.at_ms) }));
        Ok(frame)
    }

    /// True if live guidance may speak this thing to this user now; false if
    /// it was spoken too recently. Saying it once is useful, repeating it every
    /// frame is noise.
    pub async fn claim_spoken(&self, user_id: &str, item_key: &str) -> bool {
        let now = now_ms();
        let mut sessions = self.sessions.lock().await;
        let Some(session) = sessions.get_mut(user_id) else { return true };
        let recently = session.spoken.get(item_key).is_some_and(|at| now.saturating_sub(*at) < self.cfg.guide_repeat_ms);
        if !recently {
            session.spoken.insert(item_key.to_string(), now);
        }
        !recently
    }

    /// Records that a frame is being processed outside the gate, so the gate does not pick it up again.
    pub async fn mark_indexed(&self, user_id: &str, frame: &Frame) {
        if let Some(session) = self.sessions.lock().await.get_mut(user_id) {
            session.last_indexed_hash = Some(frame.hash);
            session.last_indexed_at = frame.at_ms;
        }
    }

    /// After a failed observation: put the spoken note back and let the same
    /// view trigger again, once a short pause has passed. Notes expire after
    /// 30 seconds, which bounds how long a note is retried.
    pub async fn after_failure(&self, trigger: &Trigger) {
        let mut sessions = self.sessions.lock().await;
        let Some(session) = sessions.get_mut(&trigger.user_id) else { return };
        // The user has moved to another space: what failed belongs to the old one.
        if session.venue_id != trigger.venue_id {
            return;
        }
        if let Some(at_ms) = trigger.text_at_ms {
            session.pending.push_front(Utterance { text: trigger.text.clone(), at_ms });
        }
        if trigger.frame.is_some() {
            session.last_indexed_hash = None;
            session.last_indexed_at = 0;
        }
        // 5 s, 10 s, 20 s ... up to about 5 minutes between tries.
        session.failures += 1;
        session.hold_until_ms = now_ms() + (RETRY_PAUSE_MS << (session.failures - 1).min(6));
    }

    pub async fn after_success(&self, user_id: &str) {
        if let Some(session) = self.sessions.lock().await.get_mut(user_id) {
            session.failures = 0;
        }
    }

    /// 404 unless the space exists and the user is one of its members.
    async fn require_member(&self, space_id: &str, user_id: &str) -> Result<(), Rejection> {
        let space = self.store.space(space_id).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))?;
        let space = space.ok_or_else(|| (StatusCode::NOT_FOUND, format!("unknown space_id '{space_id}'")))?;
        space.role_of(user_id).map(|_| ()).ok_or_else(|| (StatusCode::NOT_FOUND, format!("unknown user_id '{user_id}'")))
    }
}

pub async fn build_app(cfg: Config) -> anyhow::Result<Arc<App>> {
    let store = store::Store::connect(&cfg.mongodb_uri, &cfg.db).await?;
    let embedder = embed::Embedder::new(cfg.voyage_keys.clone())?;
    let gemini = match (&cfg.gemini_key, &cfg.gemini_model) {
        (Some(key), Some(model)) => Some(gemini::Gemini::new(key.clone(), model, cfg.gemini_thinking_level.clone())?),
        (Some(_), None) => anyhow::bail!("GEMINI_API_KEY is set but GEMINI_MODEL is not; set it to the model id to use"),
        (None, _) => None,
    };
    let (events, _) = broadcast::channel(256);
    Ok(Arc::new(App { stats: Stats::default(), embedder, gemini, store, http: reqwest::Client::new(), events, sessions: Mutex::default(), cfg }))
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

type Rejection = (StatusCode, String);

fn bad_request(e: impl Display) -> Rejection {
    (StatusCode::BAD_REQUEST, e.to_string())
}

fn required(value: Option<String>, name: &str) -> Result<String, Rejection> {
    value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).ok_or_else(|| bad_request(format!("{name} is required")))
}

#[derive(Deserialize, Default)]
struct FrameMeta {
    user_id: Option<String>,
    /// The space id. `venue_id` is the older name for the same thing.
    #[serde(alias = "space_id")]
    venue_id: Option<String>,
    session_id: Option<String>,
    mentra_request_id: Option<String>,
}

async fn read_multipart(req: Request) -> Result<(FrameMeta, Bytes), Rejection> {
    let mut form = Multipart::from_request(req, &()).await.map_err(bad_request)?;
    let (mut meta, mut jpeg) = (FrameMeta::default(), Bytes::new());
    while let Some(field) = form.next_field().await.map_err(bad_request)? {
        let name = field.name().unwrap_or_default().to_string();
        // The image is the part sent as a file, whatever the sender named it.
        let is_file = field.file_name().is_some() || field.content_type().is_some_and(|c| c.starts_with("image/"));
        match name.as_str() {
            "user_id" => meta.user_id = Some(field.text().await.map_err(bad_request)?),
            "space_id" | "venue_id" => meta.venue_id = Some(field.text().await.map_err(bad_request)?),
            "session_id" => meta.session_id = Some(field.text().await.map_err(bad_request)?),
            "mentra_request_id" => meta.mentra_request_id = Some(field.text().await.map_err(bad_request)?),
            _ if is_file => jpeg = field.bytes().await.map_err(bad_request)?,
            _ => {} // extra text fields are ignored
        }
    }
    Ok((meta, jpeg))
}

/// POST /api/ingest/frame: one JPEG, either as a multipart form (fields `user_id`,
/// `venue_id`, plus the image) or as the raw body with those as query parameters.
async fn ingest_frame(State(app): State<Arc<App>>, req: Request) -> Result<StatusCode, Rejection> {
    let base = api::public_base(&app, req.headers());
    let multipart = req.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.starts_with("multipart/form-data"));
    let (meta, jpeg) = if multipart {
        read_multipart(req).await?
    } else {
        let Query(meta) = Query::<FrameMeta>::try_from_uri(req.uri()).map_err(bad_request)?;
        (meta, axum::body::to_bytes(req.into_body(), MAX_FRAME_BYTES).await.map_err(bad_request)?)
    };
    let user_id = required(meta.user_id, "user_id")?;
    let venue_id = required(meta.venue_id, "space_id")?;
    app.require_member(&venue_id, &user_id).await?;
    app.accept_frame(&user_id, &venue_id, jpeg, meta.session_id, meta.mentra_request_id, &base).await.map_err(bad_request)?;
    Ok(StatusCode::ACCEPTED)
}

#[derive(Deserialize)]
struct UtteranceBody {
    text: String,
    user_id: Option<String>,
    #[serde(alias = "space_id")]
    venue_id: Option<String>,
    session_id: Option<String>,
}

/// POST /api/ingest/utterance: {"text": "...", "user_id": "...", "venue_id": "..."}
async fn ingest_utterance(State(app): State<Arc<App>>, Json(body): Json<UtteranceBody>) -> Result<StatusCode, Rejection> {
    let user_id = required(body.user_id, "user_id")?;
    let venue_id = required(body.venue_id, "space_id")?;
    app.require_member(&venue_id, &user_id).await?;
    let text = required(Some(body.text), "text")?;

    app.stats.utterances_in.fetch_add(1, Relaxed);
    let mut sessions = app.sessions.lock().await;
    let session = sessions.entry(user_id.clone()).or_insert_with(|| Session::new(&user_id, &venue_id));
    session.enter(&venue_id, body.session_id);
    session.pending.push_back(Utterance { text, at_ms: now_ms() });
    Ok(StatusCode::ACCEPTED)
}

#[derive(Deserialize)]
struct UserQuery {
    user_id: String,
}

/// GET /api/frame/latest?user_id=..: the user's current frame, for a live view.
async fn latest_frame(State(app): State<Arc<App>>, Query(q): Query<UserQuery>) -> Response {
    let sessions = app.sessions.lock().await;
    match sessions.get(&q.user_id).and_then(|s| s.latest.as_ref()) {
        Some(frame) => ([(CONTENT_TYPE, "image/jpeg")], frame.jpeg.clone()).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn health() -> &'static str {
    "ok"
}

async fn stats(State(app): State<Arc<App>>) -> Json<Value> {
    let s = &app.stats;
    let processed = s.processed.load(Relaxed);
    let avg = |total: &AtomicU64| if processed == 0 { 0 } else { total.load(Relaxed) / processed };
    Json(json!({
        "extraction_enabled": app.gemini.is_some(),
        "frames_in": s.frames_in.load(Relaxed),
        "utterances_in": s.utterances_in.load(Relaxed),
        "gate": {
            "checks": s.gate_checks.load(Relaxed),
            "skipped_no_change": s.gate_skips.load(Relaxed),
            "triggers_visual": s.triggers_visual.load(Relaxed),
            "triggers_speech": s.triggers_speech.load(Relaxed),
        },
        "observations_logged": s.observations_logged.load(Relaxed),
        "memories": {
            "added": s.memories_added.load(Relaxed),
            "reinforced": s.memories_reinforced.load(Relaxed),
            "superseded": s.memories_superseded.load(Relaxed),
            "views": s.views_stored.load(Relaxed),
        },
        "failed": s.failed.load(Relaxed),
        "queries_denied": s.queries_denied.load(Relaxed),
        "live_guidance": { "frames": s.guides.load(Relaxed), "avg_ms": s.guide_ms.load(Relaxed).checked_div(s.guides.load(Relaxed)).unwrap_or(0) },
        "avg_ms": { "extract": avg(&s.extract_ms), "embed": avg(&s.embed_ms), "store": avg(&s.store_ms) },
    }))
}

/// Decides whether a session has something new: a changed, sharp view or a
/// spoken note. Returns None when nothing happened, which costs no API calls.
fn evaluate(cfg: &Config, user_id: &str, session: &mut Session, now: u64) -> Option<Trigger> {
    // Some(distance) when the view changed; the distance is None for a first frame.
    let visual = session.latest.as_ref().filter(|f| f.at_ms > session.last_indexed_at).and_then(|f| {
        let distance = session.last_indexed_hash.map(|h| gate::distance(h, f.hash));
        let changed = distance.is_none_or(|d| d > cfg.phash_threshold);
        (cfg.index_live_frames && changed && f.sharpness >= cfg.min_sharpness).then_some(distance)
    });
    let has_notes = session.pending.iter().any(|u| gate::is_note(&u.text));
    if visual.is_none() && !has_notes {
        return None;
    }

    let (notes, rest): (Vec<Utterance>, Vec<Utterance>) = session.pending.drain(..).partition(|u| gate::is_note(&u.text));
    session.pending = rest.into();

    // A changed view always carries its frame; a spoken note carries the current view only if it is recent.
    let frame = session.latest.clone().filter(|f| visual.is_some() || now.saturating_sub(f.at_ms) <= FRESH_FRAME_MS);
    if let Some(f) = &frame {
        session.last_indexed_hash = Some(f.hash);
        session.last_indexed_at = f.at_ms;
    }
    Some(Trigger {
        user_id: user_id.to_string(),
        venue_id: session.venue_id.clone(),
        session_id: session.session_id.clone(),
        frame,
        text_at_ms: notes.last().map(|u| u.at_ms),
        text: notes.iter().map(|u| u.text.as_str()).collect::<Vec<_>>().join(" "),
        reason: if has_notes { "speech_keyword" } else { "visual_change" },
        phash_distance: visual.flatten(),
    })
}

/// The change gate: checks every session on a timer and starts processing only when something changed.
async fn gate_loop(app: Arc<App>) {
    let mut tick = tokio::time::interval(Duration::from_millis(app.cfg.gate_tick_ms));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        let now = now_ms();
        let mut triggers = Vec::new();
        {
            let mut sessions = app.sessions.lock().await;
            // Forget users who have gone quiet, so their last frame does not stay in memory.
            sessions.retain(|_, s| s.busy.load(Relaxed) || now.saturating_sub(s.last_seen_ms) < SESSION_IDLE_MS);
            for (user_id, session) in sessions.iter_mut() {
                // One observation per user at a time; whatever arrives meanwhile waits for the next tick.
                if session.busy.load(Relaxed) || now < session.hold_until_ms {
                    continue;
                }
                session.pending.retain(|u| now.saturating_sub(u.at_ms) <= UTTERANCE_KEEP_MS);
                app.stats.gate_checks.fetch_add(1, Relaxed);
                match evaluate(&app.cfg, user_id, session, now) {
                    Some(trigger) => {
                        session.busy.store(true, Relaxed);
                        triggers.push((trigger, session.busy.clone()));
                    }
                    None => {
                        app.stats.gate_skips.fetch_add(1, Relaxed);
                    }
                }
            }
        }
        for (trigger, busy) in triggers {
            let counter = if trigger.reason == "speech_keyword" { &app.stats.triggers_speech } else { &app.stats.triggers_visual };
            counter.fetch_add(1, Relaxed);
            tokio::spawn(process::run(app.clone(), trigger, busy));
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv(); // .env is optional; real environment variables win
    tracing_subscriber::fmt().with_max_level(tracing::Level::INFO).init();

    let app = build_app(Config::from_env()?).await?;
    tracing::info!(keys = ?app.embedder.key_names(), "embedding keys loaded");
    if app.gemini.is_none() {
        tracing::warn!("GEMINI_API_KEY and GEMINI_MODEL are not both set: captures will be logged to `observations`, but no memories will be created");
    }
    tokio::spawn(gate_loop(app.clone()));
    // MongoDB change streams drive the dashboard's live feed.
    tokio::spawn(api::watch(app.clone(), "memories"));
    tokio::spawn(api::watch(app.clone(), "audit_events"));
    tokio::spawn(api::expire_loop(app.clone()));

    let router = Router::new()
        .route("/api/ingest/frame", post(ingest_frame))
        .route("/api/ingest/utterance", post(ingest_utterance))
        .route("/api/frame/latest", get(latest_frame))
        // The frontend contract (docs/api-contract.md).
        .route("/api/state", get(api::state))
        .route("/api/turn", post(api::turn))
        .route("/api/frames", post(api::frames))
        .route("/api/rules", put(api::put_rules))
        .route("/api/events", get(api::events))
        .route("/api/health", get(api::health))
        .route("/health", get(health))
        .route("/healthz", get(health))
        .route("/stats", get(stats))
        // A base64 image in JSON is a third larger than the image itself.
        .layer(DefaultBodyLimit::max(MAX_FRAME_BYTES * 3 / 2))
        .layer(axum::middleware::from_fn(api::cors))
        .with_state(app.clone());

    let listener = tokio::net::TcpListener::bind(&app.cfg.bind).await.with_context(|| format!("binding {}", app.cfg.bind))?;
    tracing::info!(bind = %app.cfg.bind, db = %app.cfg.db, gate_tick_ms = app.cfg.gate_tick_ms, "pipeline listening");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
