//! `flytower-world trim --world DIR [--rules FILE] [--dry-run] [--bitmap FILE] [--progress]`
//! trims a world and prints one line of JSON saying what it did (or, with `--dry-run`, what
//! it would do). `flytower-world dimensions --world DIR` lists the dimensions it can trim.
//! See the library docs.

use std::ffi::OsString;
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use flytower_anvil::world;
use flytower_world::facts::Facts;
use flytower_world::rules::Rules;
use flytower_world::trim::{self, Options};
use flytower_world::{FORMAT, bitmap_json, pregenerated, quote, report_json};

const USAGE: &str = "\
usage: flytower-world trim --world DIR [--rules FILE] [--dry-run] [--bitmap FILE]
                           [--threads N] [--progress]
       flytower-world dimensions --world DIR";

struct Args {
    command: String,
    world: Option<PathBuf>,
    rules: Option<PathBuf>,
    bitmap: Option<PathBuf>,
    dry_run: bool,
    progress: bool,
    threads: usize,
}

fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Args, String> {
    let mut args = args.into_iter();
    let command = match args.next().and_then(|a| a.into_string().ok()) {
        Some(c) if c == "trim" || c == "dimensions" => c,
        Some(c) => return Err(format!("unknown command {c}")),
        None => return Err("give a command".into()),
    };
    let mut parsed = Args {
        command,
        world: None,
        rules: None,
        bitmap: None,
        dry_run: false,
        progress: false,
        threads: std::thread::available_parallelism().map_or(1, |n| n.get().min(4)),
    };
    while let Some(arg) = args.next() {
        let flag = arg.to_str().unwrap_or("");
        let mut value = || args.next().ok_or_else(|| format!("{flag} needs a value"));
        match flag {
            "--world" => parsed.world = Some(value()?.into()),
            "--rules" => parsed.rules = Some(value()?.into()),
            "--bitmap" => parsed.bitmap = Some(value()?.into()),
            "--dry-run" => parsed.dry_run = true,
            "--progress" => parsed.progress = true,
            "--threads" => match value()?.to_str().and_then(|n| n.parse().ok()) {
                Some(n @ 1..=64) => parsed.threads = n,
                _ => return Err("--threads takes a number from 1 to 64".into()),
            },
            _ => return Err(format!("unknown option {}", arg.to_string_lossy())),
        }
    }
    if parsed.world.is_none() {
        return Err("give --world".into());
    }
    Ok(parsed)
}

fn main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    match args.first().and_then(|a| a.to_str()) {
        Some("--help" | "-h") => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Some("--version" | "-V") => {
            println!("flytower-world {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        _ => {}
    }
    let args = match parse(args) {
        Ok(args) => args,
        Err(e) => {
            eprintln!("flytower-world: {e}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match run(&args) {
        Ok(json) => {
            if std::io::stdout().write_all(json.as_bytes()).is_err() {
                return ExitCode::FAILURE;
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("flytower-world: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: &Args) -> Result<String, String> {
    let world_dir = args.world.as_deref().unwrap_or_else(|| Path::new("."));
    if !world_dir.join("level.dat").is_file() {
        return Err(format!(
            "{} isn't a world: it has no level.dat",
            world_dir.display()
        ));
    }
    let rules = match &args.rules {
        Some(path) => {
            let text =
                std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
            Rules::parse(&text).map_err(|e| format!("{}: {e}", path.display()))?
        }
        None => Rules::default(),
    };
    let dims = world::dimensions(world_dir);
    let mut json = format!("{{\"version\":{FORMAT},");
    if args.command == "dimensions" {
        json.push_str("\"dimensions\":[");
        for (i, d) in dims.iter().enumerate() {
            let comma = if i == 0 { "" } else { "," };
            let _ = write!(
                json,
                "{comma}{{\"id\":{},\"regions\":{},\"trimmed\":{}}}",
                quote(&d.id),
                quote(&d.regions.to_string_lossy()),
                rules.dimensions.contains(&d.id)
            );
        }
        json.push_str("]}\n");
        return Ok(json);
    }

    let started = Instant::now();
    let facts = Facts::read(world_dir);
    let chosen: Vec<_> = dims
        .iter()
        .filter(|d| rules.dimensions.contains(&d.id))
        .collect();
    let passes = if args.dry_run { 1 } else { 2 };
    let total: usize = chosen
        .iter()
        .map(|d| region_files(&d.regions) * passes)
        .sum();
    let done = AtomicUsize::new(0);
    let region_done = || {
        if args.progress {
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            // One short line per region and pass, as flytower-map does.
            eprintln!("progress {} {total}", n.min(total));
        }
    };
    if args.progress {
        eprintln!("progress 0 {total}");
    }
    let opts = Options {
        dry_run: args.dry_run,
        threads: args.threads,
    };
    let mut reports = Vec::new();
    for dim in chosen {
        reports.push(
            trim::trim(dim, &rules, &facts, opts, &region_done)
                .map_err(|e| format!("{}: {e}", dim.id))?,
        );
    }
    if let Some(path) = &args.bitmap {
        flytower_anvil::region::replace(path, bitmap_json(&reports).as_bytes())
            .map_err(|e| format!("{}: {e}", path.display()))?;
    }
    let _ = write!(
        json,
        "\"dryRun\":{},\"pregenerated\":{},\"warnings\":[",
        args.dry_run,
        pregenerated(&reports)
    );
    for (i, w) in facts.warnings.iter().enumerate() {
        let comma = if i == 0 { "" } else { "," };
        let _ = write!(json, "{comma}{}", quote(w));
    }
    json.push_str("],\"dimensions\":[");
    for (i, r) in reports.iter().enumerate() {
        let comma = if i == 0 { "" } else { "," };
        let _ = write!(json, "{comma}{}", report_json(r));
    }
    let _ = writeln!(json, "],\"ms\":{}}}", started.elapsed().as_millis());
    Ok(json)
}

/// Region files in a folder, as a pass will count them.
fn region_files(dir: &Path) -> usize {
    std::fs::read_dir(dir).map_or(0, |entries| {
        entries
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .and_then(flytower_anvil::region::coords)
                    .is_some()
            })
            .count()
    })
}
