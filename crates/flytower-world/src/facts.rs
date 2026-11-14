//! What the world says about itself that the rules need: where spawn is, where players
//! were, where the border is, and which chunks are force-loaded.
//!
//! Minecraft has moved most of these between versions, so each is read from wherever the
//! world keeps it:
//!
//! - Spawn: `level.dat` `Data.spawn` (`dimension`, `pos`) from 1.21.9, `Data.SpawnX/Z` before.
//! - Players: `players/data/*.dat` from 26.1, `playerdata/*.dat` before. Their `Pos` and
//!   `Dimension`, and their respawn point: `respawn` (`dimension`, `pos`) from 1.21.5,
//!   `SpawnX/Z` and `SpawnDimension` before.
//! - Border: each dimension's `data/minecraft/world_border.dat` from 26.1; before that one
//!   border in `level.dat`, which the Nether sees at an eighth of the size.
//! - Forced chunks: each dimension's `data/minecraft/chunk_tickets.dat` from 26.1,
//!   `data/chunks.dat` (`Forced`) before.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use flytower_anvil::nbt::{self, Tag};
use flytower_anvil::world::Dimension;

/// A place in a dimension, in chunks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Place {
    pub dimension: String,
    pub x: i32,
    pub z: i32,
}

impl Place {
    fn from_blocks(dimension: &str, x: f64, z: f64) -> Option<Self> {
        let limit = 30_000_000.0;
        if !(x.is_finite() && z.is_finite() && x.abs() <= limit && z.abs() <= limit) {
            return None;
        }
        // In range, so the casts are exact after flooring.
        #[expect(
            clippy::cast_possible_truncation,
            reason = "checked to be within the world above"
        )]
        let (bx, bz) = (x.floor() as i32, z.floor() as i32);
        Some(Self {
            dimension: dimension.to_owned(),
            x: bx >> 4,
            z: bz >> 4,
        })
    }
}

/// A square world border, in blocks.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Border {
    pub centre_x: f64,
    pub centre_z: f64,
    pub size: f64,
}

impl Border {
    /// Whether chunk `x`, `z` lies wholly outside the border.
    #[must_use]
    pub fn outside(&self, x: i32, z: i32) -> bool {
        let half = self.size / 2.0;
        let (x0, z0) = (f64::from(x) * 16.0, f64::from(z) * 16.0);
        x0 + 16.0 <= self.centre_x - half
            || x0 >= self.centre_x + half
            || z0 + 16.0 <= self.centre_z - half
            || z0 >= self.centre_z + half
    }
}

/// Everything the rules need from outside the region files.
#[derive(Debug, Default, Clone)]
pub struct Facts {
    pub spawn: Option<Place>,
    /// Every player's last position and respawn point.
    pub players: Vec<Place>,
    /// Files we couldn't read. Trimming goes on without them; the report lists them.
    pub warnings: Vec<String>,
    /// `level.dat`'s `Data`, for the older single world border.
    pub level: Option<Tag>,
}

impl Facts {
    /// Reads spawn and players from a world folder.
    #[must_use]
    pub fn read(world: &Path) -> Self {
        let mut facts = Self::default();
        match nbt::read_dat(&world.join("level.dat")) {
            Ok(level) => {
                let data = level.get("Data").cloned().unwrap_or(level);
                facts.spawn = spawn(&data);
                facts.level = Some(data);
            }
            Err(e) => facts.warnings.push(e),
        }
        for dir in ["players/data", "playerdata"] {
            for path in dat_files(&world.join(dir)) {
                match nbt::read_dat(&path) {
                    Ok(player) => facts.players.extend(player_places(&player)),
                    Err(e) => facts.warnings.push(e),
                }
            }
        }
        facts
    }

    /// The border of one dimension, if it has one smaller than the whole world.
    #[must_use]
    pub fn border(&self, dim: &Dimension) -> Option<Border> {
        let path = dim.data().join("minecraft/world_border.dat");
        let border = if path.is_file() {
            let data = nbt::read_dat(&path).ok()?;
            let data = data.get("data")?;
            Border {
                centre_x: data.get("center_x")?.as_f64()?,
                centre_z: data.get("center_z")?.as_f64()?,
                size: data.get("size")?.as_f64()?,
            }
        } else {
            // Before 26.1: one border, which the Nether sees scaled down eight times.
            let level = self.level.as_ref()?;
            let scale = match dim.id.as_str() {
                "minecraft:overworld" | "minecraft:the_end" => 1.0,
                "minecraft:the_nether" => 8.0,
                _ => return None,
            };
            Border {
                centre_x: level.get("BorderCenterX")?.as_f64()? / scale,
                centre_z: level.get("BorderCenterZ")?.as_f64()? / scale,
                size: level.get("BorderSize")?.as_f64()? / scale,
            }
        };
        (border.size.is_finite() && border.size > 0.0 && border.size < 59_000_000.0)
            .then_some(border)
    }
}

/// Chunks kept loaded with `/forceload`: farms and the like, which someone wants kept.
#[must_use]
pub fn forced(dim: &Dimension) -> HashSet<(i32, i32)> {
    let mut out = HashSet::new();
    if let Ok(tickets) = nbt::read_dat(&dim.data().join("minecraft/chunk_tickets.dat")) {
        let list = tickets
            .get("data")
            .and_then(|d| d.get("tickets"))
            .and_then(Tag::as_list)
            .unwrap_or_default();
        for ticket in list {
            if ticket.get("type").and_then(Tag::as_str) == Some("minecraft:forced")
                && let Some(&[x, z]) = ticket.get("chunk_pos").and_then(Tag::as_ints)
            {
                out.insert((x, z));
            }
        }
    }
    if let Ok(chunks) = nbt::read_dat(&dim.data().join("chunks.dat")) {
        let longs = chunks
            .get("data")
            .and_then(|d| d.get("Forced"))
            .and_then(Tag::as_longs)
            .unwrap_or_default();
        for &packed in longs {
            // ChunkPos packs x in the low 32 bits and z in the high ones.
            let bits = packed.cast_unsigned();
            let x = u32::try_from(bits & 0xffff_ffff).unwrap_or(0).cast_signed();
            let z = u32::try_from(bits >> 32).unwrap_or(0).cast_signed();
            out.insert((x, z));
        }
    }
    out
}

fn spawn(data: &Tag) -> Option<Place> {
    if let Some(spawn) = data.get("spawn") {
        let dimension = spawn
            .get("dimension")
            .and_then(Tag::as_str)
            .unwrap_or("minecraft:overworld");
        let &[x, _, z] = spawn.get("pos")?.as_ints()? else {
            return None;
        };
        return Place::from_blocks(dimension, x.into(), z.into());
    }
    Place::from_blocks(
        "minecraft:overworld",
        data.get("SpawnX")?.as_f64()?,
        data.get("SpawnZ")?.as_f64()?,
    )
}

/// The old numeric dimension ids, from before 1.16.
fn dimension_of(tag: Option<&Tag>) -> String {
    match tag {
        Some(Tag::String(s)) => s.clone(),
        Some(n) => match n.as_i32() {
            Some(-1) => "minecraft:the_nether".into(),
            Some(1) => "minecraft:the_end".into(),
            _ => "minecraft:overworld".into(),
        },
        None => "minecraft:overworld".into(),
    }
}

fn player_places(player: &Tag) -> Vec<Place> {
    let mut out = Vec::new();
    if let Some([x, _, z]) = player.get("Pos").and_then(Tag::as_list) {
        let dim = dimension_of(player.get("Dimension"));
        out.extend(
            x.as_f64()
                .zip(z.as_f64())
                .and_then(|(x, z)| Place::from_blocks(&dim, x, z)),
        );
    }
    if let Some(respawn) = player.get("respawn") {
        let dim = dimension_of(respawn.get("dimension"));
        if let Some(&[x, _, z]) = respawn.get("pos").and_then(Tag::as_ints) {
            out.extend(Place::from_blocks(&dim, x.into(), z.into()));
        }
    } else if let (Some(x), Some(z)) = (player.get("SpawnX"), player.get("SpawnZ")) {
        let dim = dimension_of(player.get("SpawnDimension"));
        out.extend(
            x.as_f64()
                .zip(z.as_f64())
                .and_then(|(x, z)| Place::from_blocks(&dim, x, z)),
        );
    }
    out
}

fn dat_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "dat") && p.is_file())
        .collect();
    files.sort();
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn borders_cover_whole_chunks() {
        let b = Border {
            centre_x: 0.0,
            centre_z: 0.0,
            size: 64.0,
        };
        // -32..32 blocks is chunks -2..=1.
        assert!(!b.outside(-2, 0));
        assert!(!b.outside(1, 1));
        assert!(b.outside(2, 0));
        assert!(b.outside(-3, 0));
        assert!(b.outside(0, 2));
        // A chunk the border cuts through stays.
        let b = Border { size: 40.0, ..b };
        assert!(!b.outside(1, 0));
        assert!(!b.outside(-2, 0));
    }

    #[test]
    fn places_round_down_to_chunks() {
        let p = Place::from_blocks("minecraft:overworld", -0.5, 31.9).unwrap();
        assert_eq!((p.x, p.z), (-1, 1));
        assert!(Place::from_blocks("minecraft:overworld", f64::NAN, 0.0).is_none());
        assert!(Place::from_blocks("minecraft:overworld", 1e12, 0.0).is_none());
    }

    #[test]
    fn reads_old_and_new_players() {
        let doubles = |a: f64, b: f64, c: f64| {
            Tag::List(vec![Tag::Double(a), Tag::Double(b), Tag::Double(c)])
        };
        let new = Tag::Compound(vec![
            ("Pos".into(), doubles(100.0, 64.0, -100.0)),
            (
                "Dimension".into(),
                Tag::String("minecraft:the_nether".into()),
            ),
            (
                "respawn".into(),
                Tag::Compound(vec![
                    (
                        "dimension".into(),
                        Tag::String("minecraft:overworld".into()),
                    ),
                    ("pos".into(), Tag::IntArray(vec![-20, 70, 40])),
                ]),
            ),
        ]);
        assert_eq!(
            player_places(&new),
            [
                Place {
                    dimension: "minecraft:the_nether".into(),
                    x: 6,
                    z: -7
                },
                Place {
                    dimension: "minecraft:overworld".into(),
                    x: -2,
                    z: 2
                },
            ]
        );
        let old = Tag::Compound(vec![
            ("Pos".into(), doubles(0.0, 64.0, 0.0)),
            ("Dimension".into(), Tag::Int(1)),
            ("SpawnX".into(), Tag::Int(160)),
            ("SpawnZ".into(), Tag::Int(-1)),
        ]);
        assert_eq!(
            player_places(&old),
            [
                Place {
                    dimension: "minecraft:the_end".into(),
                    x: 0,
                    z: 0
                },
                Place {
                    dimension: "minecraft:overworld".into(),
                    x: 10,
                    z: -1
                },
            ]
        );
    }

    #[test]
    fn reads_old_and_new_spawn() {
        let new = Tag::Compound(vec![(
            "spawn".into(),
            Tag::Compound(vec![
                (
                    "dimension".into(),
                    Tag::String("minecraft:overworld".into()),
                ),
                ("pos".into(), Tag::IntArray(vec![40, 70, -30])),
            ]),
        )]);
        assert_eq!(
            spawn(&new),
            Some(Place {
                dimension: "minecraft:overworld".into(),
                x: 2,
                z: -2
            })
        );
        let old = Tag::Compound(vec![
            ("SpawnX".into(), Tag::Int(-1)),
            ("SpawnZ".into(), Tag::Int(16)),
        ]);
        assert_eq!(
            spawn(&old),
            Some(Place {
                dimension: "minecraft:overworld".into(),
                x: -1,
                z: 1
            })
        );
        assert_eq!(spawn(&Tag::Compound(Vec::new())), None);
    }
}
