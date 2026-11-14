//! World tools for Flytower. For now one: `flytower-world trim`, which removes chunks nobody
//! uses so worlds take less space. Removed chunks are generated again from the seed if
//! anyone goes there.
//!
//! It works on the world's files from outside the server, so it suits vanilla, Fabric and
//! Paper alike. A dry run only reads, and is safe while the server runs. A real trim must
//! only run with the server stopped: the panel stops it, and takes a safety backup first.

pub mod facts;
pub mod rules;
pub mod trim;

use std::fmt::Write as _;

use trim::Report;

/// The output format of `trim` and `dimensions`. Bump it if a field changes meaning.
pub const FORMAT: u32 = 1;

/// Share of fully generated chunks nobody has been near above which a world looks
/// pre-generated (as after a Chunky run), so trimming would undo that work.
pub const PREGENERATED: f64 = 0.5;

/// Whether these reports look like a pre-generated world.
#[must_use]
pub fn pregenerated(reports: &[Report]) -> bool {
    let full: u64 = reports.iter().map(|r| r.full).sum();
    let unvisited: u64 = reports.iter().map(|r| r.unvisited).sum();
    // Whole numbers far below 2^52, so the floats are exact.
    #[expect(
        clippy::cast_precision_loss,
        reason = "chunk counts are far below 2^52"
    )]
    let share = if full == 0 {
        0.0
    } else {
        unvisited as f64 / full as f64
    };
    share > PREGENERATED
}

/// One dimension's report as JSON.
#[must_use]
pub fn report_json(r: &Report) -> String {
    let first_error = r
        .first_error
        .as_deref()
        .map_or_else(|| "null".into(), quote);
    format!(
        "{{\"id\":{},\"regions\":{},\"chunks\":{},\"removed\":{},\"regionsDeleted\":{},\"bytesBefore\":{},\"bytesAfter\":{},\"full\":{},\"unvisited\":{},\"errors\":{},\"firstError\":{first_error}}}",
        quote(&r.id),
        r.regions,
        r.chunks,
        r.removed,
        r.regions_deleted,
        r.bytes_before,
        r.bytes_after,
        r.full,
        r.unvisited,
        r.errors,
    )
}

/// The chunks that go, for the map's preview overlay:
///
/// ```json
/// {"version":1,"dimensions":[{"id":"minecraft:overworld","regions":[[x,z,"<base64>"],…]}]}
/// ```
///
/// Each region's base64 is 128 bytes, one bit per chunk: chunk `x + z * 32` (within the
/// region) is bit `i % 8` of byte `i / 8`. Regions with nothing going are left out.
#[must_use]
pub fn bitmap_json(reports: &[Report]) -> String {
    let mut json = format!("{{\"version\":{FORMAT},\"dimensions\":[");
    for (d, r) in reports.iter().enumerate() {
        let comma = if d == 0 { "" } else { "," };
        let _ = write!(json, "{comma}{{\"id\":{},\"regions\":[", quote(&r.id));
        for (i, ((x, z), mask)) in r.gone.iter().enumerate() {
            let comma = if i == 0 { "" } else { "," };
            let _ = write!(json, "{comma}[{x},{z},\"{}\"]", base64(mask));
        }
        json.push_str("]}");
    }
    json.push_str("]}\n");
    json
}

/// Standard base64, with padding.
#[must_use]
pub fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = u32::from(b[0]) << 16 | u32::from(b[1]) << 8 | u32::from(b[2]);
        for k in 0..4 {
            if k <= chunk.len() {
                out.push(char::from(ABC[(n >> (18 - 6 * k)) as usize & 63]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// A JSON string.
#[must_use]
pub fn quote(s: &str) -> String {
    serde_json::Value::String(s.to_owned()).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_base64() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(&[0xff; 4]), "/////w==");
    }

    #[test]
    fn spots_pregenerated_worlds() {
        let r = |full, unvisited| Report {
            full,
            unvisited,
            ..Report::default()
        };
        assert!(!pregenerated(&[]));
        assert!(!pregenerated(&[r(100, 40), r(10, 10)]));
        assert!(pregenerated(&[r(100, 60)]));
    }
}
