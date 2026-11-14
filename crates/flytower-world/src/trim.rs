//! Trimming one dimension: read every region, decide which chunks go, then rewrite the
//! regions without them.
//!
//! The decision is made from the terrain regions (`region/`). The same chunks then go from
//! `entities/` and `poi/` too, so a chunk that's generated again doesn't get the old mobs or
//! villager jobs back. Oversized chunks' `c.<x>.<z>.mcc` files go with their chunk, and a
//! region left with no chunks is deleted.
//!
//! Each file is replaced atomically, terrain first: if anything stops part-way, every file
//! is whole, and the worst case is an entities region still holding a removed chunk's mobs.
//! A dry run does all the same work in memory and writes nothing.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use flytower_anvil::nbt::{self, Tag};
use flytower_anvil::parallel;
use flytower_anvil::region::{self, Region};
use flytower_anvil::world::Dimension;

use crate::facts::{self, Border, Facts};
use crate::rules::Rules;

/// Chunks in a region.
const CHUNKS: usize = 1024;

/// One bit per chunk of a region (`x + z * 32`, lowest bit first): the chunks that go.
pub type Mask = [u8; CHUNKS / 8];

/// How to run.
#[derive(Debug, Clone, Copy)]
pub struct Options {
    /// Work out what would go and how much it would save, but write nothing.
    pub dry_run: bool,
    pub threads: usize,
}

/// What happened to one dimension, or would.
#[derive(Debug, Default, Clone)]
pub struct Report {
    pub id: String,
    /// Terrain region files.
    pub regions: u32,
    /// Chunks in them.
    pub chunks: u64,
    /// Chunks removed (or that would be).
    pub removed: u64,
    /// Terrain region files deleted because no chunks were left.
    pub regions_deleted: u32,
    /// Region and `.mcc` files in `region/`, `entities/` and `poi/`, before and after.
    pub bytes_before: u64,
    pub bytes_after: u64,
    /// Fully generated chunks, and how many of those nobody has ever been near.
    pub full: u64,
    pub unvisited: u64,
    /// Files or chunks we couldn't read or write. Unreadable chunks are always kept.
    pub errors: u64,
    pub first_error: Option<String>,
    /// The chunks that go, per region.
    pub gone: BTreeMap<(i32, i32), Mask>,
}

impl Report {
    fn note(&mut self, why: String) {
        self.errors += 1;
        self.first_error.get_or_insert(why);
    }
}

/// What a scan learns about one chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chunk {
    /// Ticks players have spent near it.
    pub inhabited: i64,
    /// Fully generated (`Status` is `minecraft:full`, or missing, as in very old worlds).
    pub full: bool,
    /// Whether we could read it at all. Unreadable chunks are kept.
    pub readable: bool,
}

/// Reads what the rules need from a chunk's NBT.
#[must_use]
pub fn read_chunk(bytes: &[u8]) -> Chunk {
    let unreadable = Chunk {
        inhabited: i64::MAX,
        full: true,
        readable: false,
    };
    let Ok(fields) = nbt::fields(bytes, &["InhabitedTime", "Status", "Level"]) else {
        return unreadable;
    };
    let get = |key: &str| {
        fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
            .or_else(|| {
                // Before 1.18 everything was inside `Level`.
                fields
                    .iter()
                    .find(|(k, _)| k == "Level")
                    .and_then(|(_, level)| level.get(key))
            })
    };
    let full = get("Status")
        .and_then(Tag::as_str)
        .is_none_or(|s| matches!(s, "minecraft:full" | "full" | "postprocessed"));
    // A chunk with no InhabitedTime can't show it's unused, so it's kept.
    let inhabited = get("InhabitedTime")
        .and_then(Tag::as_i64)
        .unwrap_or(i64::MAX);
    Chunk {
        inhabited,
        full,
        readable: true,
    }
}

struct Scanned {
    xz: (i32, i32),
    path: PathBuf,
    chunks: Vec<(usize, Chunk)>,
    /// An entry we couldn't make sense of: the region is left exactly as it is.
    broken: bool,
    errors: Vec<String>,
}

fn scan(x: i32, z: i32, path: &Path) -> Scanned {
    let mut out = Scanned {
        xz: (x, z),
        path: path.to_path_buf(),
        chunks: Vec::new(),
        broken: false,
        errors: Vec::new(),
    };
    let region = match Region::open(path, x, z) {
        Ok(r) => r,
        Err(e) => {
            out.broken = true;
            out.errors.push(format!("{}: {e}", path.display()));
            return out;
        }
    };
    for i in 0..CHUNKS {
        if region.entry(i).is_none() {
            continue;
        }
        if let Err(e) = region.sectors(i) {
            out.broken = true;
            out.errors
                .push(format!("{} chunk {i}: {e}", path.display()));
            continue;
        }
        let chunk = match region.chunk(i) {
            Ok(Some(bytes)) => read_chunk(&bytes),
            Ok(None) => continue,
            Err(e) => {
                out.errors
                    .push(format!("{} chunk {i}: {e}", path.display()));
                read_chunk(&[])
            }
        };
        if !chunk.readable && region.chunk(i).is_ok() {
            out.errors
                .push(format!("{} chunk {i}: bad NBT", path.display()));
        }
        out.chunks.push((i, chunk));
    }
    out
}

/// Everything about the world the decision needs, for one dimension.
pub struct World<'a> {
    pub id: &'a str,
    pub rules: &'a Rules,
    pub facts: &'a Facts,
    pub forced: &'a HashSet<(i32, i32)>,
    pub border: Option<Border>,
}

/// Decides which chunks go. `chunks` maps every chunk in the dimension to what a scan found
/// and whether it must be kept whatever the rules say (it's in a region we can't rewrite).
#[must_use]
pub fn decide<S: std::hash::BuildHasher>(
    world: &World<'_>,
    chunks: &HashMap<(i32, i32), (Chunk, bool), S>,
) -> HashSet<(i32, i32)> {
    let rules = world.rules;
    let hard = |(x, z): (i32, i32), stuck: bool| {
        stuck
            || world.forced.contains(&(x, z))
            || rules.protect.iter().any(|a| a.contains(world.id, x, z))
    };
    // Removed whatever's near them: outside the border, or never finished.
    let doomed = |xz: (i32, i32), chunk: &Chunk| {
        (rules.border && world.border.is_some_and(|b| b.outside(xz.0, xz.1)))
            || (rules.unfinished && chunk.readable && !chunk.full)
    };
    let mut keep: HashSet<(i32, i32)> = HashSet::new();
    let mut open: HashSet<(i32, i32)> = HashSet::new();
    let threshold = rules.inhabited_ticks.max(1);
    for (&xz, &(chunk, stuck)) in chunks {
        if hard(xz, stuck) {
            keep.insert(xz);
        } else if !doomed(xz, &chunk) {
            open.insert(xz);
            if chunk.inhabited >= threshold || !chunk.readable {
                keep.insert(xz);
            }
        }
    }
    let mut centres: Vec<((i32, i32), i32)> = Vec::new();
    if let Some(spawn) = world
        .facts
        .spawn
        .as_ref()
        .filter(|s| s.dimension == world.id)
    {
        centres.push(((spawn.x, spawn.z), rules.spawn_radius));
    }
    for p in world
        .facts
        .players
        .iter()
        .filter(|p| p.dimension == world.id)
    {
        centres.push(((p.x, p.z), rules.player_radius));
    }
    if world.id == "minecraft:the_end" {
        centres.push(((0, 0), rules.end_radius));
    }
    let around = |keep: &mut HashSet<(i32, i32)>, (cx, cz): (i32, i32), r: i32| {
        for x in cx.saturating_sub(r)..=cx.saturating_add(r) {
            for z in cz.saturating_sub(r)..=cz.saturating_add(r) {
                if open.contains(&(x, z)) {
                    keep.insert((x, z));
                }
            }
        }
    };
    for (centre, r) in centres {
        around(&mut keep, centre, r);
    }
    if rules.buffer > 0 {
        let base: Vec<(i32, i32)> = keep.iter().copied().collect();
        for xz in base {
            around(&mut keep, xz, rules.buffer);
        }
    }
    chunks
        .keys()
        .filter(|xz| !keep.contains(xz))
        .copied()
        .collect()
}

/// Region files in a folder, by their coordinates.
fn regions_in(dir: &Path) -> BTreeMap<(i32, i32), PathBuf> {
    let mut out = BTreeMap::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Some(xz) = entry.file_name().to_str().and_then(region::coords) {
                out.insert(xz, entry.path());
            }
        }
    }
    out
}

/// The bytes of every region and `.mcc` file in a folder.
fn folder_bytes(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| region::coords(n).is_some() || is_mcc(n))
        })
        .filter_map(|e| e.metadata().ok())
        .filter(std::fs::Metadata::is_file)
        .map(|m| m.len())
        .sum()
}

fn is_mcc(name: &str) -> bool {
    name.strip_prefix("c.")
        .and_then(|r| r.strip_suffix(".mcc"))
        .and_then(|r| r.split_once('.'))
        .is_some_and(|(x, z)| x.parse::<i32>().is_ok() && z.parse::<i32>().is_ok())
}

/// Deletes files a trim stopped part-way left behind.
fn clean_temp(dir: &Path) -> io::Result<()> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        if entry.file_name().to_str().is_some_and(region::is_temp) {
            region::remove(&entry.path())?;
        }
    }
    Ok(())
}

/// What rewriting one file saved.
#[derive(Default)]
struct Shrunk {
    saved: u64,
    deleted: bool,
}

/// Rewrites one region file without the chunks in `gone`, or works out what that would save.
fn shrink(path: &Path, xz: (i32, i32), gone: &Mask, dry_run: bool) -> Result<Shrunk, String> {
    let at = |e: &dyn std::fmt::Display| format!("{}: {e}", path.display());
    if !path.is_file() {
        return Ok(Shrunk::default());
    }
    let region = Region::open(path, xz.0, xz.1).map_err(|e| at(&e))?;
    let goes = |i: usize| gone[i / 8] & (1 << (i % 8)) != 0;
    let new = region.compact(|i| !goes(i)).map_err(|e| at(&e))?;
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let mcc: Vec<PathBuf> = (0..CHUNKS)
        .filter(|&i| goes(i) && region.external(i))
        .map(|i| {
            let (cx, cz) = region::chunk_xz(xz.0, xz.1, i);
            dir.join(region::mcc_name(cx, cz))
        })
        .collect();
    let old = u64::try_from(region.len()).unwrap_or(u64::MAX);
    let mut shrunk = Shrunk::default();
    match &new {
        None => {
            shrunk.saved = old;
            shrunk.deleted = true;
        }
        Some(bytes) => {
            shrunk.saved = old.saturating_sub(u64::try_from(bytes.len()).unwrap_or(0));
        }
    }
    shrunk.saved += mcc
        .iter()
        .filter_map(|p| fs::metadata(p).ok())
        .map(|m| m.len())
        .sum::<u64>();
    if dry_run {
        return Ok(shrunk);
    }
    // The region first, so it never points at a `.mcc` that's gone.
    match new {
        None => region::remove(path).map_err(|e| at(&e))?,
        Some(bytes) => region::replace(path, &bytes).map_err(|e| at(&e))?,
    }
    for p in mcc {
        region::remove(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    Ok(shrunk)
}

/// Trims one dimension, calling `region_done` as each region is scanned and again as it's
/// rewritten (or skipped). Called from the worker threads.
///
/// # Errors
///
/// When a folder can't be listed or a stale temporary file can't be cleared. Problems with
/// single files are counted in the report instead, and those files are left as they were.
pub fn trim(
    dim: &Dimension,
    rules: &Rules,
    facts: &Facts,
    opts: Options,
    region_done: &(dyn Fn() + Sync),
) -> io::Result<Report> {
    let mut report = Report {
        id: dim.id.clone(),
        ..Report::default()
    };
    let folders = [dim.regions.clone(), dim.entities(), dim.poi()];
    if !opts.dry_run {
        for dir in &folders {
            clean_temp(dir)?;
        }
    }
    fs::read_dir(&dim.regions)?;
    report.bytes_before = folders.iter().map(|d| folder_bytes(d)).sum();

    let found: Vec<((i32, i32), PathBuf)> = regions_in(&dim.regions).into_iter().collect();
    report.regions = u32::try_from(found.len()).unwrap_or(u32::MAX);
    let scans = parallel(&found, opts.threads, |((x, z), path)| {
        let s = scan(*x, *z, path);
        region_done();
        s
    });

    let mut chunks = HashMap::new();
    for s in &scans {
        for why in &s.errors {
            report.note(why.clone());
        }
        for &(i, chunk) in &s.chunks {
            chunks.insert(region::chunk_xz(s.xz.0, s.xz.1, i), (chunk, s.broken));
            report.chunks += 1;
            if chunk.readable && chunk.full {
                report.full += 1;
                report.unvisited += u64::from(chunk.inhabited == 0);
            }
        }
    }
    let forced = facts::forced(dim);
    let world = World {
        id: &dim.id,
        rules,
        facts,
        forced: &forced,
        border: facts.border(dim),
    };
    for (x, z) in decide(&world, &chunks) {
        let mask = report
            .gone
            .entry((x >> 5, z >> 5))
            .or_insert([0; CHUNKS / 8]);
        let i = usize::try_from((x & 31) + (z & 31) * 32).unwrap_or(0);
        mask[i / 8] |= 1 << (i % 8);
        report.removed += 1;
    }

    let todo: Vec<(&Scanned, Option<Mask>)> = scans
        .iter()
        .map(|s| (s, report.gone.get(&s.xz).copied()))
        .collect();
    let results = parallel(&todo, opts.threads, |(s, gone)| {
        let Some(gone) = gone else {
            region_done();
            return (Ok(Shrunk::default()), Vec::new());
        };
        // Terrain first, and the rest only if that worked.
        let terrain = shrink(&s.path, s.xz, gone, opts.dry_run);
        let mut out = Vec::new();
        if terrain.is_ok() {
            let name = format!("r.{}.{}.mca", s.xz.0, s.xz.1);
            for dir in [dim.entities(), dim.poi()] {
                out.push(shrink(&dir.join(&name), s.xz, gone, opts.dry_run));
            }
        }
        region_done();
        (terrain, out)
    });
    let mut saved = 0;
    for ((terrain, rest), (s, _)) in results.into_iter().zip(&todo) {
        match terrain {
            Ok(shrunk) => {
                saved += shrunk.saved;
                report.regions_deleted += u32::from(shrunk.deleted);
            }
            Err(why) => {
                // Nothing in this region changed, so none of its chunks went.
                if let Some(mask) = report.gone.remove(&s.xz) {
                    report.removed -= mask.iter().map(|b| u64::from(b.count_ones())).sum::<u64>();
                }
                report.note(why);
            }
        }
        for r in rest {
            match r {
                Ok(shrunk) => saved += shrunk.saved,
                Err(why) => report.note(why),
            }
        }
    }
    report.bytes_after = if opts.dry_run {
        report.bytes_before.saturating_sub(saved)
    } else {
        folders.iter().map(|d| folder_bytes(d)).sum()
    };
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_mcc_names() {
        assert!(is_mcc("c.-1.20.mcc"));
        assert!(!is_mcc("c.1.mcc"));
        assert!(!is_mcc("r.0.0.mca"));
    }
}
