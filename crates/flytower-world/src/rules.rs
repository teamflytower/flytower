//! What counts as unused: the rules file `flytower-world trim --rules` reads.
//!
//! It's JSON, made by the panel from the server's spec (`world.trim`). Every field is
//! optional and falls back to the defaults below; an unknown field is an error, so a typo
//! can't quietly loosen a rule.
//!
//! ```json
//! {
//!   "inhabitedMinutes": 2,
//!   "spawnRadius": 16,
//!   "playerRadius": 4,
//!   "buffer": 2,
//!   "endRadius": 12,
//!   "unfinished": true,
//!   "border": true,
//!   "dimensions": ["overworld", "the_nether", "the_end"],
//!   "protect": [
//!     { "name": "Town", "dimension": "overworld", "from": [-400, -300], "to": [350, 420] }
//!   ]
//! }
//! ```
//!
//! Radii and the buffer are in chunks, measured as squares. Protected areas are in blocks,
//! and keep every chunk they touch.

use serde_json::{Map, Value};

/// Ticks in a minute: `InhabitedTime` counts ticks.
pub const TICKS_PER_MINUTE: i64 = 1200;

/// A named area that's always kept, in chunks, corners included.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Area {
    pub name: String,
    /// A dimension id, like `minecraft:overworld`.
    pub dimension: String,
    pub min: (i32, i32),
    pub max: (i32, i32),
}

impl Area {
    /// Whether this area keeps chunk `x`, `z` of `dimension`.
    #[must_use]
    pub fn contains(&self, dimension: &str, x: i32, z: i32) -> bool {
        self.dimension == dimension
            && (self.min.0..=self.max.0).contains(&x)
            && (self.min.1..=self.max.1).contains(&z)
    }
}

/// The rules. A chunk goes only if every rule agrees it can.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rules {
    /// Chunks players have spent at least this long in (in ticks) are kept. Even at 0, a
    /// chunk anyone has spent any time in is kept.
    pub inhabited_ticks: i64,
    /// Chunks this close to world spawn are kept.
    pub spawn_radius: i32,
    /// Chunks this close to a player's last position or respawn point are kept.
    pub player_radius: i32,
    /// Chunks this close to a kept chunk are kept too, so builds don't end at a seam.
    pub buffer: i32,
    /// End chunks this close to 0,0 are kept: the main island and the dragon fight.
    pub end_radius: i32,
    /// Remove half-generated chunks (not `minecraft:full`), wherever they are.
    pub unfinished: bool,
    /// Remove chunks wholly outside the world border.
    pub border: bool,
    /// The dimensions to trim, by id.
    pub dimensions: Vec<String>,
    /// Areas that are always kept.
    pub protect: Vec<Area>,
}

impl Default for Rules {
    fn default() -> Self {
        Self {
            inhabited_ticks: 2 * TICKS_PER_MINUTE,
            spawn_radius: 16,
            player_radius: 4,
            buffer: 2,
            end_radius: 12,
            unfinished: true,
            border: true,
            dimensions: ["overworld", "the_nether", "the_end"]
                .map(|d| format!("minecraft:{d}"))
                .to_vec(),
            protect: Vec::new(),
        }
    }
}

/// A dimension id, with `minecraft:` added to a bare name.
#[must_use]
pub fn dimension_id(name: &str) -> String {
    if name.contains(':') {
        name.to_owned()
    } else {
        format!("minecraft:{name}")
    }
}

impl Rules {
    /// Reads the rules file.
    ///
    /// # Errors
    ///
    /// When it isn't JSON, has a field we don't know, or a value out of range. The message
    /// names the field.
    pub fn parse(text: &str) -> Result<Self, String> {
        let value: Value =
            serde_json::from_str(text).map_err(|e| format!("rules aren't JSON: {e}"))?;
        let Value::Object(fields) = value else {
            return Err("rules must be a JSON object".into());
        };
        let mut rules = Self::default();
        for (key, value) in &fields {
            match key.as_str() {
                "inhabitedMinutes" => {
                    let minutes = number(key, value, 0.0, 60.0)?;
                    // At most 72,000 ticks, so the cast can't overflow.
                    #[expect(
                        clippy::cast_possible_truncation,
                        reason = "checked to be 0 to 60 minutes above"
                    )]
                    let ticks = (minutes * 1200.0).round() as i64;
                    rules.inhabited_ticks = ticks;
                }
                "spawnRadius" => rules.spawn_radius = whole(key, value, 0, 256)?,
                "playerRadius" => rules.player_radius = whole(key, value, 0, 64)?,
                "buffer" => rules.buffer = whole(key, value, 0, 16)?,
                "endRadius" => rules.end_radius = whole(key, value, 0, 256)?,
                "unfinished" => rules.unfinished = boolean(key, value)?,
                "border" => rules.border = boolean(key, value)?,
                "dimensions" => {
                    let list = value
                        .as_array()
                        .ok_or_else(|| format!("{key} must be a list of dimension ids"))?;
                    rules.dimensions = list
                        .iter()
                        .map(|d| {
                            d.as_str()
                                .filter(|s| !s.is_empty())
                                .map(dimension_id)
                                .ok_or_else(|| format!("{key} must be a list of dimension ids"))
                        })
                        .collect::<Result<_, _>>()?;
                }
                "protect" => {
                    let list = value
                        .as_array()
                        .ok_or_else(|| format!("{key} must be a list of areas"))?;
                    rules.protect = list
                        .iter()
                        .enumerate()
                        .map(|(i, a)| area(a).map_err(|e| format!("protect[{i}]: {e}")))
                        .collect::<Result<_, _>>()?;
                }
                _ => return Err(format!("unknown rule {key}")),
            }
        }
        Ok(rules)
    }
}

fn number(key: &str, value: &Value, lo: f64, hi: f64) -> Result<f64, String> {
    value
        .as_f64()
        .filter(|n| (lo..=hi).contains(n))
        .ok_or_else(|| format!("{key} must be a number from {lo} to {hi}"))
}

fn whole(key: &str, value: &Value, lo: i32, hi: i32) -> Result<i32, String> {
    value
        .as_i64()
        .and_then(|n| i32::try_from(n).ok())
        .filter(|n| (lo..=hi).contains(n))
        .ok_or_else(|| format!("{key} must be a whole number from {lo} to {hi}"))
}

fn boolean(key: &str, value: &Value) -> Result<bool, String> {
    value
        .as_bool()
        .ok_or_else(|| format!("{key} must be true or false"))
}

/// Block coordinates as far as Minecraft goes, and a little more.
const LIMIT: i64 = 30_000_000;

fn corner(fields: &Map<String, Value>, key: &str) -> Result<(i32, i32), String> {
    let bad = || format!("{key} must be [x, z] in blocks");
    let pair = fields.get(key).and_then(Value::as_array).ok_or_else(bad)?;
    let [x, z] = pair.as_slice() else {
        return Err(bad());
    };
    let block = |v: &Value| {
        v.as_i64()
            .filter(|n| (-LIMIT..=LIMIT).contains(n))
            .and_then(|n| i32::try_from(n).ok())
            .ok_or_else(bad)
    };
    // Blocks to chunks: an arithmetic shift rounds down, negatives included.
    Ok((block(x)? >> 4, block(z)? >> 4))
}

fn area(value: &Value) -> Result<Area, String> {
    let Value::Object(fields) = value else {
        return Err("must be an object".into());
    };
    for key in fields.keys() {
        if !matches!(key.as_str(), "name" | "dimension" | "from" | "to") {
            return Err(format!("unknown field {key}"));
        }
    }
    let name = fields
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let dimension = fields
        .get("dimension")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map_or_else(|| "minecraft:overworld".to_owned(), dimension_id);
    let (a, b) = (corner(fields, "from")?, corner(fields, "to")?);
    Ok(Area {
        name,
        dimension,
        min: (a.0.min(b.0), a.1.min(b.1)),
        max: (a.0.max(b.0), a.1.max(b.1)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_rules_are_the_defaults() {
        assert_eq!(Rules::parse("{}").unwrap(), Rules::default());
        let d = Rules::default();
        assert_eq!(d.inhabited_ticks, 2400);
        assert_eq!(
            d.dimensions,
            [
                "minecraft:overworld",
                "minecraft:the_nether",
                "minecraft:the_end"
            ]
        );
    }

    #[test]
    fn reads_every_rule() {
        let rules = Rules::parse(
            r#"{"inhabitedMinutes": 0.5, "spawnRadius": 3, "playerRadius": 0, "buffer": 1,
                "endRadius": 20, "unfinished": false, "border": false,
                "dimensions": ["the_nether", "mod:sky"],
                "protect": [{"name": "Town", "from": [-400, 31], "to": [-17, -16]},
                            {"dimension": "the_end", "from": [0, 0], "to": [15, 15]}]}"#,
        )
        .unwrap();
        assert_eq!(rules.inhabited_ticks, 600);
        assert_eq!(
            (rules.spawn_radius, rules.player_radius, rules.buffer),
            (3, 0, 1)
        );
        assert_eq!(rules.end_radius, 20);
        assert!(!rules.unfinished && !rules.border);
        assert_eq!(rules.dimensions, ["minecraft:the_nether", "mod:sky"]);
        let town = &rules.protect[0];
        assert_eq!(town.dimension, "minecraft:overworld");
        assert_eq!((town.min, town.max), ((-25, -1), (-2, 1)));
        assert!(town.contains("minecraft:overworld", -25, 1));
        assert!(!town.contains("minecraft:overworld", -26, 1));
        assert!(!town.contains("minecraft:the_nether", -10, 0));
        assert_eq!(rules.protect[1].max, (0, 0));
    }

    #[test]
    fn refuses_mistakes() {
        for (text, why) in [
            ("[]", "object"),
            ("{\"spawnradius\": 3}", "unknown rule spawnradius"),
            ("{\"inhabitedMinutes\": 61}", "inhabitedMinutes"),
            ("{\"buffer\": 1.5}", "buffer"),
            ("{\"buffer\": -1}", "buffer"),
            ("{\"border\": 1}", "border"),
            ("{\"dimensions\": [\"\"]}", "dimensions"),
            ("{\"protect\": [{\"from\": [0, 0]}]}", "protect[0]: to"),
            (
                "{\"protect\": [{\"from\": [0, 0], \"to\": [1, 2, 3]}]}",
                "protect[0]: to",
            ),
            (
                "{\"protect\": [{\"from\": [0, 0], \"to\": [0, 0], \"size\": 1}]}",
                "unknown field size",
            ),
            (
                "{\"protect\": [{\"from\": [0, 0], \"to\": [99999999999, 0]}]}",
                "protect[0]: to",
            ),
        ] {
            let err = Rules::parse(text).unwrap_err();
            assert!(err.contains(why), "{text}: {err}");
        }
    }
}
