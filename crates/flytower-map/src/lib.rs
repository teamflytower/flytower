//! A web map for Flytower: reads a Minecraft world's region files and draws them as tiles,
//! looking straight down, for the panel's own map viewer.
//!
//! It runs outside the Minecraft server, so it works for vanilla, Fabric and Paper alike and
//! needs nothing installed in the game. A pass only redraws regions whose chunks were saved
//! since the last one.
//!
//! Output, under the folder you give it:
//!
//! - `tiles/<namespace>/<name>/<level>/<x>_<z>.png`: 512×512 tiles. Level 0 is one per
//!   region (one pixel per block); each level up halves the detail.
//! - `maps.json`: the dimensions that have tiles, where they are and how far they reach.
//! - `state/`: what was drawn, so the next pass knows what changed.
//!
//! `flytower-map palette` makes the colour palette from the Minecraft client jar.

pub mod chunk;
pub mod colours;
pub mod draw;
pub mod jar;
pub mod palette;
pub mod render;
pub mod tiles;
pub mod world;

// Shared with `flytower-world`; re-exported so paths like `flytower_map::region` still work.
pub use flytower_anvil::{nbt, region};

use std::fmt::Write as _;
use std::path::Path;

use world::{Dimension, MapDimension};

/// The `maps.json` format. Bump it if a field changes meaning.
pub const MANIFEST: u32 = 1;

/// Describes the dimensions that have tiles, for the viewer. Bounds are in regions:
/// `[min x, min z, max x, max z]` of the full-detail tiles.
#[must_use]
pub fn manifest(out: &Path, dims: &[Dimension], levels: u8) -> String {
    let mut json = format!(
        "{{\"version\":{MANIFEST},\"tileSize\":{},\"levels\":{levels},\"dimensions\":[",
        draw::SIZE
    );
    let mut first = true;
    for dim in dims {
        let tiles = render::level_tiles(&out.join(dim.tiles()), 0);
        if tiles.is_empty() {
            continue;
        }
        let (mut lo, mut hi) = ((i32::MAX, i32::MAX), (i32::MIN, i32::MIN));
        for (x, z) in tiles {
            lo = (lo.0.min(x), lo.1.min(z));
            hi = (hi.0.max(x), hi.1.max(z));
        }
        let comma = if first { "" } else { "," };
        first = false;
        let _ = write!(
            json,
            "{comma}{{\"id\":{},\"tiles\":{},\"bounds\":[{},{},{},{}]}}",
            quote(&dim.id),
            quote(&dim.tiles().to_string_lossy().replace('\\', "/")),
            lo.0,
            lo.1,
            hi.0,
            hi.1
        );
    }
    json.push_str("]}\n");
    json
}

/// A JSON string.
#[must_use]
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if u32::from(c) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::quote;

    #[test]
    fn quotes_json_strings() {
        assert_eq!(quote("a\"b\\c\nd"), "\"a\\\"b\\\\c\\u000ad\"");
    }
}
