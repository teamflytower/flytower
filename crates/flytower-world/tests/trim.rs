//! Trimming worlds built by hand: every rule, and what happens to the files.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use flate2::Compression;
use flate2::write::{GzEncoder, ZlibEncoder};
use flytower_anvil::region::{self, HEADER, Region, SECTOR};
use flytower_anvil::world;
use flytower_world::facts::{Border, Facts, Place};
use flytower_world::rules::{Area, Rules};
use flytower_world::trim::{self, Chunk, Options, World, decide};

/// A fresh, empty folder for one test.
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("flytower-world-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

// --- Writing NBT ---

fn name(out: &mut Vec<u8>, s: &str) {
    out.extend(u16::try_from(s.len()).unwrap().to_be_bytes());
    out.extend(s.as_bytes());
}

fn string(out: &mut Vec<u8>, key: &str, value: &str) {
    out.push(8);
    name(out, key);
    name(out, value);
}

fn long(out: &mut Vec<u8>, key: &str, value: i64) {
    out.push(4);
    name(out, key);
    out.extend(value.to_be_bytes());
}

fn double(out: &mut Vec<u8>, key: &str, value: f64) {
    out.push(6);
    name(out, key);
    out.extend(value.to_be_bytes());
}

fn ints(out: &mut Vec<u8>, key: &str, values: &[i32]) {
    out.push(11);
    name(out, key);
    out.extend(i32::try_from(values.len()).unwrap().to_be_bytes());
    for v in values {
        out.extend(v.to_be_bytes());
    }
}

fn compound(out: &mut Vec<u8>, key: &str, body: &[u8]) {
    out.push(10);
    name(out, key);
    out.extend(body);
    out.push(0);
}

fn root(body: &[u8]) -> Vec<u8> {
    let mut out = vec![10, 0, 0];
    out.extend(body);
    out.push(0);
    out
}

/// A chunk's NBT, with some padding so chunks differ in size.
fn chunk_nbt(status: &str, inhabited: i64, pad: usize) -> Vec<u8> {
    let mut b = Vec::new();
    string(&mut b, "Status", status);
    long(&mut b, "InhabitedTime", inhabited);
    string(&mut b, "padding", &"x".repeat(pad));
    root(&b)
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut e = GzEncoder::new(Vec::new(), Compression::default());
    e.write_all(bytes).unwrap();
    e.finish().unwrap()
}

fn zlib(bytes: &[u8]) -> Vec<u8> {
    let mut e = ZlibEncoder::new(Vec::new(), Compression::default());
    e.write_all(bytes).unwrap();
    e.finish().unwrap()
}

// --- Writing regions ---

/// One chunk in a region we build: where it goes, its NBT, and whether its data lives in a
/// `.mcc` file.
struct Put {
    i: usize,
    nbt: Vec<u8>,
    external: bool,
}

const fn put(i: usize, nbt: Vec<u8>) -> Put {
    Put {
        i,
        nbt,
        external: false,
    }
}

/// Writes `r.<rx>.<rz>.mca` (and any `.mcc` files) into `dir`. Save times are `1000 + i`.
fn write_region(dir: &Path, rx: i32, rz: i32, chunks: &[Put]) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    let mut data = vec![0; HEADER];
    for c in chunks {
        let packed = zlib(&c.nbt);
        let mut body = Vec::new();
        if c.external {
            body.extend(1u32.to_be_bytes());
            body.push(0x82);
            let (cx, cz) = region::chunk_xz(rx, rz, c.i);
            fs::write(dir.join(region::mcc_name(cx, cz)), &packed).unwrap();
        } else {
            body.extend(u32::try_from(packed.len() + 1).unwrap().to_be_bytes());
            body.push(2);
            body.extend(&packed);
        }
        body.resize(body.len().div_ceil(SECTOR) * SECTOR, 0);
        let at = data.len() / SECTOR;
        let i = c.i;
        data[i * 4..i * 4 + 3].copy_from_slice(&u32::try_from(at).unwrap().to_be_bytes()[1..]);
        data[i * 4 + 3] = u8::try_from(body.len() / SECTOR).unwrap();
        data[SECTOR + i * 4..SECTOR + i * 4 + 4]
            .copy_from_slice(&(1000 + u32::try_from(i).unwrap()).to_be_bytes());
        data.extend(body);
    }
    let path = dir.join(format!("r.{rx}.{rz}.mca"));
    fs::write(&path, data).unwrap();
    path
}

fn chunks_in(path: &Path) -> Vec<usize> {
    let region = Region::open(path, 0, 0).unwrap();
    (0..1024).filter(|&i| region.entry(i).is_some()).collect()
}

/// A new-layout world (26.1 and later) with spawn at block 0, 0.
fn new_world(root_dir: &Path) -> PathBuf {
    let world = root_dir.join("world");
    let mut spawn = Vec::new();
    string(&mut spawn, "dimension", "minecraft:overworld");
    ints(&mut spawn, "pos", &[0, 64, 0]);
    let mut data = Vec::new();
    compound(&mut data, "spawn", &spawn);
    let mut level = Vec::new();
    compound(&mut level, "Data", &data);
    fs::create_dir_all(&world).unwrap();
    fs::write(world.join("level.dat"), gzip(&root(&level))).unwrap();
    world
}

fn overworld(world: &Path) -> PathBuf {
    world.join("dimensions/minecraft/overworld")
}

// --- The rules ---

const OW: &str = "minecraft:overworld";

const fn info(inhabited: i64) -> (Chunk, bool) {
    (
        Chunk {
            inhabited,
            full: true,
            readable: true,
        },
        false,
    )
}

/// Every chunk from `-n..=n` on both axes, unused.
fn field(n: i32) -> HashMap<(i32, i32), (Chunk, bool)> {
    let mut out = HashMap::new();
    for x in -n..=n {
        for z in -n..=n {
            out.insert((x, z), info(0));
        }
    }
    out
}

fn no_rules() -> Rules {
    Rules {
        spawn_radius: 0,
        player_radius: 0,
        buffer: 0,
        end_radius: 0,
        ..Rules::default()
    }
}

fn kept(
    id: &str,
    rules: &Rules,
    facts: &Facts,
    chunks: &HashMap<(i32, i32), (Chunk, bool)>,
) -> HashSet<(i32, i32)> {
    kept_with(id, rules, facts, &HashSet::new(), None, chunks)
}

fn kept_with(
    id: &str,
    rules: &Rules,
    facts: &Facts,
    forced: &HashSet<(i32, i32)>,
    border: Option<Border>,
    chunks: &HashMap<(i32, i32), (Chunk, bool)>,
) -> HashSet<(i32, i32)> {
    let gone = decide(
        &World {
            id,
            rules,
            facts,
            forced,
            border,
        },
        chunks,
    );
    chunks
        .keys()
        .filter(|c| !gone.contains(c))
        .copied()
        .collect()
}

fn set(chunks: &[(i32, i32)]) -> HashSet<(i32, i32)> {
    chunks.iter().copied().collect()
}

#[test]
fn time_spent_keeps_chunks() {
    let mut chunks = field(3);
    chunks.insert((1, 1), info(2400));
    chunks.insert((2, 2), info(2399));
    let rules = no_rules();
    assert_eq!(kept(OW, &rules, &Facts::default(), &chunks), set(&[(1, 1)]));
    // At 0 minutes, any time at all keeps a chunk.
    let rules = Rules {
        inhabited_ticks: 0,
        ..no_rules()
    };
    assert_eq!(
        kept(OW, &rules, &Facts::default(), &chunks),
        set(&[(1, 1), (2, 2)])
    );
}

#[test]
fn spawn_and_players_keep_what_is_near_them() {
    let chunks = field(6);
    let facts = Facts {
        spawn: Some(Place {
            dimension: OW.into(),
            x: 4,
            z: 4,
        }),
        players: vec![
            Place {
                dimension: OW.into(),
                x: -5,
                z: 0,
            },
            Place {
                dimension: "minecraft:the_nether".into(),
                x: 0,
                z: 0,
            },
        ],
        ..Facts::default()
    };
    let rules = Rules {
        spawn_radius: 1,
        player_radius: 1,
        ..no_rules()
    };
    let mut want = HashSet::new();
    for x in 3..=5 {
        for z in 3..=5 {
            want.insert((x, z));
        }
    }
    for x in -6..=-4 {
        for z in -1..=1 {
            want.insert((x, z));
        }
    }
    assert_eq!(kept(OW, &rules, &facts, &chunks), want);
    // In the Nether only the player there counts.
    assert_eq!(
        kept("minecraft:the_nether", &rules, &facts, &chunks).len(),
        9
    );
}

#[test]
fn the_buffer_grows_kept_chunks_but_never_revives_doomed_ones() {
    let mut chunks = field(5);
    chunks.insert((0, 0), info(10_000));
    chunks.insert(
        (1, 0),
        (
            Chunk {
                inhabited: 0,
                full: false,
                readable: true,
            },
            false,
        ),
    );
    let rules = Rules {
        buffer: 2,
        ..no_rules()
    };
    let got = kept(OW, &rules, &Facts::default(), &chunks);
    assert_eq!(got.len(), 24);
    assert!(got.contains(&(2, 2)) && got.contains(&(-2, -2)));
    assert!(!got.contains(&(3, 0)));
    assert!(
        !got.contains(&(1, 0)),
        "unfinished chunks go even in the buffer"
    );
}

#[test]
fn protected_areas_forced_and_stuck_chunks_are_always_kept() {
    let mut chunks = field(4);
    chunks.insert(
        (-4, -4),
        (
            Chunk {
                inhabited: 0,
                full: false,
                readable: true,
            },
            false,
        ),
    );
    chunks.insert((3, -3), (info(0).0, true));
    let rules = Rules {
        protect: vec![Area {
            name: "Town".into(),
            dimension: OW.into(),
            min: (-4, -4),
            max: (-3, -3),
        }],
        ..no_rules()
    };
    let forced = set(&[(2, 2)]);
    let got = kept_with(OW, &rules, &Facts::default(), &forced, None, &chunks);
    assert_eq!(
        got,
        set(&[(-4, -4), (-4, -3), (-3, -4), (-3, -3), (2, 2), (3, -3)])
    );
    // The area belongs to the Overworld only.
    assert_eq!(
        kept_with(
            "minecraft:the_nether",
            &rules,
            &Facts::default(),
            &HashSet::new(),
            None,
            &chunks
        ),
        set(&[(3, -3)])
    );
}

#[test]
fn the_end_keeps_its_middle() {
    let chunks = field(14);
    let rules = Rules {
        end_radius: 12,
        ..no_rules()
    };
    let got = kept("minecraft:the_end", &rules, &Facts::default(), &chunks);
    assert_eq!(got.len(), 25 * 25);
    assert!(got.contains(&(12, -12)) && !got.contains(&(13, 0)));
    assert!(kept(OW, &rules, &Facts::default(), &chunks).is_empty());
}

#[test]
fn unfinished_and_unreadable_chunks() {
    let mut chunks = HashMap::new();
    let unfinished = Chunk {
        inhabited: 100_000,
        full: false,
        readable: true,
    };
    let unreadable = Chunk {
        inhabited: i64::MAX,
        full: true,
        readable: false,
    };
    chunks.insert((0, 0), (unfinished, false));
    chunks.insert((5, 5), (unreadable, false));
    let on = no_rules();
    assert_eq!(kept(OW, &on, &Facts::default(), &chunks), set(&[(5, 5)]));
    let off = Rules {
        unfinished: false,
        ..no_rules()
    };
    assert_eq!(
        kept(OW, &off, &Facts::default(), &chunks),
        set(&[(0, 0), (5, 5)])
    );
}

#[test]
fn chunks_outside_the_border_go() {
    let mut chunks = field(3);
    for c in chunks.values_mut() {
        c.0.inhabited = 100_000;
    }
    // 64 blocks wide round 0,0: chunks -2..=1.
    let border = Some(Border {
        centre_x: 0.0,
        centre_z: 0.0,
        size: 64.0,
    });
    let rules = no_rules();
    let got = kept_with(
        OW,
        &rules,
        &Facts::default(),
        &HashSet::new(),
        border,
        &chunks,
    );
    assert_eq!(got.len(), 16);
    assert!(got.contains(&(-2, 1)) && !got.contains(&(2, 0)));
    let off = Rules {
        border: false,
        ..no_rules()
    };
    let got = kept_with(
        OW,
        &off,
        &Facts::default(),
        &HashSet::new(),
        border,
        &chunks,
    );
    assert_eq!(got.len(), 49);
}

#[test]
fn reads_chunks_old_and_new() {
    let new = trim::read_chunk(&chunk_nbt("minecraft:full", 77, 0));
    assert_eq!(
        new,
        Chunk {
            inhabited: 77,
            full: true,
            readable: true
        }
    );
    assert!(!trim::read_chunk(&chunk_nbt("minecraft:features", 0, 0)).full);
    // Before 1.18: inside Level, with a bare status.
    let mut level = Vec::new();
    string(&mut level, "Status", "full");
    long(&mut level, "InhabitedTime", 5);
    let mut b = Vec::new();
    compound(&mut b, "Level", &level);
    let old = trim::read_chunk(&root(&b));
    assert_eq!((old.inhabited, old.full), (5, true));
    // No InhabitedTime: nothing says it's unused, so it's kept.
    assert_eq!(trim::read_chunk(&root(&[])).inhabited, i64::MAX);
    assert!(!trim::read_chunk(b"junk").readable);
}

// --- The files ---

const fn options(dry_run: bool) -> Options {
    Options {
        dry_run,
        threads: 2,
    }
}

/// Every file under a folder with its bytes, to check a dry run changed nothing.
fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut out = Vec::new();
    let mut todo = vec![dir.to_path_buf()];
    while let Some(d) = todo.pop() {
        for e in fs::read_dir(&d).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                todo.push(p);
            } else {
                out.push((p.clone(), fs::read(&p).unwrap()));
            }
        }
    }
    out.sort();
    out
}

#[test]
fn trims_terrain_entities_poi_and_mcc_together() {
    let root_dir = scratch("files");
    let world = new_world(&root_dir);
    let ow = overworld(&world);
    let used = chunk_nbt("minecraft:full", 50_000, 3000);
    // r.0.0: chunk 0 is used; 1 isn't; 2 isn't and is too big for the region.
    let terrain = write_region(
        &ow.join("region"),
        0,
        0,
        &[
            put(0, used.clone()),
            put(1, chunk_nbt("minecraft:full", 0, 5000)),
            Put {
                i: 2,
                nbt: chunk_nbt("minecraft:full", 0, 9000),
                external: true,
            },
        ],
    );
    // Its mobs and POI, for chunks 0 and 1 and for 1 and 2.
    let mobs = write_region(
        &ow.join("entities"),
        0,
        0,
        &[put(0, root(&[])), put(1, root(&[]))],
    );
    let poi = write_region(
        &ow.join("poi"),
        0,
        0,
        &[
            put(1, root(&[])),
            Put {
                i: 2,
                nbt: root(&[]),
                external: true,
            },
        ],
    );
    // r.3.0 is far from spawn and nobody went there: the whole region goes.
    let far = write_region(
        &ow.join("region"),
        3,
        0,
        &[put(0, chunk_nbt("minecraft:full", 0, 10))],
    );
    let far_mobs = write_region(&ow.join("entities"), 3, 0, &[put(0, root(&[]))]);
    // A file a stopped trim left behind.
    let stale = region::temp_path(&terrain);
    fs::write(&stale, b"half").unwrap();

    let dim = &world::dimensions(&world)[0];
    let rules = Rules {
        spawn_radius: 0,
        buffer: 0,
        ..Rules::default()
    };
    let facts = Facts::read(&world);
    let before = snapshot(&root_dir);
    let dry = trim::trim(dim, &rules, &facts, options(true), &|| {}).unwrap();
    assert_eq!(snapshot(&root_dir), before, "a dry run writes nothing");
    assert_eq!((dry.regions, dry.chunks, dry.removed), (2, 4, 3));
    assert_eq!(dry.errors, 0, "{:?}", dry.first_error);
    assert_eq!(dry.gone[&(0, 0)][0], 0b110);
    assert_eq!(dry.gone[&(3, 0)][0], 0b1);

    let old = Region::open(&terrain, 0, 0).unwrap();
    let report = trim::trim(dim, &rules, &facts, options(false), &|| {}).unwrap();
    assert_eq!(report.removed, dry.removed);
    assert_eq!(report.regions_deleted, 1);
    assert_eq!(
        report.bytes_after, dry.bytes_after,
        "the dry run's sums were right"
    );
    assert!(report.bytes_after < report.bytes_before);

    // The kept chunk is exactly as it was, save time included.
    let new = Region::open(&terrain, 0, 0).unwrap();
    assert_eq!(chunks_in(&terrain), [0]);
    assert_eq!(new.sectors(0).unwrap(), old.sectors(0).unwrap());
    assert_eq!(new.entry(0).unwrap().saved, 1000);
    assert_eq!(new.chunk(0).unwrap().unwrap(), used);
    assert_eq!(
        fs::metadata(&terrain).unwrap().len(),
        (HEADER + SECTOR) as u64
    );
    // Its mobs stay; the rest went with their chunks.
    assert_eq!(chunks_in(&mobs), [0]);
    assert!(!poi.exists(), "all its POI went, so the file did too");
    assert!(!far.exists() && !far_mobs.exists());
    let mcc = |dir: &str| ow.join(dir).join(region::mcc_name(2, 0));
    assert!(!mcc("region").exists() && !mcc("poi").exists());
    assert!(!stale.exists());
    for dir in ["region", "entities", "poi"] {
        for e in fs::read_dir(ow.join(dir)).unwrap().flatten() {
            let name = e.file_name().into_string().unwrap();
            assert!(!region::is_temp(&name), "left {name} behind");
        }
    }
    // Nothing more to do.
    let again = trim::trim(dim, &rules, &facts, options(true), &|| {}).unwrap();
    assert_eq!((again.chunks, again.removed), (1, 0));
    assert_eq!(again.bytes_before, report.bytes_after);
    fs::remove_dir_all(root_dir).unwrap();
}

#[test]
fn leaves_broken_regions_alone() {
    let root_dir = scratch("broken");
    let world = new_world(&root_dir);
    let ow = overworld(&world);
    let path = write_region(
        &ow.join("region"),
        5,
        5,
        &[
            put(0, chunk_nbt("minecraft:full", 0, 10)),
            put(1, chunk_nbt("minecraft:full", 0, 10)),
        ],
    );
    // Chunk 1 now points past the end of the file.
    let mut bytes = fs::read(&path).unwrap();
    bytes[4..8].copy_from_slice(&[0, 0, 99, 1]);
    fs::write(&path, &bytes).unwrap();
    let dim = &world::dimensions(&world)[0];
    let report = trim::trim(
        dim,
        &Rules::default(),
        &Facts::read(&world),
        options(false),
        &|| {},
    )
    .unwrap();
    assert_eq!(report.removed, 0);
    assert_eq!(report.errors, 1);
    assert!(report.first_error.unwrap().contains("past the end"));
    assert_eq!(fs::read(&path).unwrap(), bytes);
    fs::remove_dir_all(root_dir).unwrap();
}

#[test]
fn reads_what_the_world_says_about_itself() {
    let root_dir = scratch("facts");
    let world = new_world(&root_dir);
    let ow = overworld(&world);
    // A player in the Nether whose bed is at block 320, 320 in the Overworld.
    let mut respawn = Vec::new();
    string(&mut respawn, "dimension", "minecraft:overworld");
    ints(&mut respawn, "pos", &[320, 64, 320]);
    let mut player = Vec::new();
    player.push(9);
    name(&mut player, "Pos");
    player.push(6);
    player.extend(3i32.to_be_bytes());
    for v in [-16.5f64, 70.0, 16.0] {
        player.extend(v.to_be_bytes());
    }
    string(&mut player, "Dimension", "minecraft:the_nether");
    compound(&mut player, "respawn", &respawn);
    fs::create_dir_all(world.join("players/data")).unwrap();
    fs::write(world.join("players/data/0000.dat"), gzip(&root(&player))).unwrap();
    fs::write(world.join("players/data/bad.dat"), b"nonsense").unwrap();
    // A 1000-block border round 500, 0, and a forced chunk at 7, 7.
    let mut border = Vec::new();
    double(&mut border, "center_x", 500.0);
    double(&mut border, "center_z", 0.0);
    double(&mut border, "size", 1000.0);
    let mut b = Vec::new();
    compound(&mut b, "data", &border);
    fs::create_dir_all(ow.join("data/minecraft")).unwrap();
    fs::write(ow.join("data/minecraft/world_border.dat"), gzip(&root(&b))).unwrap();
    let mut ticket = Vec::new();
    string(&mut ticket, "type", "minecraft:forced");
    ints(&mut ticket, "chunk_pos", &[7, 7]);
    let mut tickets = Vec::new();
    tickets.push(9);
    name(&mut tickets, "tickets");
    tickets.push(10);
    tickets.extend(1i32.to_be_bytes());
    tickets.extend(&ticket);
    tickets.push(0);
    let mut t = Vec::new();
    compound(&mut t, "data", &tickets);
    fs::write(ow.join("data/minecraft/chunk_tickets.dat"), gzip(&root(&t))).unwrap();
    fs::create_dir_all(ow.join("region")).unwrap();

    let facts = Facts::read(&world);
    assert_eq!(
        facts.spawn,
        Some(Place {
            dimension: OW.into(),
            x: 0,
            z: 0
        })
    );
    assert_eq!(
        facts.players,
        [
            Place {
                dimension: "minecraft:the_nether".into(),
                x: -2,
                z: 1
            },
            Place {
                dimension: OW.into(),
                x: 20,
                z: 20
            },
        ]
    );
    assert_eq!(facts.warnings.len(), 1);
    assert!(facts.warnings[0].contains("bad.dat"));
    let dim = &world::dimensions(&world)[0];
    let b = facts.border(dim).unwrap();
    assert!(b.outside(-1, 0) && !b.outside(0, 0) && b.outside(63, 0));
    assert_eq!(flytower_world::facts::forced(dim), set(&[(7, 7)]));
    fs::remove_dir_all(root_dir).unwrap();
}

#[test]
fn reads_the_older_layout() {
    let root_dir = scratch("old");
    let world = root_dir.join("world");
    // level.dat with the old spawn and one border for every dimension.
    let mut data = Vec::new();
    ints(&mut data, "unused", &[]);
    data.extend([3, 0, 6]);
    data.extend(b"SpawnX");
    data.extend(32i32.to_be_bytes());
    data.extend([3, 0, 6]);
    data.extend(b"SpawnZ");
    data.extend((-32i32).to_be_bytes());
    double(&mut data, "BorderCenterX", 0.0);
    double(&mut data, "BorderCenterZ", 0.0);
    double(&mut data, "BorderSize", 1024.0);
    let mut level = Vec::new();
    compound(&mut level, "Data", &data);
    fs::create_dir_all(world.join("region")).unwrap();
    fs::create_dir_all(world.join("DIM-1/region")).unwrap();
    fs::write(world.join("level.dat"), gzip(&root(&level))).unwrap();
    // Forced chunks the old way: x in the low half of a long, z in the high half.
    let packed = (i64::from(-3i32) << 32) | i64::from(5u32);
    let mut forced = Vec::new();
    forced.push(12);
    name(&mut forced, "Forced");
    forced.extend(1i32.to_be_bytes());
    forced.extend(packed.to_be_bytes());
    let mut c = Vec::new();
    compound(&mut c, "data", &forced);
    fs::create_dir_all(world.join("data")).unwrap();
    fs::write(world.join("data/chunks.dat"), gzip(&root(&c))).unwrap();

    let facts = Facts::read(&world);
    assert_eq!(
        facts.spawn,
        Some(Place {
            dimension: OW.into(),
            x: 2,
            z: -2
        })
    );
    let dims = world::dimensions(&world);
    // 1024 blocks in the Overworld, an eighth of that in the Nether.
    assert!(!facts.border(&dims[0]).unwrap().outside(31, 0));
    assert!(facts.border(&dims[0]).unwrap().outside(32, 0));
    assert!(facts.border(&dims[1]).unwrap().outside(4, 0));
    assert!(!facts.border(&dims[1]).unwrap().outside(3, 0));
    assert_eq!(flytower_world::facts::forced(&dims[0]), set(&[(5, -3)]));
    fs::remove_dir_all(root_dir).unwrap();
}

#[test]
fn the_command_reports_and_writes_the_bitmap() {
    let root_dir = scratch("cli");
    let world = new_world(&root_dir);
    let ow = overworld(&world);
    write_region(
        &ow.join("region"),
        -1,
        -1,
        &[
            put(1023, chunk_nbt("minecraft:full", 99_999, 10)),
            put(0, chunk_nbt("minecraft:full", 0, 10)),
        ],
    );
    let rules = root_dir.join("rules.json");
    fs::write(&rules, r#"{"spawnRadius": 0, "buffer": 0}"#).unwrap();
    let bitmap = root_dir.join("gone.json");
    let out = Command::new(env!("CARGO_BIN_EXE_flytower-world"))
        .args(["trim", "--dry-run", "--progress", "--world"])
        .arg(&world)
        .arg("--rules")
        .arg(&rules)
        .arg("--bitmap")
        .arg(&bitmap)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(report["version"], 1);
    assert_eq!(report["dryRun"], true);
    assert_eq!(report["pregenerated"], false);
    let dim = &report["dimensions"][0];
    assert_eq!(dim["id"], "minecraft:overworld");
    assert_eq!(
        (dim["chunks"].as_u64(), dim["removed"].as_u64()),
        (Some(2), Some(1))
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.starts_with("progress 0 1\n") && stderr.ends_with("progress 1 1\n"));
    let gone: serde_json::Value = serde_json::from_slice(&fs::read(&bitmap).unwrap()).unwrap();
    let region = &gone["dimensions"][0]["regions"][0];
    assert_eq!(
        (region[0].as_i64(), region[1].as_i64()),
        (Some(-1), Some(-1))
    );
    // Chunk 0 goes: the first bit of 128 bytes.
    assert_eq!(region[2], format!("AQ{}=", "A".repeat(169)));

    // A typo in the rules is refused, not ignored.
    fs::write(&rules, r#"{"spawnradius": 0}"#).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_flytower-world"))
        .args(["trim", "--world"])
        .arg(&world)
        .arg("--rules")
        .arg(&rules)
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("unknown rule spawnradius"));
    assert_eq!(chunks_in(&ow.join("region/r.-1.-1.mca")), [0, 1023]);

    let out = Command::new(env!("CARGO_BIN_EXE_flytower-world"))
        .args(["dimensions", "--world"])
        .arg(&world)
        .output()
        .unwrap();
    let dims: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(dims["dimensions"][0]["trimmed"], true);
    fs::remove_dir_all(root_dir).unwrap();
}
