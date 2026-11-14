//! A drawing pass over one dimension: redraw the regions that changed, rebuild the zoomed
//! out tiles above them, and remember what was drawn.
//!
//! A region is redrawn when its header tables change (they hold every chunk's save time),
//! when the palette or renderer changes, or when asked for a full pass. Tiles for regions
//! that are gone are removed. The state file is written last, so a pass that's stopped
//! part way just repeats the unfinished work next time.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

use crate::draw;
use crate::palette::{Palette, fnv};
use crate::region::{self, Region};
use crate::tiles;
use crate::world::{Dimension, MapDimension};

/// Bump when drawing changes, so every map is redrawn once.
pub const RENDERER: u32 = 2;

/// How to run a pass.
#[derive(Debug, Clone, Copy)]
pub struct Options {
    /// Regions drawn at once. Each takes about 10 MB while it's drawn.
    pub threads: usize,
    /// Redraw everything, not just what changed.
    pub full: bool,
    /// Zoomed-out levels above the full-detail one.
    pub levels: u8,
    /// Report how far the pass has got on standard error, as `progress DONE TOTAL` lines
    /// counted in region files.
    pub progress: bool,
}

impl Default for Options {
    fn default() -> Self {
        let cpus = thread::available_parallelism().map_or(1, std::num::NonZero::get);
        // Leave most of the machine to the Minecraft servers.
        Self {
            threads: cpus.div_ceil(2).clamp(1, 4),
            full: false,
            levels: 4,
            progress: false,
        }
    }
}

/// What a pass did to one dimension.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub id: String,
    /// Region files found.
    pub regions: u32,
    /// Regions drawn this time.
    pub drawn: u32,
    /// Regions that hadn't changed.
    pub unchanged: u32,
    /// Tiles removed because their region is gone or now empty.
    pub removed: u32,
    /// Chunks drawn.
    pub chunks: u64,
    /// Chunks or regions that couldn't be read, and the first reason why.
    pub errors: u64,
    pub first_error: Option<String>,
}

/// Runs a pass over one dimension, writing under `out`.
///
/// # Errors
///
/// When the region folder can't be listed or the state can't be saved. Problems with single
/// regions or chunks are counted in the report instead.
pub fn render(dim: &Dimension, out: &Path, palette: &Palette, opts: Options) -> io::Result<Report> {
    render_with(dim, out, palette, opts, &|| {})
}

/// [`render`], calling `region_done` once for every region file as it's finished with:
/// skipped as unchanged, drawn, or given up on. Called from the drawing threads.
///
/// # Errors
///
/// As [`render`].
pub fn render_with(
    dim: &Dimension,
    out: &Path,
    palette: &Palette,
    opts: Options,
    region_done: &(dyn Fn() + Sync),
) -> io::Result<Report> {
    let mut report = Report {
        id: dim.id.clone(),
        ..Report::default()
    };
    let tile_dir = out.join(dim.tiles());
    let state_path = out
        .join("state")
        .join(&dim.namespace)
        .join(format!("{}.txt", dim.name));
    let stamp = format!("flytower-map {RENDERER} {:016x}", palette.hash);
    let old = if opts.full {
        BTreeMap::new()
    } else {
        load_state(&state_path, &stamp)
    };

    let mut found = BTreeMap::new();
    for entry in fs::read_dir(&dim.regions)?.flatten() {
        let name = entry.file_name();
        if let Some(xz) = name.to_str().and_then(region::coords) {
            found.insert(xz, entry.path());
        }
    }
    report.regions = count(found.len());

    let mut state = BTreeMap::new();
    let mut todo = Vec::new();
    for (&(x, z), path) in &found {
        let hash = match region::header(path) {
            Ok(h) => fnv(&h),
            Err(e) => {
                note(&mut report, format!("{}: {e}", path.display()));
                region_done();
                continue;
            }
        };
        // A region with no chunks has no tile, so an unchanged empty one doesn't need one.
        if let Some(&(was, empty)) = old.get(&(x, z))
            && was == hash
            && (empty || tiles::path(&tile_dir, 0, x, z).is_file())
        {
            report.unchanged += 1;
            state.insert((x, z), (hash, empty));
            region_done();
        } else {
            todo.push((x, z, hash, path.clone()));
        }
    }

    let mut dirty = BTreeSet::new();
    // Tiles whose region file is gone, including ones a lost state file forgot.
    for (x, z) in level_tiles(&tile_dir, 0) {
        if !found.contains_key(&(x, z)) {
            tiles::remove(&tiles::path(&tile_dir, 0, x, z))?;
            report.removed += 1;
            dirty.insert((x, z));
        }
    }

    let results = parallel(&todo, opts.threads, |(x, z, _, path)| {
        let drawn = draw_one(path, *x, *z, &tile_dir, palette, dim);
        region_done();
        drawn
    });
    for ((x, z, hash, _), result) in todo.iter().zip(results) {
        dirty.insert((*x, *z));
        match result {
            Ok(drawn) => {
                report.drawn += 1;
                report.chunks += u64::from(drawn.chunks);
                report.errors += u64::from(drawn.errors);
                if let Some(why) = drawn.first_error {
                    report.first_error.get_or_insert(why);
                }
                if drawn.chunks == 0 {
                    report.removed += u32::from(drawn.had_tile);
                }
                state.insert((*x, *z), (*hash, drawn.chunks == 0));
            }
            Err(e) => note(&mut report, e.to_string()),
        }
    }

    for level in 1..=opts.levels {
        let parents: Vec<(i32, i32)> = dirty
            .iter()
            .map(|&(x, z)| (x >> 1, z >> 1))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let results = parallel(&parents, opts.threads, |&(x, z)| {
            zoom_one(&tile_dir, level, x, z)
        });
        for r in results {
            if let Err(e) = r {
                note(&mut report, e.to_string());
            }
        }
        dirty = parents.into_iter().collect();
    }

    save_state(&state_path, &stamp, &state)?;
    Ok(report)
}

struct DrawnTile {
    chunks: u32,
    errors: u32,
    first_error: Option<String>,
    had_tile: bool,
}

fn draw_one(
    path: &Path,
    x: i32,
    z: i32,
    tile_dir: &Path,
    palette: &Palette,
    dim: &Dimension,
) -> io::Result<DrawnTile> {
    let region = Region::open(path, x, z)?;
    let drawn = draw::region(&region, palette, dim.style());
    drop(region);
    let tile = tiles::path(tile_dir, 0, x, z);
    let had_tile = tile.is_file();
    if drawn.chunks == 0 {
        tiles::remove(&tile)?;
    } else {
        tiles::write(&tile, &drawn.pixels)?;
    }
    Ok(DrawnTile {
        chunks: drawn.chunks,
        errors: drawn.errors,
        first_error: drawn.first_error,
        had_tile,
    })
}

fn zoom_one(tile_dir: &Path, level: u8, x: i32, z: i32) -> io::Result<()> {
    let below = level - 1;
    let quads = [(0, 0), (1, 0), (0, 1), (1, 1)]
        .map(|(dx, dz)| tiles::read(&tiles::path(tile_dir, below, x * 2 + dx, z * 2 + dz)));
    let target = tiles::path(tile_dir, level, x, z);
    match tiles::shrink(quads.each_ref().map(Option::as_deref)) {
        Some(rgba) => tiles::write(&target, &rgba),
        None => tiles::remove(&target),
    }
}

fn note(report: &mut Report, why: String) {
    report.errors += 1;
    report.first_error.get_or_insert(why);
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// The tiles at one level, from their file names.
#[must_use]
pub fn level_tiles(tile_dir: &Path, level: u8) -> Vec<(i32, i32)> {
    let Ok(entries) = fs::read_dir(tile_dir.join(level.to_string())) else {
        return Vec::new();
    };
    let mut out: Vec<(i32, i32)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let (x, z) = name.strip_suffix(".png")?.split_once('_')?;
            Some((x.parse().ok()?, z.parse().ok()?))
        })
        .collect();
    out.sort_unstable();
    out
}

/// Runs `f` over `items` on up to `threads` threads, keeping the results in order.
fn parallel<T: Sync, R: Send>(items: &[T], threads: usize, f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<R>>> = Mutex::new((0..items.len()).map(|_| None).collect());
    thread::scope(|s| {
        for _ in 0..threads.clamp(1, items.len().max(1)) {
            s.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(item) = items.get(i) else { break };
                    let r = f(item);
                    results
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)[i] = Some(r);
                }
            });
        }
    });
    results
        .into_inner()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .into_iter()
        .flatten()
        .collect()
}

// The state file: a stamp line, then `x z hash` per drawn region and `x z hash empty` for
// regions drawn with no chunks in them.

fn load_state(path: &Path, stamp: &str) -> BTreeMap<(i32, i32), (u64, bool)> {
    let Ok(text) = fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    let mut lines = text.lines();
    if lines.next() != Some(stamp) {
        return BTreeMap::new();
    }
    lines
        .filter_map(|line| {
            let mut words = line.split(' ');
            let x = words.next()?.parse().ok()?;
            let z = words.next()?.parse().ok()?;
            let hash = u64::from_str_radix(words.next()?, 16).ok()?;
            Some(((x, z), (hash, words.next() == Some("empty"))))
        })
        .collect()
}

fn save_state(
    path: &Path,
    stamp: &str,
    state: &BTreeMap<(i32, i32), (u64, bool)>,
) -> io::Result<()> {
    let mut text = format!("{stamp}\n");
    for (&(x, z), &(hash, empty)) in state {
        let tag = if empty { " empty" } else { "" };
        let _ = writeln!(text, "{x} {z} {hash:016x}{tag}");
    }
    write_atomic(path, text.as_bytes())
}

/// Writes a file in one step: to a temporary name, then renamed over the old one.
///
/// # Errors
///
/// When the folder or file can't be written.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut tmp = PathBuf::from(path);
    tmp.as_mut_os_string().push(".tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}
