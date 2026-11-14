//! What happens to one observation: extract items, let the space's rules
//! decide their group, embed, reconcile against existing memories, and log it.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering::Relaxed},
        Arc,
    },
    time::Instant,
};

use anyhow::Context;
use mongodb::bson::{doc, oid::ObjectId, Bson, DateTime, Document};

use crate::{
    embed::{self, Input},
    gate, guard,
    gemini::Extracted,
    policy::{self, Decision, Space},
    store::Change,
    App, Frame,
};

/// Views (what is around from one spot) are filed under the place-guide topic.
const VIEW_TOPIC: &str = "house_guide";
/// The schema caps stored transcripts at this many characters.
const MAX_TRANSCRIPT_CHARS: usize = 2000;

/// One thing to process: a changed view, a spoken note, or both.
#[derive(Clone)]
pub struct Trigger {
    pub user_id: String,
    /// The space id (`space_id` in the database and the API).
    pub venue_id: String,
    pub session_id: String,
    pub frame: Option<Frame>,
    pub text: String,
    pub text_at_ms: Option<u64>,
    pub reason: &'static str,
    pub phash_distance: Option<u32>,
}

/// A memory that an observation added, reinforced or replaced.
pub struct Stored {
    pub id: String,
    pub summary: String,
}

pub async fn run(app: Arc<App>, trigger: Trigger, busy: Arc<AtomicBool>) {
    match observe(&app, &trigger).await {
        Ok(_) => app.after_success(&trigger.user_id).await,
        Err(e) => {
            // Give the note and the view another chance before the session is released.
            app.after_failure(&trigger).await;
            app.stats.failed.fetch_add(1, Relaxed);
            tracing::error!(user = %trigger.user_id, space = %trigger.venue_id, "observation failed: {e:#}");
        }
    }
    busy.store(false, Relaxed);
}

pub fn spaced(key: &str) -> String {
    key.replace('_', " ")
}

/// The audit row for a refused instruction. The words are stored with secrets removed.
pub fn injection_audit(space_id: &str, user_id: &str, phrase: &str, text: &str) -> Document {
    let quoted: String = if phrase.chars().count() > 60 { phrase.chars().take(57).chain("...".chars()).collect() } else { phrase.to_string() };
    let detail = format!("Blocked an instruction in what was said: \"{quoted}\". Text that is seen or heard is never treated as a command, so nothing was saved or changed.");
    audit_event(space_id, user_id, "query_denied", "denied", detail, vec![], Some(&guard::redact(text).text))
}

/// A row for `audit_events`, in the shape of the API contract's AuditEntry.
pub fn audit_event(space_id: &str, actor_id: &str, action: &str, verdict: &str, detail: String, memory_ids: Vec<String>, query_text: Option<&str>) -> Document {
    doc! {
        "_id": format!("a_{}", ObjectId::new().to_hex()),
        "ts": DateTime::now(),
        "space_id": space_id,
        "actor_id": actor_id,
        "action": action,
        "verdict": verdict,
        "detail": detail,
        "memory_ids": memory_ids,
        "query_text": query_text.map(|q| q.chars().take(MAX_TRANSCRIPT_CHARS).collect::<String>()),
    }
}

/// Runs one observation through extraction, the space's rules, embedding and
/// the reconciler, logs it, and returns the memories it touched.
pub async fn observe(app: &App, t: &Trigger) -> anyhow::Result<Vec<Stored>> {
    let stats = &app.stats;
    let now = DateTime::now();
    let mut stored: Vec<Stored> = Vec::new();

    // Words are data, never instructions. A sentence that tries to give the
    // system orders is refused and recorded, and nothing from it is saved.
    if let Some(phrase) = guard::detect_injection(&t.text) {
        stats.injections_blocked.fetch_add(1, Relaxed);
        app.store.insert_audit(injection_audit(&t.venue_id, &t.user_id, &phrase, &t.text)).await?;
        return Ok(stored);
    }
    // Secrets and identity numbers are removed before a model, the database
    // or the audit log sees the words.
    let redacted = guard::redact(&t.text);
    let cleaned;
    let t = if redacted.found.is_empty() {
        t
    } else {
        cleaned = Trigger { text: redacted.text, ..t.clone() };
        &cleaned
    };
    let removed = redacted.found;

    // Without an extraction model the capture is still logged, but no memories are made.
    if let Some(gemini) = &app.gemini {
        let prepared = match &t.frame {
            Some(frame) => {
                let jpeg = frame.jpeg.clone();
                Some(tokio::task::spawn_blocking(move || gate::prepare(&jpeg)).await.context("image task failed")??)
            }
            None => None,
        };
        let image = prepared.as_ref().map(|p| p.model_b64.as_str());
        let thumb = prepared.as_ref().map(|p| p.thumb_data_url.as_str());

        let started = Instant::now();
        let space = app.store.space(&t.venue_id).await?.with_context(|| format!("unknown space '{}'", t.venue_id))?;
        // Only members of a space may add to its memory.
        anyhow::ensure!(space.role_of(&t.user_id).is_some(), "user '{}' is not a member of space '{}'", t.user_id, t.venue_id);
        let known = app.store.known_items(&t.venue_id, &t.user_id, &space.scope_for(&t.user_id)).await?;
        let topics: Vec<String> = space.rules.topics.keys().cloned().collect();
        let extraction = gemini.extract(image, &t.text, &topics, &known).await?;
        let (area, scene, items) = (extraction.area, extraction.scene, extraction.items);
        let extract_ms = started.elapsed().as_millis() as u64;

        // The rules run before anything is embedded or stored, so they control what each memory may contain.
        let decided: Vec<(Extracted, Decision)> = items
            .into_iter()
            .map(|item| {
                let decision = policy::decide_with_removed(&space, &item.topic, item.contains_pii, &removed, now);
                (item, decision)
            })
            .collect();

        // A frame shows everything in view and a sentence can mention several
        // things. A memory may carry the picture or the sentence only if everyone
        // who can see that memory can also see everything else found in them.
        let viewers: Vec<_> = decided.iter().map(|(_, d)| space.rules.viewers(&d.group)).collect();
        let carries = |d: &Decision| {
            let mine = space.rules.viewers(&d.group);
            viewers.iter().all(|other| mine.is_subset(other))
        };

        // A walk-through frame also stores the view itself: what is around from
        // this spot, for live guidance and "where am I". Only when the whole
        // frame may be seen by everyone who can see the view.
        let view = match (scene, image) {
            (Some(scene), Some(_)) if t.reason == "manual" && t.text.is_empty() => {
                let decision = policy::decide_with_removed(&space, VIEW_TOPIC, false, &[], now);
                let shareable = decided.iter().all(|(item, _)| !item.contains_pii) && carries(&decision);
                shareable.then_some((scene, decision))
            }
            _ => None,
        };

        // One request embeds every item, and the view last.
        let started = Instant::now();
        let mut inputs: Vec<Input> = decided
            .iter()
            .map(|(item, decision)| {
                let said = if carries(decision) { t.text.as_str() } else { "" };
                Input {
                    text: format!("{} {} {said}", item.summary, item.tactile_anchor.as_deref().unwrap_or("")).trim().to_string(),
                    jpeg_b64: image.filter(|_| carries(decision) && !item.contains_pii),
                }
            })
            .collect();
        if let Some((scene, _)) = &view {
            inputs.push(Input { text: format!("{}. {scene}", area.as_deref().unwrap_or("")), jpeg_b64: image });
        }
        let (mut vectors, _tokens) = app.embedder.embed(&inputs, "document").await?;
        let view_vector = if view.is_some() { vectors.pop() } else { None };
        let embed_ms = started.elapsed().as_millis() as u64;

        let started = Instant::now();
        // Items of one observation are different things, so they are reconciled side by side.
        let space = &space;
        let results = futures_util::future::join_all(decided.into_iter().zip(vectors).map(|((item, decision), vector)| {
            let carried = carries(&decision);
            let picture = thumb.filter(|_| carried && !item.contains_pii);
            let (item_key, summary) = (item.item_key.clone(), item.summary.clone());
            async move { (item_key, summary, reconcile(app, t, space, item, decision, vector, picture, carried, now).await) }
        }))
        .await;
        for (item_key, summary, result) in results {
            match result {
                Ok(id) => stored.push(Stored { id, summary }),
                // One item failing must not cost the others.
                Err(e) => {
                    stats.failed.fetch_add(1, Relaxed);
                    tracing::error!(user = %t.user_id, item = %item_key, "item failed: {e:#}");
                }
            }
        }
        if let (Some((scene, decision)), Some(vector)) = (view, view_vector) {
            let view_doc = doc! {
                "_id": format!("m_{}", ObjectId::new().to_hex()),
                "space_id": &t.venue_id,
                "owner_id": &t.user_id,
                "item": area.clone().unwrap_or_else(|| "view of the space".to_string()),
                "item_key": format!("view_{:x}", now.timestamp_millis()),
                "summary": &scene,
                "location": area.clone(),
                "topic": &decision.topic,
                "group": &decision.group,
                "source": "camera",
                "status": "active",
                "superseded_by": Bson::Null,
                "created_at": now,
                "updated_at": now,
                "expires_at": decision.expires_at,
                "image_url": thumb,
                "policy_decision": { "topic": &decision.topic, "group": &decision.group, "reason": &decision.reason, "pii_redacted": false, "checked_at": now },
                "reinforcement_count": 1_i32,
                "tactile_anchor": &scene,
                "embedding": vector,
                "purge_at": Bson::Null,
            };
            // A view is map data, not a decision, so it gets no audit row.
            match app.store.apply(Change::Add(view_doc), None).await {
                Ok(()) => {
                    stats.views_stored.fetch_add(1, Relaxed);
                }
                Err(e) => tracing::warn!(user = %t.user_id, "view not stored: {e:#}"),
            }
        }
        let store_ms = started.elapsed().as_millis() as u64;

        stats.processed.fetch_add(1, Relaxed);
        stats.extract_ms.fetch_add(extract_ms, Relaxed);
        stats.embed_ms.fetch_add(embed_ms, Relaxed);
        stats.store_ms.fetch_add(store_ms, Relaxed);
        tracing::info!(user = %t.user_id, reason = t.reason, memories = stored.len(), extract_ms, embed_ms, store_ms, "observation processed");
    }

    let memory_ids: Vec<String> = stored.iter().map(|s| s.id.clone()).collect();
    app.store.log_observation(observation_doc(app, t, memory_ids, now)).await?;
    stats.observations_logged.fetch_add(1, Relaxed);
    Ok(stored)
}

/// ADD / REINFORCE / SUPERSEDE, as in the state machine in docs/02. Returns the
/// id of the memory that now holds this item.
#[allow(clippy::too_many_arguments)]
pub async fn reconcile(app: &App, t: &Trigger, space: &Space, mut item: Extracted, decision: Decision, vector: Vec<f32>, picture: Option<&str>, carries_text: bool, now: DateTime) -> anyhow::Result<String> {
    if vector.len() != embed::DIMENSIONS {
        anyhow::bail!("embedding has {} numbers, expected {}", vector.len(), embed::DIMENSIONS);
    }

    // The default group is the owner-only one: a sighting filed there looks
    // only at the owner's own memories and can never change one that others share.
    let owner_only = decision.group == space.rules.default_group;
    let mut existing = app.store.active_memory(&t.venue_id, &t.user_id, &item.item_key, &space.rules.default_group, owner_only).await?;
    // A temporary hazard must not replace, or put an expiry on, the permanent thing it sits on.
    if decision.topic == "hazard" && decision.expires_at.is_some() && existing.as_ref().is_some_and(|old| old.expires_at.is_none()) {
        item.item_key.push_str("_hazard");
        existing = app.store.active_memory(&t.venue_id, &t.user_id, &item.item_key, &space.rules.default_group, owner_only).await?;
    }
    let item_name = spaced(&item.item_key);

    // Still where it was remembered: strengthen the existing memory instead of adding another.
    if let Some(old) = &existing {
        let same_anchor = matches!((&old.tactile_anchor, &item.tactile_anchor), (Some(a), Some(b)) if a.trim().eq_ignore_ascii_case(b.trim()));
        if same_anchor || !item.moved {
            let change = Change::Reinforce { id: old.id.clone(), seen_at: now, expires_at: decision.expires_at.filter(|_| old.expires_at.is_some()) };
            app.store.apply(change, None).await?;
            app.stats.memories_reinforced.fetch_add(1, Relaxed);
            return Ok(old.id.as_str().map_or_else(|| old.id.to_string(), str::to_string));
        }
    }

    let new_id = format!("m_{}", ObjectId::new().to_hex());
    let source = match (t.frame.is_some(), t.text.is_empty()) {
        (true, true) => "camera",
        (true, false) => "both",
        (false, _) => "voice",
    };
    let previous_location = existing.as_ref().and_then(|old| old.location.clone().or_else(|| old.tactile_anchor.clone()));
    let new_doc = doc! {
        "_id": &new_id,
        "space_id": &t.venue_id,
        "owner_id": &t.user_id,
        "item": &item_name,
        "item_key": &item.item_key,
        "summary": &item.summary,
        "location": item.location.clone(),
        "topic": &decision.topic,
        "group": &decision.group,
        "source": source,
        "status": "active",
        "superseded_by": Bson::Null,
        "created_at": now,
        "updated_at": now,
        "expires_at": decision.expires_at,
        // The backend's own small copy of the frame, never the glasses' signed link.
        "image_url": picture,
        "policy_decision": {
            "topic": &decision.topic,
            "group": &decision.group,
            "reason": &decision.reason,
            // True when words were removed, or a picture existed but was kept off this memory.
            "pii_redacted": decision.pii_redacted || (t.frame.is_some() && picture.is_none()),
            "checked_at": now,
        },
        "reinforcement_count": 1_i32,
        "tactile_anchor": item.tactile_anchor.clone(),
        "previous_location": previous_location.clone(),
        "transcript_snippet": (carries_text && !t.text.is_empty()).then(|| t.text.chars().take(MAX_TRANSCRIPT_CHARS).collect::<String>()),
        "bbox": item.bbox.clone().filter(|_| t.frame.is_some()),
        "embedding": vector,
        "purge_at": Bson::Null,
    };

    match existing {
        Some(old) => {
            let old_id = old.id.as_str().map_or_else(|| old.id.to_string(), str::to_string);
            let detail = format!(
                "The {item_name} moved from {} to {}. The earlier memory was replaced.",
                previous_location.as_deref().unwrap_or("its earlier place"),
                item.location.as_deref().or(item.tactile_anchor.as_deref()).unwrap_or("a new place"),
            );
            let event = audit_event(&t.venue_id, &t.user_id, "memory_superseded", "info", detail, vec![new_id.clone(), old_id], None);
            app.store.apply(Change::Supersede { old_id: old.id, new_id: new_id.clone(), new_doc }, Some(event)).await?;
            app.stats.memories_superseded.fetch_add(1, Relaxed);
        }
        None => {
            let detail = format!("Remembered the {item_name} in group '{}'. {}", decision.group, decision.reason);
            let event = audit_event(&t.venue_id, &t.user_id, "memory_stored", "info", detail, vec![new_id.clone()], None);
            app.store.apply(Change::Add(new_doc), Some(event)).await?;
            app.stats.memories_added.fetch_add(1, Relaxed);
        }
    }
    Ok(new_id)
}

/// A short-lived record of what came in and the memories it produced.
fn observation_doc(app: &App, t: &Trigger, memory_ids: Vec<String>, now: DateTime) -> Document {
    let text = (!t.text.is_empty()).then(|| t.text.chars().take(MAX_TRANSCRIPT_CHARS).collect::<String>());
    doc! {
        "type": if t.text.is_empty() { "frame" } else { "turn" },
        "space_id": &t.venue_id,
        "user_id": &t.user_id,
        "ts": now,
        "session_id": &t.session_id,
        "mentra_request_id": t.frame.as_ref().and_then(|f| f.request_id.clone()),
        "text": text.clone(),
        "heard_text": text,
        "input_used": (!t.text.is_empty()).then_some("text"),
        "kind": Bson::Null,
        "memory_ids": memory_ids,
        "phash_distance": t.phash_distance.map(|d| d as i32),
        "gate_reason": t.reason,
        "expires_at": DateTime::from_millis(now.timestamp_millis() + app.cfg.observation_ttl_hours * 3_600_000),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(item_key: &str, topic: &str, summary: &str, anchor: &str, moved: bool) -> Extracted {
        Extracted { item_key: item_key.into(), topic: topic.into(), summary: summary.into(), location: Some(anchor.into()), tactile_anchor: Some(anchor.into()), bbox: None, moved, contains_pii: false }
    }

    /// Exercises the real collections and their schema validators, then removes what it wrote.
    #[tokio::test]
    #[ignore = "writes to the real Atlas database; run with: cargo test -- --ignored"]
    async fn memories_follow_add_reinforce_supersede_against_atlas() {
        let _ = dotenvy::dotenv();
        let app = crate::build_app(crate::Config::from_env().unwrap()).await.unwrap();
        let space_id = format!("test_pipeline_{}", std::process::id());
        app.store.delete_space_data(&space_id).await.unwrap();

        let home = policy::demo_home();
        let trigger = |user: &str, text: &str| Trigger {
            user_id: user.into(),
            venue_id: space_id.clone(),
            session_id: "test-session".into(),
            frame: None,
            text: text.into(),
            text_at_ms: (!text.is_empty()).then(crate::now_ms),
            reason: "manual",
            phash_distance: None,
        };
        let now = DateTime::now();
        // Runs the rules, a real embedding and the reconciler for one item, as `observe` does.
        let see = |t: Trigger, item: Extracted| {
            let (app, home) = (app.clone(), home.clone());
            async move {
                let decision = policy::decide_with_removed(&home, &item.topic, item.contains_pii, &[], now);
                let vector = app.embedder.embed(&[Input { text: item.summary.clone(), jpeg_b64: None }], "document").await.unwrap().0.remove(0);
                reconcile(&app, &t, &home, item, decision, vector, None, true, now).await.unwrap()
            }
        };
        let resident = |text: &str| trigger("u_resident", text);

        // Keys on the desk: a new owner-only memory. Seen again there: reinforced, not duplicated.
        let desk = || item("house_keys", "valuables", "Keys on the desk beside the laptop.", "On the desk, right of the laptop.", false);
        let first = see(resident("Leaving my keys on the desk."), desk()).await;
        assert_eq!(first, see(resident("Leaving my keys on the desk."), desk()).await);

        // Moved to a pocket: the old memory is retired and a new one takes over.
        let pocket = || item("house_keys", "valuables", "Keys are in the left coat pocket.", "Inside the left coat pocket.", true);
        let moved = see(resident("Putting my keys in my left coat pocket."), pocket()).await;
        assert_ne!(first, moved);
        // The same note heard twice must not look like a second move.
        assert_eq!(moved, see(resident("Putting my keys in my left coat pocket."), pocket()).await);

        // A fixture goes to the shared house guide.
        let shared = see(resident(""), item("kettle", "house_guide", "Kettle on the kitchen counter.", "On the waist-high counter, left of the sink.", false)).await;
        // Someone else's sighting that lands in the owner-only group leaves the shared memory alone.
        let own_copy = see(trigger("u_caregiver", ""), item("kettle", "something_unlisted", "A kettle by the window.", "On the windowsill.", true)).await;
        assert_ne!(shared, own_copy);
        // A hazard reported under the fixture's key gets its own memory and its own expiry.
        let hazard = see(resident(""), item("kettle", "hazard", "Water spilled around the kettle.", "On the counter around the kettle base.", false)).await;
        assert_ne!(shared, hazard);

        app.store.log_observation(observation_doc(&app, &resident("Putting my keys in my left coat pocket."), vec![moved.clone()], now)).await.unwrap();

        let memories = app.store.find_all("memories", &space_id).await.unwrap();
        let by_id = |id: &str| memories.iter().find(|m| m.get_str("_id") == Ok(id)).unwrap();
        assert_eq!(memories.len(), 5);
        assert_eq!(by_id(&first).get_str("status"), Ok("superseded"));
        assert_eq!(by_id(&first).get_str("superseded_by"), Ok(moved.as_str()));
        assert_eq!(by_id(&first).get_i32("reinforcement_count"), Ok(2));
        assert_eq!((by_id(&moved).get_str("status"), by_id(&moved).get_str("group")), (Ok("active"), Ok("resident_only")));
        assert_eq!(by_id(&moved).get_i32("reinforcement_count"), Ok(2));
        assert_eq!(by_id(&moved).get_str("previous_location"), Ok("On the desk, right of the laptop."));
        assert_eq!(by_id(&moved).get_str("item"), Ok("house keys"));
        assert_eq!((by_id(&shared).get_str("group"), by_id(&shared).get_str("status")), (Ok("house_guide"), Ok("active")));
        assert!(by_id(&shared).get_datetime("expires_at").is_err(), "the fixture must stay permanent");
        assert_eq!((by_id(&own_copy).get_str("group"), by_id(&own_copy).get_str("topic"), by_id(&own_copy).get_str("owner_id")), (Ok("resident_only"), Ok("other"), Ok("u_caregiver")));
        assert_eq!(by_id(&hazard).get_str("item_key"), Ok("kettle_hazard"));
        assert!(by_id(&hazard).get_datetime("expires_at").is_ok());

        let audit = app.store.find_all("audit_events", &space_id).await.unwrap();
        let mut actions: Vec<&str> = audit.iter().map(|a| a.get_str("action").unwrap()).collect();
        actions.sort_unstable();
        assert_eq!(actions, ["memory_stored", "memory_stored", "memory_stored", "memory_stored", "memory_superseded"]);
        assert_eq!(app.store.find_all("observations", &space_id).await.unwrap().len(), 1);

        app.store.delete_space_data(&space_id).await.unwrap();
    }
}
