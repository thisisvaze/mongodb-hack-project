//! The sharing policy. Each space carries its own rules (docs/api-contract.md):
//! a memory's topic puts it in a group, and each role lists the groups it can
//! see. The extraction model only names a topic; these rules decide the rest.

use std::collections::{BTreeMap, BTreeSet};

use mongodb::bson::DateTime;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct Member {
    pub id: String,
    pub name: String,
    pub role: String,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct RoleRule {
    /// Group names, or "*" for every group.
    pub can_see: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct TopicRule {
    pub group: String,
    /// How long memories of this topic live: a number followed by s, m, h, d or w. Null keeps them.
    pub keep_for: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct Rules {
    pub roles: BTreeMap<String, RoleRule>,
    pub topics: BTreeMap<String, TopicRule>,
    /// Where anything without a matching topic goes. Nothing is shared unless a rule shares it.
    pub default_group: String,
}

/// A document from the `spaces` collection.
#[derive(Deserialize, Clone, Debug)]
pub struct Space {
    pub mode: String,
    #[serde(default)]
    pub owner_id: Option<String>,
    #[serde(default)]
    pub members: Vec<Member>,
    pub rules: Rules,
    #[serde(default)]
    pub default_expires_at: Option<DateTime>,
}

/// What a user may read in a space, besides the memories they own.
#[derive(Debug, PartialEq)]
pub enum Scope {
    Everything,
    Groups(Vec<String>),
}

impl Space {
    pub fn role_of(&self, user_id: &str) -> Option<&str> {
        self.members.iter().find(|m| m.id == user_id).map(|m| m.role.as_str())
    }

    pub fn scope_for(&self, user_id: &str) -> Scope {
        let groups = self.role_of(user_id).and_then(|role| self.rules.roles.get(role)).map(|r| r.can_see.clone()).unwrap_or_default();
        if groups.iter().any(|g| g == "*") {
            Scope::Everything
        } else {
            Scope::Groups(groups)
        }
    }
}

/// A role, topic or group name: lowercase letters, digits and "_", starting
/// with a letter, at most 40 characters. Stricter than the database pattern.
fn is_name(s: &str) -> bool {
    s.len() <= 40 && s.starts_with(|c: char| c.is_ascii_lowercase()) && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

const MAX_ROLES: usize = 20;
const MAX_TOPICS: usize = 50;
const MAX_GROUPS_PER_ROLE: usize = 50;
const MAX_KEEP_FOR_SECS: i64 = 365 * 86_400;

/// "2h" -> 7200 seconds. None for anything that is not a number followed by s, m, h, d or w.
pub fn keep_for_secs(keep_for: &str) -> Option<i64> {
    let unit = keep_for.chars().last()?;
    // Digits only, as the database accepts: "+5h" parses as a number but is not valid.
    let digits = &keep_for[..keep_for.len() - unit.len_utf8()];
    if digits.is_empty() || digits.len() > 6 || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let amount: i64 = digits.parse().ok()?;
    let per_unit = match unit {
        's' => 1,
        'm' => 60,
        'h' => 3600,
        'd' => 86_400,
        'w' => 604_800,
        _ => return None,
    };
    (amount > 0).then(|| amount.saturating_mul(per_unit))
}

impl Rules {
    /// The roles that can see a group.
    pub fn viewers(&self, group: &str) -> BTreeSet<&str> {
        self.roles.iter().filter(|(_, rule)| rule.can_see.iter().any(|g| g == "*" || g == group)).map(|(role, _)| role.as_str()).collect()
    }

    /// How many roles can see a group. A smaller audience means a more restricted group.
    pub fn audience(&self, group: &str) -> usize {
        self.roles.values().filter(|r| r.can_see.iter().any(|g| g == "*" || g == group)).count()
    }

    /// Checks a Rules document sent by the dashboard (the checks of
    /// backend/guardrails/rules.js) and returns a clean copy to store. Besides
    /// the shape, two things are refused: removing a role a member still has,
    /// and taking "see everything" away from the space owner.
    pub fn validate(&self, space: Option<&Space>) -> Result<Rules, String> {
        const NAME_HELP: &str = "must be lowercase letters, numbers and \"_\", start with a letter, and be at most 40 characters (for example care_team)";
        if !is_name(&self.default_group) {
            return Err(format!("default_group \"{}\" {NAME_HELP}", self.default_group));
        }
        if self.roles.is_empty() {
            return Err("rules.roles must list at least one role".into());
        }
        if self.roles.len() > MAX_ROLES {
            return Err(format!("At most {MAX_ROLES} roles"));
        }
        if self.topics.len() > MAX_TOPICS {
            return Err(format!("At most {MAX_TOPICS} topics"));
        }

        let mut roles = BTreeMap::new();
        for (role, rule) in &self.roles {
            if !is_name(role) {
                return Err(format!("Role \"{role}\" {NAME_HELP}"));
            }
            if rule.can_see.len() > MAX_GROUPS_PER_ROLE {
                return Err(format!("rules.roles.{role}.can_see lists more than {MAX_GROUPS_PER_ROLE} groups"));
            }
            if let Some(bad) = rule.can_see.iter().find(|g| *g != "*" && !is_name(g)) {
                return Err(format!("Group in rules.roles.{role}.can_see \"{bad}\" {NAME_HELP}"));
            }
            // "*" already covers every group, so keep it alone.
            let mut can_see: Vec<String> = Vec::new();
            for group in &rule.can_see {
                if !can_see.contains(group) {
                    can_see.push(group.clone());
                }
            }
            if can_see.iter().any(|g| g == "*") {
                can_see = vec!["*".to_string()];
            }
            roles.insert(role.clone(), RoleRule { can_see });
        }
        for (topic, rule) in &self.topics {
            if !is_name(topic) {
                return Err(format!("Topic \"{topic}\" {NAME_HELP}"));
            }
            if !is_name(&rule.group) {
                return Err(format!("Group of topic {topic} \"{}\" {NAME_HELP}", rule.group));
            }
            if let Some(keep_for) = &rule.keep_for {
                match keep_for_secs(keep_for) {
                    None => return Err(format!("rules.topics.{topic}.keep_for must be null or a number followed by s, m, h, d or w, such as \"30d\" or \"2h\"")),
                    Some(secs) if secs > MAX_KEEP_FOR_SECS => return Err(format!("rules.topics.{topic}.keep_for is longer than 365 days. Use null to keep it with no end date")),
                    Some(_) => {}
                }
            }
        }

        if let Some(space) = space {
            // Every member needs a role in the rules, or they silently lose access.
            let mut missing: Vec<&str> = space.members.iter().map(|m| m.role.as_str()).filter(|r| !roles.contains_key(*r)).collect();
            missing.sort_unstable();
            missing.dedup();
            if !missing.is_empty() {
                return Err(format!("Role {} is used by a member of this space, so it must stay in rules.roles", missing.join(", ")));
            }
            // The owner must keep seeing everything, or a rule change can hide
            // the space from the person the system is for.
            let owner = space.owner_id.as_deref().and_then(|id| space.members.iter().find(|m| m.id == id));
            if let Some(owner) = owner {
                if !roles[&owner.role].can_see.iter().any(|g| g == "*") {
                    return Err(format!("Role {} belongs to the space owner and must keep can_see [\"*\"]", owner.role));
                }
            }
        }
        Ok(Rules { roles, topics: self.topics.clone(), default_group: self.default_group.clone() })
    }

    /// A plain-language summary of a rule change, for the audit log.
    pub fn describe_change(&self, after: &Rules) -> String {
        let name = |groups: &[&String]| groups.iter().map(|g| if g.as_str() == "*" { "everything" } else { g.as_str() }).collect::<Vec<_>>().join(", ");
        let mut parts = Vec::new();
        for (role, rule) in &after.roles {
            let was: &[String] = self.roles.get(role).map_or(&[], |r| r.can_see.as_slice());
            if !self.roles.contains_key(role) {
                parts.push(format!("Role {role} added."));
            }
            let gained: Vec<&String> = rule.can_see.iter().filter(|g| !was.contains(g)).collect();
            let lost: Vec<&String> = was.iter().filter(|g| !rule.can_see.contains(g)).collect();
            if !gained.is_empty() {
                parts.push(format!("Role {role} can now see {}.", name(&gained)));
            }
            if !lost.is_empty() {
                parts.push(format!("Role {role} can no longer see {}.", name(&lost)));
            }
        }
        for role in self.roles.keys().filter(|r| !after.roles.contains_key(*r)) {
            parts.push(format!("Role {role} removed."));
        }
        for (topic, rule) in &after.topics {
            match self.topics.get(topic) {
                None => parts.push(format!("Topic {topic} added in group {}.", rule.group)),
                Some(was) => {
                    if was.group != rule.group {
                        parts.push(format!("Topic {topic} moved from group {} to {}.", was.group, rule.group));
                    }
                    if was.keep_for != rule.keep_for {
                        parts.push(format!("Topic {topic} is now kept for {}.", rule.keep_for.as_deref().unwrap_or("ever")));
                    }
                }
            }
        }
        for topic in self.topics.keys().filter(|t| !after.topics.contains_key(*t)) {
            parts.push(format!("Topic {topic} removed."));
        }
        if self.default_group != after.default_group {
            parts.push(format!("Default group is now {}.", after.default_group));
        }
        if parts.is_empty() { "Rules saved with no changes.".to_string() } else { parts.join(" ") }
    }
}

pub struct Decision {
    pub topic: String,
    pub group: String,
    pub reason: String,
    pub expires_at: Option<DateTime>,
    /// True when a secret or identity number was removed from the words.
    pub pii_redacted: bool,
}

/// Decides the group and lifetime of a new memory from the space's rules.
#[cfg(test)]
pub fn decide(space: &Space, proposed_topic: &str, contains_pii: bool, now: DateTime) -> Decision {
    decide_with_removed(space, proposed_topic, contains_pii, &[], now)
}

/// As `decide`, for a note whose words had `removed` taken out of them (a
/// card number, a PIN ...): such a note stays in the default group, whatever its topic.
pub fn decide_with_removed(space: &Space, proposed_topic: &str, contains_pii: bool, removed: &[&str], now: DateTime) -> Decision {
    let rules = &space.rules;
    let rule = rules.topics.get(proposed_topic);
    let topic = if rule.is_some() { proposed_topic } else { "other" };
    let mut group = rule.map_or(rules.default_group.as_str(), |r| r.group.as_str());
    let mut reason = match rule {
        Some(_) => format!("Topic '{topic}' is in group '{group}'."),
        None => format!("No rule covers this, so it stays in the default group '{group}'."),
    };

    // Something personal that was filed under a topic everyone can see is pulled back.
    if contains_pii && group != rules.default_group && !rules.roles.is_empty() && rules.audience(group) == rules.roles.len() {
        group = rules.default_group.as_str();
        reason = format!("Contains personal details, so it stays in the default group '{group}' instead of one every role can see.");
    }

    if !removed.is_empty() {
        let what = removed.join(", ");
        reason = if group != rules.default_group {
            format!("Removed {what} before saving, so kept in {} instead of {group}.", rules.default_group)
        } else {
            format!("{reason} Removed {what} before saving.")
        };
        group = rules.default_group.as_str();
    }

    // A topic's keep_for and the end of a temporary stay both limit a memory's life; the sooner wins.
    let keep_until = rule.and_then(|r| r.keep_for.as_deref()).and_then(keep_for_secs).map(|secs| DateTime::from_millis(now.timestamp_millis().saturating_add(secs.saturating_mul(1000))));
    let stay_end = if space.mode == "temporary_stay" { space.default_expires_at } else { None };
    let expires_at = match (keep_until, stay_end) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };

    Decision { topic: topic.to_string(), group: group.to_string(), reason, expires_at, pii_redacted: !removed.is_empty() }
}

#[cfg(test)]
pub fn demo_home() -> Space {
    let role = |groups: &[&str]| RoleRule { can_see: groups.iter().map(|g| g.to_string()).collect() };
    let topic = |group: &str, keep_for: Option<&str>| TopicRule { group: group.into(), keep_for: keep_for.map(str::to_string) };
    let member = |id: &str, role: &str| Member { id: id.into(), name: id.into(), role: role.into() };
    Space {
        mode: "shared_space".into(),
        owner_id: Some("u_resident".into()),
        members: vec![member("u_resident", "resident"), member("u_caregiver", "caregiver"), member("u_visitor", "visitor")],
        rules: Rules {
            roles: BTreeMap::from([("resident".into(), role(&["*"])), ("caregiver".into(), role(&["care", "supplies", "house_guide"])), ("visitor".into(), role(&["house_guide"]))]),
            topics: BTreeMap::from([
                ("medication".into(), topic("care", Some("30d"))),
                ("supplies".into(), topic("supplies", None)),
                ("valuables".into(), topic("resident_only", None)),
                ("documents".into(), topic("resident_only", None)),
                ("house_guide".into(), topic("house_guide", None)),
                ("hazard".into(), topic("house_guide", Some("2h"))),
            ]),
            default_group: "resident_only".into(),
        },
        default_expires_at: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_topic_puts_a_memory_in_its_group() {
        let now = DateTime::from_millis(1_000_000);
        let d = decide(&demo_home(), "house_guide", false, now);
        assert_eq!((d.topic.as_str(), d.group.as_str(), d.expires_at), ("house_guide", "house_guide", None));
        let d = decide(&demo_home(), "valuables", false, now);
        assert_eq!(d.group, "resident_only");
    }

    #[test]
    fn anything_without_a_rule_goes_to_the_default_group() {
        let d = decide(&demo_home(), "garden_gnomes", false, DateTime::now());
        assert_eq!((d.topic.as_str(), d.group.as_str()), ("other", "resident_only"));
    }

    #[test]
    fn keep_for_sets_the_expiry() {
        let now = DateTime::from_millis(1_000_000);
        assert_eq!(decide(&demo_home(), "hazard", false, now).expires_at, Some(DateTime::from_millis(1_000_000 + 7_200_000)));
        assert_eq!(decide(&demo_home(), "medication", false, now).expires_at, Some(DateTime::from_millis(1_000_000 + 30 * 86_400_000)));
        assert_eq!((keep_for_secs("10s"), keep_for_secs("2w"), keep_for_secs("h"), keep_for_secs("5x"), keep_for_secs("0m")), (Some(10), Some(1_209_600), None, None, None));
        assert_eq!((keep_for_secs("+5h"), keep_for_secs("-5h"), keep_for_secs("1.5h"), keep_for_secs("")), (None, None, None, None));
    }

    #[test]
    fn personal_details_are_pulled_out_of_a_group_everyone_sees() {
        let now = DateTime::now();
        // house_guide is visible to all three roles: a personal item filed there is pulled back.
        assert_eq!(decide(&demo_home(), "house_guide", true, now).group, "resident_only");
        // care is already restricted (the visitor cannot see it), so medication stays with the carers.
        assert_eq!(decide(&demo_home(), "medication", true, now).group, "care");
    }

    #[test]
    fn a_temporary_stay_expires_everything_at_its_end() {
        let now = DateTime::from_millis(1_000_000);
        let stay_end = DateTime::from_millis(1_000_000 + 3_600_000);
        let stay = Space { mode: "temporary_stay".into(), default_expires_at: Some(stay_end), ..demo_home() };
        assert_eq!(decide(&stay, "house_guide", false, now).expires_at, Some(stay_end));
        // The hazard's own 2 hours would outlast the stay, so the stay's end wins.
        assert_eq!(decide(&stay, "hazard", false, now).expires_at, Some(stay_end));
    }

    #[test]
    fn roles_see_their_groups_and_audience_counts_them() {
        let home = demo_home();
        assert_eq!(home.scope_for("u_resident"), Scope::Everything);
        assert_eq!(home.scope_for("u_visitor"), Scope::Groups(vec!["house_guide".into()]));
        assert_eq!(home.scope_for("stranger"), Scope::Groups(vec![]));
        assert_eq!((home.rules.audience("house_guide"), home.rules.audience("care"), home.rules.audience("resident_only")), (3, 2, 1));
        assert_eq!(home.rules.viewers("care").into_iter().collect::<Vec<_>>(), ["caregiver", "resident"]);
        assert!(home.rules.viewers("resident_only").is_subset(&home.rules.viewers("care")));
        assert!(!home.rules.viewers("house_guide").is_subset(&home.rules.viewers("care")));
    }

    #[test]
    fn rules_from_the_dashboard_are_checked() {
        let home = demo_home();
        let mut rules = home.rules.clone();
        assert!(rules.validate(Some(&home)).is_ok());
        rules.topics.get_mut("hazard").unwrap().keep_for = Some("soon".into());
        assert!(rules.validate(Some(&home)).is_err());
        rules.topics.get_mut("hazard").unwrap().keep_for = Some("10s".into());
        rules.default_group = "Resident Only".into();
        assert!(rules.validate(Some(&home)).is_err());

        // The owner's role must keep seeing everything, and a member's role cannot be removed.
        let mut rules = home.rules.clone();
        rules.roles.get_mut("resident").unwrap().can_see = vec!["care".into()];
        assert!(rules.validate(Some(&home)).unwrap_err().contains("space owner"));
        let mut rules = home.rules.clone();
        rules.roles.remove("visitor");
        assert!(rules.validate(Some(&home)).unwrap_err().contains("used by a member"));
        // A name must start with a letter; a year-plus keep-time is refused.
        let mut rules = home.rules.clone();
        rules.topics.insert("__proto__".into(), TopicRule { group: "care".into(), keep_for: None });
        assert!(rules.validate(Some(&home)).is_err());
        let mut rules = home.rules.clone();
        rules.topics.get_mut("hazard").unwrap().keep_for = Some("400d".into());
        assert!(rules.validate(Some(&home)).is_err());

        // A real change is described in words for the audit log.
        let mut rules = home.rules.clone();
        rules.roles.get_mut("visitor").unwrap().can_see = vec!["house_guide".into(), "supplies".into(), "supplies".into()];
        let clean = rules.validate(Some(&home)).unwrap();
        assert_eq!(clean.roles["visitor"].can_see, ["house_guide", "supplies"]);
        assert_eq!(home.rules.describe_change(&clean), "Role visitor can now see supplies.");
        assert_eq!(home.rules.describe_change(&home.rules), "Rules saved with no changes.");

        // A note that had a card number removed stays private whatever its topic.
        let d = decide_with_removed(&home, "house_guide", false, &["card number"], DateTime::now());
        assert_eq!((d.group.as_str(), d.pii_redacted), ("resident_only", true));
    }
}
