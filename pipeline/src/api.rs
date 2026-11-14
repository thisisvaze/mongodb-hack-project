//! The frontend contract (docs/api-contract.md). The dashboard, the capture
//! page and the glasses app all talk to these endpoints. Documents in MongoDB
//! already use the contract's field names, so mapping is mostly `_id` -> `id`
//! and dates -> ISO strings.

use std::{collections::HashSet, convert::Infallible, sync::atomic::Ordering::Relaxed, sync::Arc, time::Duration};

use axum::{
    body::Bytes,
    extract::{Query, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures_util::{stream, Stream, StreamExt};
use mongodb::{
    bson::{Bson, DateTime, Document},
    change_stream::event::OperationType,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

use crate::{
    embed::Input,
    guard, now_ms,
    policy::{Rules, Scope, Space},
    process::{self, audit_event, injection_audit, spaced, Trigger},
    App, Frame, MAX_FRAME_BYTES,
};

/// How long a forgotten or expired memory stays listed (without its content) before MongoDB deletes it.
const PURGE_AFTER_MS: i64 = 10 * 60 * 1000;

/// One message on the live feed.
#[derive(Clone)]
pub struct BusEvent {
    pub space_id: String,
    pub name: &'static str,
    pub data: Value,
}

pub struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        let e = e.into();
        tracing::error!("request failed: {e:#}");
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}"))
    }
}

fn not_found(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::NOT_FOUND, message.into())
}

fn bad_request(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}

/// Browsers on another origin (the dashboard, a phone) must be allowed to call the API.
pub async fn cors(req: Request, next: Next) -> Response {
    let mut response = if req.method() == Method::OPTIONS { StatusCode::NO_CONTENT.into_response() } else { next.run(req).await };
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, PUT, OPTIONS"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("Content-Type"));
    response
}

/// The address clients should use to reach this server, for links in events.
pub fn public_base(app: &App, headers: &HeaderMap) -> String {
    if let Some(base) = &app.cfg.public_base {
        return base.trim_end_matches('/').to_string();
    }
    let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let proto = get("x-forwarded-proto").unwrap_or("http");
    let host = get("x-forwarded-host").or_else(|| get("host")).unwrap_or("127.0.0.1:8080");
    format!("{proto}://{host}")
}

// --- MongoDB documents -> contract objects -----------------------------------

fn id_string(value: Option<&Bson>) -> Option<String> {
    match value {
        Some(Bson::String(s)) => Some(s.clone()),
        Some(Bson::ObjectId(oid)) => Some(oid.to_hex()),
        _ => None,
    }
}

fn iso(doc: &Document, key: &str) -> Option<String> {
    doc.get_datetime(key).ok().and_then(|d| d.try_to_rfc3339_string().ok())
}

/// The contract's Memory. Backend-only fields (embedding, tactile_anchor, ...) are left out.
pub fn memory_json(doc: &Document) -> Value {
    json!({
        "id": id_string(doc.get("_id")),
        "space_id": doc.get_str("space_id").unwrap_or_default(),
        "owner_id": doc.get_str("owner_id").unwrap_or_default(),
        "item": doc.get_str("item").unwrap_or_default(),
        "summary": doc.get_str("summary").unwrap_or_default(),
        "location": doc.get_str("location").ok(),
        "topic": doc.get_str("topic").unwrap_or("other"),
        "group": doc.get_str("group").unwrap_or_default(),
        "source": doc.get_str("source").unwrap_or("voice"),
        "status": doc.get_str("status").unwrap_or("active"),
        "superseded_by": id_string(doc.get("superseded_by")),
        "created_at": iso(doc, "created_at"),
        "updated_at": iso(doc, "updated_at"),
        "expires_at": iso(doc, "expires_at"),
        "image_url": doc.get_str("image_url").ok(),
    })
}

/// The contract's AuditEntry.
pub fn audit_json(doc: &Document) -> Value {
    json!({
        "id": id_string(doc.get("_id")),
        "ts": iso(doc, "ts"),
        "space_id": doc.get_str("space_id").unwrap_or_default(),
        "actor_id": doc.get_str("actor_id").unwrap_or_default(),
        "action": doc.get_str("action").unwrap_or_default(),
        "verdict": doc.get_str("verdict").unwrap_or("info"),
        "detail": doc.get_str("detail").unwrap_or_default(),
        "memory_ids": doc.get_array("memory_ids").map(|ids| ids.iter().filter_map(|id| id_string(Some(id))).collect::<Vec<_>>()).unwrap_or_default(),
    })
}

// --- GET /api/state, PUT /api/rules ------------------------------------------

#[derive(Deserialize)]
pub struct SpaceQuery {
    space_id: String,
    /// True to include stored views (one per indexed frame) in the memory list.
    #[serde(default)]
    views: bool,
}

async fn load_space(app: &App, space_id: &str) -> Result<Space, ApiError> {
    app.store.space(space_id).await?.ok_or_else(|| not_found(format!("unknown space_id '{space_id}'")))
}

/// The user's role in the space, or 404: only members of a space may use it.
fn role_in<'a>(space: &'a Space, user_id: &str) -> Result<&'a str, ApiError> {
    space.role_of(user_id).ok_or_else(|| not_found(format!("unknown user_id '{user_id}'")))
}

pub async fn state(State(app): State<Arc<App>>, Query(q): Query<SpaceQuery>) -> Result<Json<Value>, ApiError> {
    let space = load_space(&app, &q.space_id).await?;
    let (memories, audit) = tokio::try_join!(app.store.list_memories(&q.space_id), app.store.list_audit(&q.space_id))?;
    Ok(Json(json!({
        "space_id": q.space_id,
        "users": space.members,
        "rules": space.rules,
        "memories": memories.iter().filter(|m| q.views || !is_view(m)).map(memory_json).collect::<Vec<_>>(),
        "audit": audit.iter().map(audit_json).collect::<Vec<_>>(),
    })))
}

pub async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}

/// Replaces the space's rules. New rules apply to the next memory stored and
/// the next question asked; memories already stored keep their group. A
/// refused change is recorded too.
pub async fn put_rules(State(app): State<Arc<App>>, Query(q): Query<SpaceQuery>, Json(rules): Json<Rules>) -> Result<Json<Value>, ApiError> {
    let space = load_space(&app, &q.space_id).await?;
    let rules = match rules.validate(Some(&space)) {
        Ok(rules) => rules,
        Err(message) => {
            let detail = format!("Rule change rejected: {message}.");
            app.store.insert_audit(audit_event(&q.space_id, "dashboard", "rule_changed", "denied", detail, vec![], None)).await?;
            return Err(bad_request(message));
        }
    };
    app.store.set_rules(&q.space_id, &rules).await?;
    app.store.insert_audit(audit_event(&q.space_id, "dashboard", "rule_changed", "info", space.rules.describe_change(&rules), vec![], None)).await?;
    app.emit(&q.space_id, "rules", json!({ "rules": rules }));
    Ok(Json(json!({ "ok": true, "rules": rules })))
}

// --- Images ------------------------------------------------------------------

/// A JPEG sent inline, or fetched from the glasses' short-lived signed link.
async fn load_image(app: &App, image_b64: Option<String>, image_url: Option<String>) -> anyhow::Result<Option<Bytes>> {
    if let Some(b64) = image_b64.filter(|s| !s.is_empty()) {
        let data = b64.rsplit(',').next().unwrap_or(&b64); // tolerate a data: prefix
        return Ok(Some(Bytes::from(B64.decode(data.trim())?)));
    }
    if let Some(url) = image_url.filter(|s| s.starts_with("https://") || s.starts_with("http://")) {
        let response = app.http.get(&url).timeout(Duration::from_secs(10)).send().await?.error_for_status()?;
        let bytes = response.bytes().await?;
        anyhow::ensure!(bytes.len() <= MAX_FRAME_BYTES, "the image is larger than {MAX_FRAME_BYTES} bytes");
        return Ok(Some(bytes));
    }
    Ok(None)
}

// --- POST /api/frames and live guidance --------------------------------------

#[derive(Deserialize)]
pub struct FrameBody {
    space_id: String,
    user_id: String,
    /// True: run this frame through extraction now and wait for it, instead of
    /// leaving it to the change gate. For indexing a recorded video frame by frame.
    #[serde(default)]
    index: bool,
    #[serde(default)]
    image_b64: Option<String>,
    #[serde(default)]
    image_url: Option<String>,
}

/// A camera frame with no speech. It becomes the user's latest frame, is
/// searched straight away for what is already remembered about this view, and
/// goes through the change gate to be indexed in the background.
pub async fn frames(State(app): State<Arc<App>>, headers: HeaderMap, Json(body): Json<FrameBody>) -> Result<Json<Value>, ApiError> {
    let space = load_space(&app, &body.space_id).await?;
    role_in(&space, &body.user_id)?;
    let jpeg = load_image(&app, body.image_b64, body.image_url)
        .await
        .map_err(|e| bad_request(format!("could not read the image: {e:#}")))?
        .ok_or_else(|| bad_request("image_b64 or image_url is required"))?;
    let frame = app.accept_frame(&body.user_id, &body.space_id, jpeg, None, None, &public_base(&app, &headers)).await.map_err(bad_request)?;

    if body.index {
        app.mark_indexed(&body.user_id, &frame).await;
        let trigger = Trigger {
            user_id: body.user_id.clone(),
            venue_id: body.space_id.clone(),
            session_id: format!("{}-index", body.user_id),
            frame: Some(frame),
            text: String::new(),
            text_at_ms: None,
            reason: "manual",
            phash_distance: None,
        };
        let stored = process::observe(&app, &trigger).await?;
        return Ok(Json(json!({ "ok": true, "indexed": stored.iter().map(|s| json!({ "id": s.id, "summary": s.summary })).collect::<Vec<_>>() })));
    }

    // Live guidance. A failure here must not fail the frame itself.
    let mut response = json!({ "ok": true, "say": null, "matches": [] });
    match guide(&app, &body.space_id, &body.user_id, &space.scope_for(&body.user_id), &frame).await {
        Ok(guidance) => {
            response["say"] = guidance["say"].clone();
            response["matches"] = guidance["matches"].clone();
            response["ms"] = guidance["ms"].clone();
            if !guidance["say"].is_null() {
                app.emit(&body.space_id, "guide", json!({ "user_id": body.user_id, "say": guidance["say"], "matches": guidance["matches"] }));
            }
        }
        Err(e) => tracing::warn!(user = %body.user_id, "live guidance failed: {e:#}"),
    }
    Ok(Json(response))
}

fn is_view(memory: &Document) -> bool {
    memory.get_str("item_key").is_ok_and(|key| key.starts_with("view_"))
}

/// Embeds one frame as a search query.
async fn embed_frame(app: &App, frame: &Frame) -> anyhow::Result<Vec<f32>> {
    let jpeg = frame.jpeg.clone();
    let prepared = tokio::task::spawn_blocking(move || crate::gate::prepare(&jpeg)).await??;
    let (mut vectors, _) = app.embedder.embed(&[Input { text: String::new(), jpeg_b64: Some(&prepared.model_b64) }], "query").await?;
    vectors.pop().ok_or_else(|| anyhow::anyhow!("no frame embedding returned"))
}

/// The stored view closest to this frame, if one is close enough: where the person is standing.
async fn nearest_view(app: &App, space_id: &str, user_id: &str, scope: &Scope, frame: &Frame) -> anyhow::Result<Option<Document>> {
    let query = embed_frame(app, frame).await?;
    let hits = app.store.vector_search(space_id, user_id, scope, &query, 8).await?;
    Ok(hits.into_iter().find(|m| is_view(m) && m.get_f64("score").unwrap_or(0.0) >= app.cfg.guide_min_score))
}

/// The fast path for someone moving: what is already remembered about the view
/// in this frame. One embedding and one vector search, with no extraction
/// model, so it answers in about a second. The memories it finds were
/// extracted earlier, by whoever went through first.
async fn guide(app: &App, space_id: &str, user_id: &str, scope: &Scope, frame: &Frame) -> anyhow::Result<Value> {
    let started = std::time::Instant::now();
    let query = embed_frame(app, frame).await?;
    let mut hits = app.store.vector_search(space_id, user_id, scope, &query, 8).await?;
    hits.retain(|m| m.get_f64("score").unwrap_or(0.0) >= app.cfg.guide_min_score);

    let mut spoken = Vec::new();
    // A hazard in view is said first.
    if let Some(hazard) = hits.iter().find(|m| !is_view(m) && m.get_str("topic") == Ok("hazard")) {
        if app.claim_spoken(user_id, hazard.get_str("item_key").unwrap_or_default()).await {
            spoken.push(format!("Careful. {}", hazard.get_str("summary").unwrap_or_default()));
        }
    }
    // Then where the person is: the closest stored view, said once per area.
    if let Some(view) = hits.iter().find(|m| is_view(m)) {
        let area = view.get_str("location").unwrap_or("this spot");
        if app.claim_spoken(user_id, &format!("area:{}", area.to_lowercase())).await {
            spoken.push(view.get_str("summary").unwrap_or_default().to_string());
        }
    } else if let Some(thing) = hits.iter().find(|m| m.get_str("topic") != Ok("hazard")) {
        // No stored view matches, but a remembered thing does.
        let item_key = thing.get_str("item_key").unwrap_or_default();
        if app.claim_spoken(user_id, item_key).await {
            let name = thing.get_str("item").unwrap_or(item_key);
            let mut chars = name.chars();
            let capitalised: String = chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default();
            spoken.push(format!("{capitalised}. {}", thing.get_str("tactile_anchor").or_else(|_| thing.get_str("summary")).unwrap_or_default()));
        }
    }

    let ms = started.elapsed().as_millis() as u64;
    app.stats.guides.fetch_add(1, Relaxed);
    app.stats.guide_ms.fetch_add(ms, Relaxed);
    Ok(json!({
        "say": (!spoken.is_empty()).then(|| spoken.join(" ")),
        "matches": hits.iter().map(|m| json!({
            "id": id_string(m.get("_id")),
            "item": m.get_str("item").ok(),
            "view": is_view(m),
            "topic": m.get_str("topic").ok(),
            "location": m.get_str("location").ok(),
            "score": m.get_f64("score").ok(),
        })).collect::<Vec<_>>(),
        "ms": ms,
    }))
}

// --- POST /api/turn ----------------------------------------------------------

#[derive(Deserialize)]
pub struct TurnBody {
    space_id: String,
    user_id: String,
    /// The client's own transcript. Null when it sent audio only.
    #[serde(default)]
    text: Option<String>,
    /// Recorded audio. This service has no speech-to-text, so it is only accepted alongside text.
    #[serde(default)]
    audio: Option<Value>,
    #[serde(default)]
    image_b64: Option<String>,
    #[serde(default)]
    image_url: Option<String>,
}

fn reply(kind: &str, text: impl Into<String>, memory_ids: Vec<String>) -> Value {
    // No audio is generated here: clients fall back to their own text-to-speech.
    json!({ "kind": kind, "reply_text": text.into(), "audio_url": null, "memory_ids": memory_ids })
}

#[derive(PartialEq, Debug)]
enum Intent {
    Nothing,
    Forget,
    Question,
    Note,
}

const QUESTION_WORDS: &[&str] = &[
    "where", "what", "which", "who", "how", "when", "why", "is", "are", "do", "does", "did", "can", "could", "would", "will", "tell", "show",
    "find", "guide", "help", "any", "take",
];

fn words(text: &str) -> Vec<String> {
    text.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_string).collect()
}

fn intent(text: &str) -> Intent {
    let words = words(text);
    let Some(first) = words.first() else { return Intent::Nothing };
    let lower = text.to_lowercase();
    if first == "forget" || lower.contains("please forget") {
        Intent::Forget
    } else if text.trim_end().ends_with('?') || QUESTION_WORDS.contains(&first.as_str()) || lower.starts_with("i want to go") || lower.starts_with("i need to find") || lower.starts_with("i'm looking for") || lower.starts_with("i am looking for") {
        Intent::Question
    } else {
        Intent::Note
    }
}

/// Words too general to identify an item on their own.
const GENERIC: &[&str] = &[
    "the", "and", "for", "you", "your", "that", "this", "with", "have", "has", "was", "are", "can", "did", "where", "what", "forget", "about",
    "please", "find", "leave", "left", "right", "put", "top", "bottom", "front", "back", "low", "high", "small", "large", "big", "old", "new",
    "house", "home", "room", "mine", "any", "all", "thing", "item",
];

/// Lowercase word stems worth matching on: "Keys" and "key" both become "key".
fn stems(text: &str) -> HashSet<String> {
    words(text)
        .into_iter()
        .map(|w| if w.len() > 3 && w.ends_with('s') { w[..w.len() - 1].to_string() } else { w })
        .filter(|w| w.len() >= 3 && !GENERIC.contains(&w.as_str()))
        .collect()
}

/// True when the text names the item of this memory, going by its key alone.
fn names_item(asked: &HashSet<String>, memory: &Document) -> bool {
    // Stored views are map data, not things someone can ask about or forget by name.
    !is_view(memory) && stems(&spaced(memory.get_str("item_key").unwrap_or_default())).iter().any(|stem| asked.contains(stem))
}

/// One spoken or typed turn: a note to remember, a question, or "forget ...".
pub async fn turn(State(app): State<Arc<App>>, headers: HeaderMap, Json(body): Json<TurnBody>) -> Result<Json<Value>, ApiError> {
    let space = load_space(&app, &body.space_id).await?;
    let role = role_in(&space, &body.user_id)?.to_string();
    let text = body.text.as_deref().unwrap_or_default().trim().to_string();
    if text.is_empty() && body.audio.as_ref().is_some_and(|a| !a.is_null()) {
        return Err(ApiError(StatusCode::UNSUPPORTED_MEDIA_TYPE, "audio-only turns are not supported: send the transcript in `text`".into()));
    }

    // The turn's picture also becomes the user's latest frame. A bad picture must not lose the words.
    let frame = match load_image(&app, body.image_b64, body.image_url).await {
        Ok(Some(jpeg)) => match app.accept_frame(&body.user_id, &body.space_id, jpeg, None, None, &public_base(&app, &headers)).await {
            Ok(frame) => Some(frame),
            Err(e) => {
                tracing::warn!(user = %body.user_id, "turn image ignored: {e}");
                None
            }
        },
        Ok(None) => None,
        Err(e) => {
            tracing::warn!(user = %body.user_id, "turn image ignored: {e:#}");
            None
        }
    };

    let started = std::time::Instant::now();
    // What was said is data, never an instruction: a turn that tries to give
    // the system orders is refused before anything is saved or looked up.
    if let Some(phrase) = guard::detect_injection(&text) {
        app.stats.injections_blocked.fetch_add(1, Relaxed);
        app.store.insert_audit(injection_audit(&body.space_id, &body.user_id, &phrase, &text)).await?;
        let mut response = reply("ignored", guard::INJECTION_REPLY, vec![]);
        response["heard_text"] = json!(guard::redact(&text).text);
        response["input_used"] = json!("text");
        return Ok(Json(response));
    }
    // Secrets are removed before a question or a forget request goes anywhere.
    // A note is cleaned inside `observe`, which also keeps it private.
    let safe = guard::redact(&text).text;
    // "I'm the resident" changes nothing; it is only noted in the audit log.
    let claim = guard::identity_claim(&text, &space)
        .filter(|claimed| claimed != &role)
        .map(|claimed| format!(" Ignored a spoken claim to be {claimed}; checked as role {role}."))
        .unwrap_or_default();
    let name = space.members.iter().find(|m| m.id == body.user_id).map_or(body.user_id.as_str(), |m| m.name.as_str());

    let kind = intent(&text);
    let scope = space.scope_for(&body.user_id);
    let mut response = match kind {
        Intent::Nothing => reply("ignored", "", vec![]),
        Intent::Forget => forget(&app, &body.space_id, &body.user_id, name, &safe).await?,
        Intent::Question => question(&app, &body.space_id, &body.user_id, &role, &scope, &safe, &claim, frame.as_ref()).await?,
        Intent::Note => note(&app, &body.space_id, &body.user_id, frame, text.clone()).await?,
    };
    response["heard_text"] = json!(safe);
    response["input_used"] = json!("text");
    tracing::info!(user = %body.user_id, intent = ?kind, kind = response["kind"].as_str().unwrap_or(""), ms = started.elapsed().as_millis() as u64, "turn");
    Ok(Json(response))
}

async fn note(app: &App, space_id: &str, user_id: &str, frame: Option<Frame>, text: String) -> Result<Value, ApiError> {
    if app.gemini.is_none() {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "the extraction model is not configured (GEMINI_API_KEY, GEMINI_MODEL)".into()));
    }
    if let Some(frame) = &frame {
        // This view is being processed now; the change gate need not look at it again.
        app.mark_indexed(user_id, frame).await;
    }
    let trigger = Trigger {
        user_id: user_id.to_string(),
        venue_id: space_id.to_string(),
        session_id: format!("{user_id}-turns"),
        frame,
        text,
        text_at_ms: Some(now_ms()),
        reason: "manual",
        phash_distance: None,
    };
    let stored = process::observe(app, &trigger).await?;
    Ok(match stored.first() {
        Some(first) => reply("saved", format!("Saved. {}", first.summary), stored.iter().map(|s| s.id.clone()).collect()),
        None => reply("ignored", "I didn't catch anything to remember in that.", vec![]),
    })
}

fn minutes_ago(doc: &Document) -> Option<i64> {
    let seen = doc.get_datetime("updated_at").ok()?;
    Some((DateTime::now().timestamp_millis() - seen.timestamp_millis()).max(0) / 60_000)
}

/// The check the search filter already made, made again in code. Anything
/// it catches means the filter has a bug, so it is dropped and logged loudly.
fn may_read(memory: &Document, user_id: &str, scope: &Scope) -> bool {
    let visible = match scope {
        Scope::Everything => true,
        Scope::Groups(groups) => memory.get_str("owner_id") == Ok(user_id) || memory.get_str("group").is_ok_and(|g| groups.iter().any(|allowed| allowed == g)),
    };
    visible && memory.get_str("status").map_or(true, |status| status == "active")
}

#[allow(clippy::too_many_arguments)]
async fn question(app: &App, space_id: &str, user_id: &str, role: &str, scope: &Scope, text: &str, claim: &str, frame: Option<&Frame>) -> Result<Value, ApiError> {
    let gemini = app.gemini.as_ref().ok_or_else(|| ApiError(StatusCode::SERVICE_UNAVAILABLE, "the answering model is not configured".into()))?;

    // Step A: search only what this person may see. With a picture, also find
    // where they are standing, so the answer can give directions from there.
    let search_text = async {
        let (vectors, _) = app.embedder.embed(&[Input { text: text.to_string(), jpeg_b64: None }], "query").await?;
        let query = vectors.first().ok_or_else(|| anyhow::anyhow!("no query embedding returned"))?;
        app.store.vector_search(space_id, user_id, scope, query, 12).await
    };
    let locate = async {
        match frame {
            Some(frame) => nearest_view(app, space_id, user_id, scope, frame).await,
            None => Ok(None),
        }
    };
    let (hits, here) = tokio::join!(search_text, locate);
    // Things answer "where is it"; views are kept for "where am I".
    let mut hits = hits?;
    let returned = hits.len();
    hits.retain(|m| may_read(m, user_id, scope));
    if hits.len() != returned {
        tracing::error!(user = %user_id, blocked = returned - hits.len(), "the search filter returned memories this user may not read; they were dropped");
    }
    let hits: Vec<Document> = hits.into_iter().filter(|m| !is_view(m)).take(5).collect();
    let here = here.unwrap_or_else(|e| {
        tracing::warn!(user = %user_id, "could not locate the asker: {e:#}");
        None
    });

    let mut memories: Vec<Value> = hits
        .iter()
        .map(|m| {
            json!({
                "id": id_string(m.get("_id")),
                "item": m.get_str("item").ok(),
                "topic": m.get_str("topic").ok(),
                "summary": m.get_str("summary").ok(),
                "where": m.get_str("location").ok(),
                "how_to_reach_from_where_it_was_seen": m.get_str("tactile_anchor").ok(),
                "previous_location": m.get_str("previous_location").ok(),
                "last_seen_minutes_ago": minutes_ago(m),
                "mine": m.get_str("owner_id") == Ok(user_id),
            })
        })
        .collect();
    if let Some(view) = &here {
        memories.push(json!({ "you_are_here": view.get_str("summary").ok(), "area": view.get_str("location").ok(), "id": id_string(view.get("_id")) }));
    }

    if !memories.is_empty() {
        let answer = gemini.answer(text, &memories).await?;
        if answer.found && !answer.reply.trim().is_empty() {
            let offered: HashSet<String> = hits.iter().chain(here.iter()).filter_map(|m| id_string(m.get("_id"))).collect();
            let used: Vec<String> = answer.memory_ids.into_iter().filter(|id| offered.contains(id)).collect();
            let detail = format!("Asked \"{text}\". Answered from {} memor{} visible to role {role}.{claim}", used.len(), if used.len() == 1 { "y" } else { "ies" });
            app.store.insert_audit(audit_event(space_id, user_id, "query_answered", "allowed", detail, used.clone(), Some(text))).await?;
            return Ok(reply("answer", answer.reply.trim(), used));
        }
    }

    // Step B: the thing may be remembered, but not for this person. Say so,
    // record the attempt, and reveal nothing about where it is.
    let asked = stems(text);
    let hidden = app.store.hidden_from(space_id, user_id, scope).await?;
    if let Some(blocked) = hidden.iter().find(|m| names_item(&asked, m)) {
        let detail = format!(
            "Asked about {}. Group {} is not visible to role {role}.{claim}",
            blocked.get_str("item").unwrap_or("an item"),
            blocked.get_str("group").unwrap_or_default(),
        );
        let blocked_ids = id_string(blocked.get("_id")).into_iter().collect();
        app.store.insert_audit(audit_event(space_id, user_id, "query_denied", "denied", detail, blocked_ids, Some(text))).await?;
        app.stats.queries_denied.fetch_add(1, Relaxed);
        return Ok(reply("denied", "Sorry, I can't share that with you.", vec![]));
    }
    app.store.insert_audit(audit_event(space_id, user_id, "query_answered", "info", format!("Asked \"{text}\". No matching memory.{claim}"), vec![], Some(text))).await?;
    Ok(reply("answer", "I don't have anything about that yet.", vec![]))
}

async fn forget(app: &App, space_id: &str, user_id: &str, name: &str, text: &str) -> Result<Value, ApiError> {
    let asked = stems(text);
    let own = app.store.own_active(space_id, user_id).await?;
    let matched: Vec<&Document> = own.iter().filter(|m| names_item(&asked, m)).collect();
    if matched.is_empty() {
        // Only the owner can forget a memory.
        let all = app.store.list_memories(space_id).await?;
        let others: Vec<&Document> = all.iter().filter(|m| m.get_str("status") == Ok("active") && m.get_str("owner_id") != Ok(user_id) && names_item(&asked, m)).collect();
        return Ok(match others.first() {
            Some(first) => {
                let detail = format!("Asked to forget {}. Only the owner can forget a memory.", first.get_str("item").unwrap_or("an item"));
                let ids = others.iter().filter_map(|m| id_string(m.get("_id"))).collect();
                app.store.insert_audit(audit_event(space_id, user_id, "query_denied", "denied", detail, ids, Some(text))).await?;
                reply("denied", "Sorry, I can't forget that. It belongs to someone else.", vec![])
            }
            None => {
                let detail = "Asked to forget something, but no active memory matched.".to_string();
                app.store.insert_audit(audit_event(space_id, user_id, "query_answered", "info", detail, vec![], Some(text))).await?;
                reply("ignored", "I don't have anything like that to forget.", vec![])
            }
        });
    }

    let ids: Vec<String> = matched.iter().filter_map(|m| id_string(m.get("_id"))).collect();
    let mut items: Vec<&str> = matched.iter().map(|m| m.get_str("item").unwrap_or("item")).collect();
    items.dedup();
    let event = audit_event(space_id, user_id, "memory_forgotten", "allowed", format!("{name} asked to forget {}. The content was removed.", items.join(", ")), ids.clone(), Some(text));
    let purge_at = DateTime::from_millis(DateTime::now().timestamp_millis() + PURGE_AFTER_MS);
    app.store.retire(matched.iter().filter_map(|m| m.get("_id").cloned()).collect(), "forgotten", purge_at, vec![event], true).await?;
    Ok(reply("forgot", format!("Forgotten. I no longer remember the {}.", items.join(" or the ")), ids))
}

// --- GET /api/events ---------------------------------------------------------

/// Server-sent events for one space: memories, audit entries, rules and frames as they happen.
pub async fn events(State(app): State<Arc<App>>, Query(q): Query<SpaceQuery>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let feed = stream::unfold((app.events.subscribe(), q.space_id), |(mut rx, space_id)| async move {
        loop {
            match rx.recv().await {
                Ok(event) if event.space_id == space_id => return Some((Ok(Event::default().event(event.name).data(event.data.to_string())), (rx, space_id))),
                // Another space's event, or this client fell behind: keep going.
                Ok(_) | Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(feed).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text("ping"))
}

/// Turns MongoDB change streams into live-feed events. Runs for the life of
/// the process and reconnects if the stream drops.
pub async fn watch(app: Arc<App>, collection: &'static str) {
    loop {
        match app.store.watch(collection).await {
            Ok(mut changes) => {
                tracing::info!(collection, "change stream open");
                while let Some(change) = changes.next().await {
                    let Ok(change) = change else { break };
                    let Some(doc) = change.full_document else { continue };
                    let Ok(space_id) = doc.get_str("space_id") else { continue };
                    if collection == "memories" {
                        // Views would flood the dashboard: one arrives per indexed frame.
                        if is_view(&doc) {
                            continue;
                        }
                        let op = match change.operation_type {
                            OperationType::Insert => "created",
                            OperationType::Update | OperationType::Replace => "updated",
                            _ => continue,
                        };
                        app.emit(space_id, "memory", json!({ "op": op, "memory": memory_json(&doc) }));
                    } else if change.operation_type == OperationType::Insert {
                        app.emit(space_id, "audit", json!({ "entry": audit_json(&doc) }));
                    }
                }
                tracing::warn!(collection, "change stream closed, reopening");
            }
            Err(e) => tracing::warn!(collection, "could not open change stream: {e}"),
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// Marks memories whose time is up as "expired", with an audit row each. They
/// stay listed, without their content, until MongoDB deletes them at `purge_at`.
pub async fn expire_loop(app: Arc<App>) {
    let mut tick = tokio::time::interval(Duration::from_secs(15));
    loop {
        tick.tick().await;
        let due = match app.store.due_to_expire(DateTime::now()).await {
            Ok(due) => due,
            Err(e) => {
                tracing::warn!("expiry sweep failed: {e:#}");
                continue;
            }
        };
        if due.is_empty() {
            continue;
        }
        let audit_events = due
            .iter()
            .map(|m| {
                let detail = format!("The {} reached the end of its keep-for time and expired.", m.get_str("item").unwrap_or("memory"));
                audit_event(m.get_str("space_id").unwrap_or_default(), "system", "memory_expired", "info", detail, id_string(m.get("_id")).into_iter().collect(), None)
            })
            .collect();
        let purge_at = DateTime::from_millis(DateTime::now().timestamp_millis() + PURGE_AFTER_MS);
        match app.store.retire(due.iter().filter_map(|m| m.get("_id").cloned()).collect(), "expired", purge_at, audit_events, false).await {
            Ok(count) => tracing::info!(count, "memories expired"),
            Err(e) => tracing::warn!("expiring memories failed: {e:#}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::doc;

    #[test]
    fn turns_are_sorted_into_notes_questions_and_forgets() {
        assert_eq!(intent("I'm putting my keys in my left jacket pocket"), Intent::Note);
        assert_eq!(intent("Where did I leave my keys?"), Intent::Question);
        assert_eq!(intent("where are my keys"), Intent::Question);
        assert_eq!(intent("Can you find my wallet"), Intent::Question);
        assert_eq!(intent("Take me to the restroom"), Intent::Question);
        assert_eq!(intent("I want to go to the exit"), Intent::Question);
        assert_eq!(intent("The floor is wet?"), Intent::Question);
        assert_eq!(intent("Forget my keys"), Intent::Forget);
        assert_eq!(intent("   "), Intent::Nothing);
    }

    #[test]
    fn a_question_names_an_item_by_its_key() {
        let keys = doc! { "item_key": "house_keys" };
        let pills = doc! { "item_key": "blood_pressure_pills" };
        assert!(names_item(&stems("Where did Vaze leave his keys?"), &keys));
        assert!(names_item(&stems("where is the key"), &keys));
        assert!(names_item(&stems("Forget my pills"), &pills));
        // "house" alone is too general to count as asking about the house keys.
        assert!(!names_item(&stems("Where is the house thermostat?"), &keys));
        assert!(!names_item(&stems("Where is the kettle?"), &pills));
    }

    #[test]
    fn stored_documents_map_to_the_contract_shapes() {
        let memory = doc! { "_id": "m_1", "space_id": "home", "owner_id": "u_resident", "item": "house keys", "item_key": "house_keys", "summary": "Keys in pocket.", "topic": "valuables", "group": "resident_only", "source": "both", "status": "active", "superseded_by": Bson::Null, "embedding": [0.5], "tactile_anchor": "x" };
        let m = memory_json(&memory);
        assert_eq!((m["id"].as_str(), m["item"].as_str(), m["group"].as_str(), m["source"].as_str()), (Some("m_1"), Some("house keys"), Some("resident_only"), Some("both")));
        assert!(m["location"].is_null() && m["superseded_by"].is_null() && m["image_url"].is_null());
        // Backend-only fields stay behind.
        assert!(m.get("embedding").is_none() && m.get("tactile_anchor").is_none() && m.get("item_key").is_none());

        let denied = doc! { "_id": "a_1", "space_id": "home", "actor_id": "u_visitor", "action": "query_denied", "verdict": "denied", "detail": "d", "memory_ids": ["m_1"], "query_text": "where are the keys" };
        let a = audit_json(&denied);
        assert_eq!((a["action"].as_str(), a["verdict"].as_str()), (Some("query_denied"), Some("denied")));
        assert_eq!(a["memory_ids"], json!(["m_1"]));
        assert!(a.get("query_text").is_none());
    }
}
