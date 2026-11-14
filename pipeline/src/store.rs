//! MongoDB access for the `hackathon` database: `spaces`, `memories`,
//! `audit_events` and `observations`. Field names follow db/setup.js, which
//! follows docs/api-contract.md.

use std::time::Duration;

use anyhow::Context;
use mongodb::{
    bson::{doc, Bson, DateTime, Document},
    change_stream::{event::ChangeStreamEvent, ChangeStream},
    error::TRANSIENT_TRANSACTION_ERROR,
    options::FullDocumentType,
    Client, Collection, Cursor,
};
use serde::Deserialize;

use crate::policy::{Rules, Scope, Space};

const TRANSACTION_ATTEMPTS: u32 = 3;
const VECTOR_INDEX: &str = "memories_multimodal_vec";
/// Fields that never leave the backend in bulk reads.
const NO_VECTOR: &str = "embedding";

async fn collect(mut cursor: Cursor<Document>) -> anyhow::Result<Vec<Document>> {
    let mut docs = Vec::new();
    while cursor.advance().await.context("reading results")? {
        docs.push(cursor.deserialize_current().context("decoding a document")?);
    }
    Ok(docs)
}

/// "Memories this user may read": their own, plus the groups their role can see.
/// None means no restriction.
fn readable(user_id: &str, scope: &Scope) -> Option<Document> {
    match scope {
        Scope::Everything => None,
        Scope::Groups(groups) => Some(doc! { "$or": [{ "owner_id": user_id }, { "group": { "$in": groups.clone() } }] }),
    }
}

/// The parts of a stored memory the reconciler compares against.
#[derive(Deserialize)]
pub struct ExistingMemory {
    #[serde(rename = "_id")]
    pub id: Bson,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub tactile_anchor: Option<String>,
    #[serde(default)]
    pub expires_at: Option<DateTime>,
}

/// A remembered thing and where it is, as shown to the extraction model.
#[derive(Deserialize)]
pub struct KnownItem {
    pub item_key: String,
    #[serde(default)]
    pub tactile_anchor: Option<String>,
}

/// What the reconciler decided to do with a new observation of an item.
pub enum Change {
    Add(Document),
    /// `expires_at` is set only for a memory that was already temporary, so
    /// seeing a hazard again keeps it alive. No audit row: a re-sighting is not a decision.
    Reinforce { id: Bson, seen_at: DateTime, expires_at: Option<DateTime> },
    Supersede { old_id: Bson, new_id: String, new_doc: Document },
}

pub struct Store {
    client: Client,
    memories: Collection<Document>,
    audit: Collection<Document>,
    observations: Collection<Document>,
    spaces: Collection<Document>,
}

impl Store {
    pub async fn connect(uri: &str, db: &str) -> anyhow::Result<Self> {
        let client = Client::with_uri_str(uri).await.context("parsing MongoDB connection string")?;
        let database = client.database(db);
        // Fail at startup, not on the first observation, if Atlas is unreachable.
        database.run_command(doc! { "ping": 1 }).await.context("pinging MongoDB")?;
        Ok(Self {
            memories: database.collection("memories"),
            audit: database.collection("audit_events"),
            observations: database.collection("observations"),
            spaces: database.collection("spaces"),
            client,
        })
    }

    pub async fn space(&self, space_id: &str) -> anyhow::Result<Option<Space>> {
        self.spaces.clone_with_type::<Space>().find_one(doc! { "_id": space_id }).await.context("reading space")
    }

    pub async fn set_rules(&self, space_id: &str, rules: &Rules) -> anyhow::Result<()> {
        let rules = mongodb::bson::to_bson(rules).context("encoding rules")?;
        self.spaces.update_one(doc! { "_id": space_id }, doc! { "$set": { "rules": rules } }).await.context("saving rules")?;
        Ok(())
    }

    /// What the user can already see remembered in this space, most recently updated first.
    pub async fn known_items(&self, space_id: &str, user_id: &str, scope: &Scope) -> anyhow::Result<Vec<KnownItem>> {
        let mut filter = doc! { "space_id": space_id, "status": "active", "item_key": { "$not": { "$regex": "^view_" } } };
        filter.extend(readable(user_id, scope).unwrap_or_default());
        let mut cursor = self
            .memories
            .clone_with_type::<KnownItem>()
            .find(filter)
            .projection(doc! { "_id": 0, "item_key": 1, "tactile_anchor": 1 })
            .sort(doc! { "updated_at": -1 })
            .limit(100)
            .await
            .context("listing remembered items")?;
        let mut items = Vec::new();
        while cursor.advance().await.context("reading remembered items")? {
            items.push(cursor.deserialize_current().context("decoding remembered item")?);
        }
        Ok(items)
    }

    /// The current memory of an item in the layer the new sighting belongs to.
    /// A sighting in the owner-only default group looks only at the owner's
    /// own memories, so it can never change a memory that others share.
    /// A shared sighting matches the item in any shared group, so the same
    /// thing filed under two topics on two occasions stays one memory.
    pub async fn active_memory(&self, space_id: &str, owner_id: &str, item_key: &str, default_group: &str, owner_only: bool) -> anyhow::Result<Option<ExistingMemory>> {
        let mut filter = doc! { "space_id": space_id, "item_key": item_key, "status": "active" };
        if owner_only {
            filter.insert("group", default_group);
            filter.insert("owner_id", owner_id);
        } else {
            filter.insert("group", doc! { "$ne": default_group });
        }
        self.memories
            .clone_with_type::<ExistingMemory>()
            .find_one(filter)
            .projection(doc! { "location": 1, "tactile_anchor": 1, "expires_at": 1 })
            .await
            .context("looking up the active memory")
    }

    /// Applies a memory change and its audit row in one transaction, so a
    /// memory never changes without a record of why. Retries when two writers
    /// collide on the same memory.
    pub async fn apply(&self, change: Change, audit_event: Option<Document>) -> anyhow::Result<()> {
        for attempt in 1..=TRANSACTION_ATTEMPTS {
            match self.try_apply(&change, audit_event.as_ref()).await {
                Ok(true) => return Ok(()),
                Ok(false) => anyhow::bail!("the memory was changed by someone else at the same moment"),
                Err(e) if attempt < TRANSACTION_ATTEMPTS && e.contains_label(TRANSIENT_TRANSACTION_ERROR) => {
                    tokio::time::sleep(Duration::from_millis(50 * u64::from(attempt))).await;
                }
                Err(e) => return Err(e).context("applying memory change"),
            }
        }
        unreachable!("the last attempt always returns")
    }

    /// Returns false, having written nothing, if the memory to change is no longer active.
    async fn try_apply(&self, change: &Change, audit_event: Option<&Document>) -> mongodb::error::Result<bool> {
        let mut session = self.client.start_session().await?;
        session.start_transaction().await?;
        let still_active = |id: &Bson| doc! { "_id": id.clone(), "status": "active" };
        let applied = match change {
            Change::Add(new_doc) => {
                self.memories.insert_one(new_doc.clone()).session(&mut session).await?;
                true
            }
            Change::Reinforce { id, seen_at, expires_at } => {
                let mut set = doc! { "updated_at": *seen_at };
                if let Some(expires_at) = expires_at {
                    set.insert("expires_at", *expires_at);
                }
                let update = doc! { "$inc": { "reinforcement_count": 1 }, "$set": set };
                self.memories.update_one(still_active(id), update).session(&mut session).await?.matched_count == 1
            }
            Change::Supersede { old_id, new_id, new_doc } => {
                let update = doc! { "$set": { "status": "superseded", "superseded_by": new_id.as_str(), "updated_at": DateTime::now() } };
                let retired = self.memories.update_one(still_active(old_id), update).session(&mut session).await?.matched_count == 1;
                if retired {
                    self.memories.insert_one(new_doc.clone()).session(&mut session).await?;
                }
                retired
            }
        };
        if !applied {
            session.abort_transaction().await?;
            return Ok(false);
        }
        if let Some(audit_event) = audit_event {
            self.audit.insert_one(audit_event.clone()).session(&mut session).await?;
        }
        session.commit_transaction().await?;
        Ok(true)
    }

    /// Every memory in a space, newest first, without the vectors. For the dashboard.
    pub async fn list_memories(&self, space_id: &str) -> anyhow::Result<Vec<Document>> {
        let cursor = self.memories.find(doc! { "space_id": space_id }).projection(doc! { NO_VECTOR: 0 }).sort(doc! { "created_at": -1 }).limit(300).await;
        collect(cursor.context("listing memories")?).await
    }

    /// The newest audit rows of a space.
    pub async fn list_audit(&self, space_id: &str) -> anyhow::Result<Vec<Document>> {
        let cursor = self.audit.find(doc! { "space_id": space_id }).sort(doc! { "ts": -1 }).limit(200).await;
        collect(cursor.context("listing audit events")?).await
    }

    /// Governed retrieval: the filter runs inside Atlas Vector Search, so a
    /// memory the asker may not see is never returned, and so never reaches a prompt.
    pub async fn vector_search(&self, space_id: &str, user_id: &str, scope: &Scope, query: &[f32], limit: i32) -> anyhow::Result<Vec<Document>> {
        let mut conditions = vec![doc! { "space_id": space_id }, doc! { "status": "active" }];
        conditions.extend(readable(user_id, scope));
        let pipeline = [
            doc! { "$vectorSearch": {
                "index": VECTOR_INDEX,
                "path": "embedding",
                "queryVector": query.iter().map(|x| Bson::Double(f64::from(*x))).collect::<Vec<_>>(),
                "numCandidates": (limit * 12).max(60),
                "limit": limit,
                "filter": { "$and": conditions },
            } },
            doc! { "$project": { NO_VECTOR: 0, "image_url": 0, "frame_thumb_b64": 0, "score": { "$meta": "vectorSearchScore" } } },
        ];
        collect(self.memories.aggregate(pipeline).await.context("vector search")?).await
    }

    /// Active memories in the space that this user may NOT read. Only used to
    /// detect and audit a blocked question; their contents are never returned.
    pub async fn hidden_from(&self, space_id: &str, user_id: &str, scope: &Scope) -> anyhow::Result<Vec<Document>> {
        let Scope::Groups(groups) = scope else { return Ok(Vec::new()) };
        let filter = doc! { "space_id": space_id, "status": "active", "owner_id": { "$ne": user_id }, "group": { "$nin": groups.clone() } };
        let cursor = self.memories.find(filter).projection(doc! { "item_key": 1, "item": 1, "owner_id": 1, "group": 1 }).limit(500).await;
        collect(cursor.context("listing hidden memories")?).await
    }

    /// The user's own active memories, for "forget".
    pub async fn own_active(&self, space_id: &str, user_id: &str) -> anyhow::Result<Vec<Document>> {
        let filter = doc! { "space_id": space_id, "status": "active", "owner_id": user_id };
        // Pictures are left out: this list is only matched by name.
        collect(self.memories.find(filter).projection(doc! { NO_VECTOR: 0, "image_url": 0 }).await.context("listing own memories")?).await
    }

    /// Marks memories with a final status ("forgotten" or "expired"), strips
    /// what could still answer a question, schedules their deletion, and
    /// records each one, in one transaction. Returns how many changed.
    /// `strip_text` also removes the words (for "forget": nothing about the thing may remain readable).
    pub async fn retire(&self, ids: Vec<Bson>, status: &str, purge_at: DateTime, audit_events: Vec<Document>, strip_text: bool) -> anyhow::Result<u64> {
        let mut session = self.client.start_session().await?;
        session.start_transaction().await?;
        let mut set = doc! { "status": status, "updated_at": DateTime::now(), "purge_at": purge_at };
        let mut unset = doc! { "embedding": "", "image_url": "", "frame_thumb_b64": "", "transcript_snippet": "" };
        if strip_text {
            set.insert("summary", "Forgotten at the owner's request.");
            unset.extend(doc! { "location": "", "tactile_anchor": "", "previous_location": "", "bbox": "" });
        }
        let update = doc! { "$set": set, "$unset": unset };
        let changed = self.memories.update_many(doc! { "_id": { "$in": ids }, "status": "active" }, update).session(&mut session).await.context("retiring memories")?.modified_count;
        if changed > 0 && !audit_events.is_empty() {
            self.audit.insert_many(audit_events).session(&mut session).await.context("writing audit events")?;
        }
        session.commit_transaction().await.context("committing")?;
        Ok(changed)
    }

    /// Active memories whose time is up.
    pub async fn due_to_expire(&self, now: DateTime) -> anyhow::Result<Vec<Document>> {
        let filter = doc! { "status": "active", "expires_at": { "$lte": now } };
        collect(self.memories.find(filter).projection(doc! { "space_id": 1, "item": 1, "owner_id": 1 }).limit(200).await.context("finding expired memories")?).await
    }

    pub async fn insert_audit(&self, audit_event: Document) -> anyhow::Result<()> {
        self.audit.insert_one(audit_event).await.context("writing audit event")?;
        Ok(())
    }

    /// A change stream on `memories` or `audit_events`, for the live dashboard feed.
    pub async fn watch(&self, collection: &str) -> mongodb::error::Result<ChangeStream<ChangeStreamEvent<Document>>> {
        let coll = if collection == "memories" { &self.memories } else { &self.audit };
        coll.watch().pipeline([doc! { "$unset": ["fullDocument.embedding"] }]).full_document(FullDocumentType::UpdateLookup).await
    }

    pub async fn log_observation(&self, observation: Document) -> anyhow::Result<()> {
        self.observations.insert_one(observation).await.context("logging observation")?;
        Ok(())
    }

    #[cfg(test)]
    pub async fn delete_space_data(&self, space_id: &str) -> anyhow::Result<()> {
        for coll in [&self.memories, &self.audit, &self.observations] {
            coll.delete_many(doc! { "space_id": space_id }).await?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub async fn find_all(&self, collection: &str, space_id: &str) -> anyhow::Result<Vec<Document>> {
        let coll = match collection {
            "memories" => &self.memories,
            "audit_events" => &self.audit,
            _ => &self.observations,
        };
        collect(coll.find(doc! { "space_id": space_id }).projection(doc! { NO_VECTOR: 0 }).await?).await
    }
}
