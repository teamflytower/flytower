//! Finding a world's dimensions and their region folders.
//!
//! Worlds have been laid out three ways, and we read them all:
//!
//! - Older vanilla and Fabric: `region/` for the Overworld, `DIM-1/region/` for the Nether,
//!   `DIM1/region/` for the End, and `dimensions/<namespace>/<name>/region/` for the rest.
//! - Newer versions keep every dimension under `dimensions/<namespace>/<name>/`.
//! - Paper and Spigot keep the Nether and End in sibling worlds: `world_nether/DIM-1/` and
//!   `world_the_end/DIM1/`.

use std::fs;
use std::path::{Path, PathBuf};

/// One dimension with region files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dimension {
    /// Its id, like `minecraft:overworld`.
    pub id: String,
    pub namespace: String,
    pub name: String,
    /// The folder holding its `r.<x>.<z>.mca` files.
    pub regions: PathBuf,
}

impl Dimension {
    /// The dimension's own folder: the one holding `region/`, `entities/`, `poi/` and
    /// `data/`.
    #[must_use]
    pub fn folder(&self) -> &Path {
        self.regions.parent().unwrap_or(&self.regions)
    }

    /// Where its mobs and items are kept, in region files of their own.
    #[must_use]
    pub fn entities(&self) -> PathBuf {
        self.folder().join("entities")
    }

    /// Where its points of interest (beds, job sites, portals) are kept.
    #[must_use]
    pub fn poi(&self) -> PathBuf {
        self.folder().join("poi")
    }

    /// Its saved data, such as the world border and forced chunks.
    #[must_use]
    pub fn data(&self) -> PathBuf {
        self.folder().join("data")
    }
}

/// The dimensions in a world folder that have region files, Overworld, Nether and End first.
#[must_use]
pub fn dimensions(world: &Path) -> Vec<Dimension> {
    let sibling = |suffix: &str| {
        let name = world.file_name()?.to_str()?;
        Some(world.with_file_name(format!("{name}{suffix}")))
    };
    let modern = |name: &str| world.join("dimensions/minecraft").join(name).join("region");
    let known: [(&str, Vec<Option<PathBuf>>); 3] = [
        (
            "overworld",
            vec![Some(modern("overworld")), Some(world.join("region"))],
        ),
        (
            "the_nether",
            vec![
                Some(modern("the_nether")),
                Some(world.join("DIM-1/region")),
                sibling("_nether").map(|w| w.join("DIM-1/region")),
            ],
        ),
        (
            "the_end",
            vec![
                Some(modern("the_end")),
                Some(world.join("DIM1/region")),
                sibling("_the_end").map(|w| w.join("DIM1/region")),
            ],
        ),
    ];
    let mut out = Vec::new();
    for (name, places) in known {
        if let Some(regions) = places.into_iter().flatten().find(|p| p.is_dir()) {
            out.push(Dimension {
                id: format!("minecraft:{name}"),
                namespace: "minecraft".into(),
                name: name.into(),
                regions,
            });
        }
    }
    let mut custom = Vec::new();
    for ns in sorted_dirs(&world.join("dimensions")) {
        for name in sorted_dirs(&world.join("dimensions").join(&ns)) {
            let regions = world
                .join("dimensions")
                .join(&ns)
                .join(&name)
                .join("region");
            let id = format!("{ns}:{name}");
            if regions.is_dir() && !out.iter().any(|d| d.id == id) {
                custom.push(Dimension {
                    id,
                    namespace: ns.clone(),
                    name,
                    regions,
                });
            }
        }
    }
    out.extend(custom);
    out
}

/// Sub-folders whose names are safe to reuse as path parts and in URLs.
fn sorted_dirs(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| safe(n))
        .collect();
    names.sort();
    names
}

/// Resource location characters, minus the slash, and never `.` or `..`.
fn safe(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-' | b'.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "flytower-anvil-world-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ids(dims: &[Dimension]) -> Vec<&str> {
        dims.iter().map(|d| d.id.as_str()).collect()
    }

    #[test]
    fn finds_the_older_layout() {
        let root = scratch("old");
        let world = root.join("world");
        for dir in [
            "region",
            "DIM-1/region",
            "DIM1/region",
            "dimensions/mod/sky/region",
            "dimensions/Bad/x/region",
        ] {
            fs::create_dir_all(world.join(dir)).unwrap();
        }
        let dims = dimensions(&world);
        assert_eq!(
            ids(&dims),
            [
                "minecraft:overworld",
                "minecraft:the_nether",
                "minecraft:the_end",
                "mod:sky"
            ]
        );
        assert_eq!(dims[1].regions, world.join("DIM-1/region"));
        assert_eq!(dims[1].entities(), world.join("DIM-1/entities"));
        assert_eq!(dims[0].poi(), world.join("poi"));
        assert_eq!(dims[3].data(), world.join("dimensions/mod/sky/data"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finds_the_newer_layout_and_paper_siblings() {
        let root = scratch("new");
        let world = root.join("world");
        fs::create_dir_all(world.join("dimensions/minecraft/overworld/region")).unwrap();
        fs::create_dir_all(root.join("world_nether/DIM-1/region")).unwrap();
        let dims = dimensions(&world);
        assert_eq!(ids(&dims), ["minecraft:overworld", "minecraft:the_nether"]);
        assert_eq!(
            dims[0].regions,
            world.join("dimensions/minecraft/overworld/region")
        );
        assert_eq!(dims[1].regions, root.join("world_nether/DIM-1/region"));
        assert_eq!(dims[1].entities(), root.join("world_nether/DIM-1/entities"));
        fs::remove_dir_all(root).unwrap();
    }
}
