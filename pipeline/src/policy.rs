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

fn is_slug(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// "2h" -> 7200 seconds. None for anything that is not a number followed by s, m, h, d or w.
pub fn keep_for_secs(keep_for: &str) -> Option<i64> {
    let unit = keep_for.chars().last()?;
    // Digits only, as the database accepts: "+5h" parses as a number but is not valid.
    let digits = &keep_for[..keep_for.len() - unit.len_utf8()];
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
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

    /// Checks a Rules document sent by the dashboard against what the database accepts.
    pub fn validate(&self) -> Result<(), String> {
        if !is_slug(&self.default_group) {
            return Err(format!("default_group '{}' must be lowercase letters, digits and underscores", self.default_group));
        }
        for (role, rule) in &self.roles {
            if !is_slug(role) {
                return Err(format!("role name '{role}' must be lowercase letters, digits and underscores"));
            }
            if let Some(bad) = rule.can_see.iter().find(|g| *g != "*" && !is_slug(g)) {
                return Err(format!("role '{role}' lists '{bad}', which is not a group name or \"*\""));
            }
        }
        for (topic, rule) in &self.topics {
            if !is_slug(topic) || !is_slug(&rule.group) {
                return Err(format!("topic '{topic}' and its group '{}' must be lowercase letters, digits and underscores", rule.group));
            }
            if let Some(keep_for) = &rule.keep_for {
                if keep_for_secs(keep_for).is_none() {
                    return Err(format!("topic '{topic}': keep_for '{keep_for}' must be a number followed by s, m, h, d or w, or null"));
                }
            }
        }
        Ok(())
    }
}

pub struct Decision {
    pub topic: String,
    pub group: String,
    pub reason: String,
    pub expires_at: Option<DateTime>,
}

/// Decides the group and lifetime of a new memory from the space's rules.
pub fn decide(space: &Space, proposed_topic: &str, contains_pii: bool, now: DateTime) -> Decision {
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

    // A topic's keep_for and the end of a temporary stay both limit a memory's life; the sooner wins.
    let keep_until = rule.and_then(|r| r.keep_for.as_deref()).and_then(keep_for_secs).map(|secs| DateTime::from_millis(now.timestamp_millis().saturating_add(secs.saturating_mul(1000))));
    let stay_end = if space.mode == "temporary_stay" { space.default_expires_at } else { None };
    let expires_at = match (keep_until, stay_end) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };

    Decision { topic: topic.to_string(), group: group.to_string(), reason, expires_at }
}

#[cfg(test)]
pub fn demo_home() -> Space {
    let role = |groups: &[&str]| RoleRule { can_see: groups.iter().map(|g| g.to_string()).collect() };
    let topic = |group: &str, keep_for: Option<&str>| TopicRule { group: group.into(), keep_for: keep_for.map(str::to_string) };
    let member = |id: &str, role: &str| Member { id: id.into(), name: id.into(), role: role.into() };
    Space {
        mode: "shared_space".into(),
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
        let mut rules = demo_home().rules;
        assert!(rules.validate().is_ok());
        rules.topics.get_mut("hazard").unwrap().keep_for = Some("soon".into());
        assert!(rules.validate().is_err());
        rules.topics.get_mut("hazard").unwrap().keep_for = Some("10s".into());
        rules.default_group = "Resident Only".into();
        assert!(rules.validate().is_err());
    }
}
