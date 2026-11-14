//! End-to-end: build small worlds by hand, draw them, and check the tiles.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use flate2::Compression;
use flate2::write::{GzEncoder, ZlibEncoder};
use flytower_map::palette::Palette;
use flytower_map::render::{Options, render, render_with};
use flytower_map::world::MapDimension;
use flytower_map::{manifest, tiles, world};
use std::sync::atomic::{AtomicU32, Ordering};

/// A fresh, empty folder for one test.
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("flytower-map-{}-{name}", std::process::id()));
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

fn longs(out: &mut Vec<u8>, key: &str, values: &[i64]) {
    out.push(12);
    name(out, key);
    out.extend(i32::try_from(values.len()).unwrap().to_be_bytes());
    for v in values {
        out.extend(v.to_be_bytes());
    }
}

/// Packs 4-bit indices, 16 to a long.
fn pack4(indices: &[u8]) -> Vec<i64> {
    indices
        .chunks(16)
        .map(|c| {
            c.iter()
                .enumerate()
                .fold(0i64, |w, (i, &v)| w | i64::from(v) << (i * 4))
        })
        .collect()
}

/// One section: `Y`, a block palette, 4096 block indices, and one biome.
fn section(y: i8, palette: &[&str], blocks: &[u8], biome: &str) -> Vec<u8> {
    let mut s = Vec::new();
    s.extend([1, 0, 1, b'Y', y.to_be_bytes()[0]]);
    s.push(10);
    name(&mut s, "block_states");
    s.push(9);
    name(&mut s, "palette");
    s.push(10);
    s.extend(i32::try_from(palette.len()).unwrap().to_be_bytes());
    for block in palette {
        string(&mut s, "Name", block);
        s.push(0);
    }
    longs(&mut s, "data", &pack4(blocks));
    s.push(0);
    s.push(10);
    name(&mut s, "biomes");
    s.push(9);
    name(&mut s, "palette");
    s.push(8);
    s.extend(1i32.to_be_bytes());
    name(&mut s, biome);
    s.push(0);
    s.push(0);
    s
}

fn chunk(status: &str, sections: &[Vec<u8>]) -> Vec<u8> {
    let mut c = vec![10, 0, 0];
    c.extend([3, 0, 11]);
    c.extend(b"DataVersion");
    c.extend(4000i32.to_be_bytes());
    string(&mut c, "Status", status);
    c.push(9);
    name(&mut c, "sections");
    c.push(10);
    c.extend(i32::try_from(sections.len()).unwrap().to_be_bytes());
    for s in sections {
        c.extend(s);
    }
    c.push(0);
    c
}

/// Overworld test chunk: stone at y 0 to 2, then grass at y 3 on the west half and two
/// blocks of water on the east half.
fn overworld_chunk() -> Vec<u8> {
    let mut blocks = vec![0u8; 4096];
    for z in 0..16 {
        for x in 0..16 {
            for y in 0..3 {
                blocks[y << 8 | z << 4 | x] = 1;
            }
            if x < 8 {
                blocks[3 << 8 | z << 4 | x] = 3;
            } else {
                blocks[3 << 8 | z << 4 | x] = 2;
                blocks[4 << 8 | z << 4 | x] = 2;
            }
        }
    }
    let palette = [
        "minecraft:air",
        "minecraft:stone",
        "minecraft:water",
        "minecraft:grass_block",
    ];
    chunk(
        "minecraft:full",
        &[section(0, &palette, &blocks, "minecraft:desert")],
    )
}

// --- Compressing ---

fn zlib(data: &[u8]) -> Vec<u8> {
    let mut e = ZlibEncoder::new(Vec::new(), Compression::fast());
    e.write_all(data).unwrap();
    e.finish().unwrap()
}

fn gzip(data: &[u8]) -> Vec<u8> {
    let mut e = GzEncoder::new(Vec::new(), Compression::fast());
    e.write_all(data).unwrap();
    e.finish().unwrap()
}

/// lz4-java's block stream around one LZ4 block of literals only, then the end block.
fn lz4(data: &[u8]) -> Vec<u8> {
    let mut block = vec![0xf0];
    let mut extra = data.len() - 15;
    while extra >= 255 {
        block.push(255);
        extra -= 255;
    }
    block.push(u8::try_from(extra).unwrap());
    block.extend(data);
    let mut out = Vec::new();
    for (method, packed, unpacked) in [(0x20, block.as_slice(), data.len()), (0x10, &[][..], 0)] {
        out.extend(b"LZ4Block");
        out.push(method);
        out.extend(u32::try_from(packed.len()).unwrap().to_le_bytes());
        out.extend(u32::try_from(unpacked).unwrap().to_le_bytes());
        out.extend(0u32.to_le_bytes());
        out.extend(packed);
    }
    out
}

/// A region file with chunks at the given indices: `(index, compression type, data)`.
fn region_file(chunks: &[(usize, u8, Vec<u8>)], stamp: u32) -> Vec<u8> {
    let mut file = vec![0u8; 8192];
    for (i, kind, data) in chunks {
        let sector = file.len() / 4096;
        let mut body = (u32::try_from(data.len()).unwrap() + 1)
            .to_be_bytes()
            .to_vec();
        body.push(*kind);
        body.extend(data);
        let sectors = body.len().div_ceil(4096);
        body.resize(sectors * 4096, 0);
        file[i * 4..i * 4 + 4].copy_from_slice(&[
            u8::try_from(sector >> 16).unwrap(),
            u8::try_from(sector >> 8 & 0xff).unwrap(),
            u8::try_from(sector & 0xff).unwrap(),
            u8::try_from(sectors).unwrap(),
        ]);
        file[4096 + i * 4..4096 + i * 4 + 4].copy_from_slice(&stamp.to_be_bytes());
        file.extend(body);
    }
    file
}

fn pixel(tile: &[u8], x: usize, z: usize) -> [u8; 4] {
    let i = (z * 512 + x) * 4;
    [tile[i], tile[i + 1], tile[i + 2], tile[i + 3]]
}

const fn opts() -> Options {
    Options {
        threads: 2,
        full: false,
        levels: 2,
        progress: false,
    }
}

#[test]
fn draws_every_compression_and_skips_what_it_should() {
    let root = scratch("compressions");
    let world_dir = root.join("world");
    let regions = world_dir.join("region");
    fs::create_dir_all(&regions).unwrap();
    let c = overworld_chunk();
    let unfinished = chunk("minecraft:features", &[]);
    let file = region_file(
        &[
            (0, 2, zlib(&c)),
            (1, 1, gzip(&c)),
            (2, 3, c.clone()),
            (3, 4, lz4(&c)),
            (4, 0x82, Vec::new()),
            (5, 2, zlib(&unfinished)),
            (6, 2, b"not zlib".to_vec()),
        ],
        1,
    );
    fs::write(regions.join("r.0.0.mca"), file).unwrap();
    // Chunk 4 is too big for the region file, so its data lives on its own.
    fs::write(regions.join("c.4.0.mcc"), zlib(&c)).unwrap();

    let out = root.join("out");
    let dims = world::dimensions(&world_dir);
    let palette = Palette::builtin();
    let report = render(&dims[0], &out, &palette, opts()).unwrap();
    assert_eq!(
        (report.regions, report.drawn, report.chunks, report.errors),
        (1, 1, 5, 1)
    );
    assert!(report.first_error.unwrap().contains("decompress"));

    let tile = tiles::read(&tiles::path(&out.join(dims[0].tiles()), 0, 0, 0)).unwrap();
    let desert = palette.biome_id("minecraft:desert");
    let grass = palette.colour(palette.block_id("minecraft:grass_block"), desert);
    for i in 0..5 {
        // Every compression gives the same picture: grass to the west.
        assert_eq!(pixel(&tile, i * 16 + 3, 5), grass, "chunk {i}");
        // Water to the east, over stone, so neither water nor stone exactly.
        let wet = pixel(&tile, i * 16 + 12, 5);
        assert_eq!(wet[3], 255);
        assert!(wet[2] > wet[0], "water is blue in chunk {i}: {wet:?}");
    }
    // Unfinished, broken and missing chunks stay clear.
    for i in [5, 6, 7, 40] {
        assert_eq!(
            pixel(&tile, i % 32 * 16 + 1, i / 32 * 16 + 1),
            [0; 4],
            "chunk {i}"
        );
    }

    // Zoomed-out tiles cover the same spot at half the size, then a quarter.
    let dir = out.join(dims[0].tiles());
    let z1 = tiles::read(&tiles::path(&dir, 1, 0, 0)).unwrap();
    assert_eq!(pixel(&z1, 1, 2), grass);
    assert!(tiles::read(&tiles::path(&dir, 2, 0, 0)).is_some());

    let json = manifest(&out, &dims, 2);
    assert!(
        json.contains(
            r#""id":"minecraft:overworld","tiles":"tiles/minecraft/overworld","bounds":[0,0,0,0]"#
        ),
        "{json}"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn only_redraws_what_changed() {
    let root = scratch("incremental");
    let world_dir = root.join("world");
    let regions = world_dir.join("region");
    fs::create_dir_all(&regions).unwrap();
    let c = overworld_chunk();
    for (x, z) in [(0, 0), (-1, 0), (3, 3)] {
        fs::write(
            regions.join(format!("r.{x}.{z}.mca")),
            region_file(&[(0, 2, zlib(&c))], 1),
        )
        .unwrap();
    }
    // An empty region file: no chunks, no tile, but nothing to redraw next time either.
    fs::write(regions.join("r.5.5.mca"), b"").unwrap();
    let out = root.join("out");
    let dims = world::dimensions(&world_dir);
    let palette = Palette::builtin();
    let dir = out.join(dims[0].tiles());

    let first = render(&dims[0], &out, &palette, opts()).unwrap();
    assert_eq!((first.regions, first.drawn, first.unchanged), (4, 4, 0));
    assert!(!tiles::path(&dir, 0, 5, 5).exists());
    // (-1, 0) and (0, 0) share no level-1 parent: -1 >> 1 is -1.
    assert!(tiles::path(&dir, 1, -1, 0).exists());
    assert!(tiles::path(&dir, 1, 0, 0).exists());
    assert!(tiles::path(&dir, 2, 0, 0).exists());

    let again = render(&dims[0], &out, &palette, opts()).unwrap();
    assert_eq!((again.drawn, again.unchanged, again.removed), (0, 4, 0));

    // A chunk saved again changes its timestamp; a deleted region takes its tiles with it.
    fs::write(
        regions.join("r.0.0.mca"),
        region_file(&[(0, 2, zlib(&c))], 2),
    )
    .unwrap();
    fs::remove_file(regions.join("r.3.3.mca")).unwrap();
    // Every region file counts towards progress once, drawn or not.
    let done = AtomicU32::new(0);
    let third = render_with(&dims[0], &out, &palette, opts(), &|| {
        done.fetch_add(1, Ordering::Relaxed);
    })
    .unwrap();
    assert_eq!((third.drawn, third.unchanged, third.removed), (1, 2, 1));
    assert_eq!(done.into_inner(), third.regions);
    assert!(!tiles::path(&dir, 0, 3, 3).exists());
    assert!(!tiles::path(&dir, 1, 1, 1).exists());
    assert!(tiles::path(&dir, 2, 0, 0).exists());

    // A missing tile is drawn again even though its region didn't change.
    fs::remove_file(tiles::path(&dir, 0, -1, 0)).unwrap();
    let fourth = render(&dims[0], &out, &palette, opts()).unwrap();
    assert_eq!((fourth.drawn, fourth.unchanged), (1, 2));

    // Asking for a full pass, or changing the palette, redraws everything.
    let full = render(
        &dims[0],
        &out,
        &palette,
        Options {
            full: true,
            ..opts()
        },
    )
    .unwrap();
    assert_eq!(full.drawn, 3);
    let other = Palette::parse("block minecraft:stone 000000").unwrap();
    assert_eq!(render(&dims[0], &out, &other, opts()).unwrap().drawn, 3);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn draws_the_nether_below_its_roof() {
    let root = scratch("nether");
    let world_dir = root.join("world");
    let regions = world_dir.join("DIM-1/region");
    fs::create_dir_all(&regions).unwrap();
    // Section 7 holds y 112 to 127: bedrock roof at 127, netherrack to 122, air to 117,
    // soul sand floor at 116, netherrack below.
    let mut blocks = vec![0u8; 4096];
    for z in 0..16 {
        for x in 0..16 {
            for y in 0..16 {
                blocks[y << 8 | z << 4 | x] = match y {
                    15 => 1,
                    10..=14 | 0..=3 => 2,
                    5..=9 => 0,
                    _ => 3,
                };
            }
        }
    }
    let palette_names = [
        "minecraft:air",
        "minecraft:bedrock",
        "minecraft:netherrack",
        "minecraft:soul_sand",
    ];
    let c = chunk(
        "full",
        &[section(
            7,
            &palette_names,
            &blocks,
            "minecraft:nether_wastes",
        )],
    );
    fs::write(
        regions.join("r.0.0.mca"),
        region_file(&[(0, 2, zlib(&c))], 1),
    )
    .unwrap();

    let out = root.join("out");
    let dims = world::dimensions(&world_dir);
    assert_eq!(dims[0].id, "minecraft:the_nether");
    let palette = Palette::builtin();
    render(&dims[0], &out, &palette, opts()).unwrap();
    let tile = tiles::read(&tiles::path(&out.join(dims[0].tiles()), 0, 0, 0)).unwrap();
    let soul_sand = palette.colour(palette.block_id("minecraft:soul_sand"), 0);
    assert_eq!(pixel(&tile, 4, 4), soul_sand);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn the_command_prints_json() {
    let root = scratch("cli");
    let world_dir = root.join("world");
    fs::create_dir_all(world_dir.join("region")).unwrap();
    let c = overworld_chunk();
    fs::write(
        world_dir.join("region/r.0.0.mca"),
        region_file(&[(0, 2, zlib(&c))], 1),
    )
    .unwrap();
    let bin = Path::new(env!("CARGO_BIN_EXE_flytower-map"));
    let out = root.join("out");

    let run =
        |args: &[&std::ffi::OsStr]| std::process::Command::new(bin).args(args).output().unwrap();
    let listed = run(&[
        "dimensions".as_ref(),
        "--world".as_ref(),
        world_dir.as_os_str(),
    ]);
    assert!(listed.status.success());
    assert!(
        String::from_utf8_lossy(&listed.stdout)
            .starts_with(r#"{"version":1,"dimensions":[{"id":"minecraft:overworld""#)
    );

    let drawn = run(&[
        "render".as_ref(),
        "--world".as_ref(),
        world_dir.as_os_str(),
        "--out".as_ref(),
        out.as_os_str(),
    ]);
    assert!(
        drawn.status.success(),
        "{}",
        String::from_utf8_lossy(&drawn.stderr)
    );
    let text = String::from_utf8_lossy(&drawn.stdout);
    assert!(
        text.contains(r#"{"id":"minecraft:overworld","regions":1,"drawn":1,"unchanged":0,"removed":0,"chunks":1,"errors":0,"firstError":null}"#),
        "{text}"
    );
    assert!(out.join("maps.json").is_file());

    let bad = run(&["render".as_ref(), "--world".as_ref(), world_dir.as_os_str()]);
    assert_eq!(bad.status.code(), Some(2));
    let missing = run(&[
        "render".as_ref(),
        "--world".as_ref(),
        world_dir.as_os_str(),
        "--out".as_ref(),
        out.as_os_str(),
        "--dimension".as_ref(),
        "minecraft:the_end".as_ref(),
    ]);
    assert_eq!(missing.status.code(), Some(1));
    fs::remove_dir_all(root).unwrap();
}
