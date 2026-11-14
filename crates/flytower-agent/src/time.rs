//! Times without a date crate: ISO 8601 for the audit log, and systemd's own format for
//! `service.status`, in the box's time zone.

use std::time::{SystemTime, UNIX_EPOCH};

/// `time` as `2026-11-10T15:04:05.123Z`, like JavaScript's `toISOString`.
#[must_use]
pub fn iso(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs();
    let (y, m, d) = civil(i64::try_from(secs / 86_400).unwrap_or(0));
    let rem = secs % 86_400;
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem / 60 % 60,
        rem % 60,
        since.subsec_millis()
    )
}

/// Reads a time [`iso`] wrote (`YYYY-MM-DDTHH:MM:SS(.mmm)Z`). `None` for anything else.
#[must_use]
pub fn parse_iso(text: &str) -> Option<SystemTime> {
    let text = text.strip_suffix('Z')?;
    let (date, clock) = text.split_once('T')?;
    let num = |s: &str| {
        s.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| s.parse::<i64>().ok())
            .flatten()
    };
    let mut d = date.splitn(3, '-').map(num);
    let (year, month, day) = (d.next()??, d.next()??, d.next()??);
    let (hms, ms) = clock.split_once('.').unwrap_or((clock, "0"));
    let mut t = hms.splitn(3, ':').map(num);
    let (hour, min, sec) = (t.next()??, t.next()??, t.next()??);
    let ms = num(ms).filter(|_| ms.len() <= 3)? * 10_i64.pow(3 - u32::try_from(ms.len()).ok()?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || min > 59 || sec > 60 {
        return None;
    }
    let total = ((days(year, month, day) * 24 + hour) * 60 + min) * 60 + sec;
    let millis = u64::try_from(total * 1000 + ms).ok()?;
    Some(UNIX_EPOCH + std::time::Duration::from_millis(millis))
}

/// A calendar date to days since 1970-01-01 (Howard Hinnant's `days_from_civil`).
const fn days(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Days since 1970-01-01 to a calendar date (Howard Hinnant's `civil_from_days`).
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

/// A time zone read from a `TZif` file (`/etc/localtime`): when each offset began, and the
/// offsets with their abbreviations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Zone {
    transitions: Vec<(i64, usize)>,
    types: Vec<(i64, String)>,
}

impl Zone {
    /// UTC, for a box with no `/etc/localtime`.
    #[must_use]
    pub fn utc() -> Self {
        Self {
            transitions: Vec::new(),
            types: vec![(0, "UTC".into())],
        }
    }

    /// The box's zone, as systemctl uses it: `/etc/localtime`, or UTC without one.
    #[must_use]
    pub fn local() -> Self {
        std::fs::read("/etc/localtime")
            .ok()
            .and_then(|b| Self::parse(&b))
            .unwrap_or_else(Self::utc)
    }

    /// Reads a `TZif` file (RFC 8536), using the 64-bit block when there is one.
    #[must_use]
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let header = |at: usize| -> Option<(u8, [usize; 6])> {
            let h = bytes.get(at..at + 44)?;
            if &h[..4] != b"TZif" {
                return None;
            }
            let mut n = [0usize; 6];
            for (i, c) in h[20..44].chunks(4).enumerate() {
                n[i] = usize::try_from(u32::from_be_bytes(c.try_into().ok()?)).ok()?;
            }
            Some((h[4], n))
        };
        let (version, n) = header(0)?;
        // isutcnt, isstdcnt, leapcnt, timecnt, typecnt, charcnt
        let v1_len = n[3] * 5 + n[4] * 6 + n[5] + n[2] * 8 + n[1] + n[0];
        let (at, n, size) = if version >= b'2' {
            let at = 44 + v1_len;
            (at + 44, header(at)?.1, 8)
        } else {
            (44, n, 4)
        };
        let [_, _, _, timecnt, typecnt, charcnt] = n;
        let times = bytes.get(at..at + timecnt * size)?;
        let idx = bytes.get(at + timecnt * size..at + timecnt * (size + 1))?;
        let info_at = at + timecnt * (size + 1);
        let infos = bytes.get(info_at..info_at + typecnt * 6)?;
        let chars = bytes.get(info_at + typecnt * 6..info_at + typecnt * 6 + charcnt)?;
        let transitions = times
            .chunks(size)
            .zip(idx)
            .map(|(t, i)| {
                let at = if size == 8 {
                    i64::from_be_bytes(t.try_into().ok()?)
                } else {
                    i64::from(i32::from_be_bytes(t.try_into().ok()?))
                };
                Some((at, usize::from(*i)))
            })
            .collect::<Option<Vec<_>>>()?;
        let types = infos
            .chunks(6)
            .map(|t| {
                let offset = i64::from(i32::from_be_bytes(t[..4].try_into().ok()?));
                let from = chars.get(usize::from(t[5])..)?;
                let end = from.iter().position(|b| *b == 0).unwrap_or(from.len());
                Some((offset, String::from_utf8_lossy(&from[..end]).into_owned()))
            })
            .collect::<Option<Vec<_>>>()?;
        if types.is_empty() || transitions.iter().any(|(_, i)| *i >= types.len()) {
            return None;
        }
        Some(Self { transitions, types })
    }

    /// The offset in seconds and the abbreviation in force at `secs` since the epoch.
    fn at(&self, secs: i64) -> (i64, &str) {
        let i = match self.transitions.partition_point(|(t, _)| *t <= secs) {
            0 => 0,
            n => self.transitions[n - 1].1,
        };
        let (offset, name) = &self.types[i];
        (*offset, name)
    }
}

/// A systemd timestamp (microseconds since the epoch) as `systemctl show` prints it:
/// `Tue 2026-11-10 15:00:00 UTC`, in `zone`. Zero, systemd's "never", is empty.
#[must_use]
pub fn systemd(usec: u64, zone: &Zone) -> String {
    if usec == 0 {
        return String::new();
    }
    let secs = i64::try_from(usec / 1_000_000).unwrap_or(i64::MAX / 2);
    let (offset, name) = zone.at(secs);
    let local = secs + offset;
    let days = local.div_euclid(86_400);
    let rem = local.rem_euclid(86_400);
    let (y, m, d) = civil(days);
    // 1970-01-01 was a Thursday.
    let weekday = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"]
        [usize::try_from(days.rem_euclid(7)).unwrap_or(0)];
    format!(
        "{weekday} {y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} {name}",
        rem / 3600,
        rem / 60 % 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn formats_like_javascript() {
        assert_eq!(iso(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        // new Date(1794323045123).toISOString()
        let t = UNIX_EPOCH + Duration::from_millis(1_794_323_045_123);
        assert_eq!(iso(t), "2026-11-10T15:04:05.123Z");
        // A leap day.
        let t = UNIX_EPOCH + Duration::from_hours(264_384);
        assert_eq!(iso(t), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn reads_what_it_writes() {
        for ms in [0, 951_782_400_000, 1_794_323_045_123, 1_794_323_045_100] {
            let t = UNIX_EPOCH + Duration::from_millis(ms);
            assert_eq!(parse_iso(&iso(t)), Some(t));
        }
        assert_eq!(
            parse_iso("2026-11-09T13:00:00Z"),
            parse_iso("2026-11-09T13:00:00.000Z")
        );
        for bad in [
            "",
            "soon",
            "2026-11-09",
            "2026-13-01T00:00:00Z",
            "2026-11-09T13:00:00",
            "2026-11-09T13:00:00.1234Z",
        ] {
            assert_eq!(parse_iso(bad), None, "{bad}");
        }
    }

    #[test]
    fn formats_like_systemctl() {
        // 1794322800 is Tue 2026-11-10 15:00:00 UTC.
        let usec = 1_794_322_800_000_000;
        assert_eq!(systemd(usec, &Zone::utc()), "Tue 2026-11-10 15:00:00 UTC");
        assert_eq!(systemd(0, &Zone::utc()), "");
        assert_eq!(systemd(1, &Zone::utc()), "Thu 1970-01-01 00:00:00 UTC");
    }

    /// A hand-made `TZif` v2 file: London's switch to summer time on 29 March 2026.
    fn london() -> Vec<u8> {
        let mut b = Vec::new();
        let header = |b: &mut Vec<u8>, timecnt: u32, typecnt: u32, charcnt: u32| {
            b.extend_from_slice(b"TZif2");
            b.extend_from_slice(&[0; 15]);
            for n in [0, 0, 0, timecnt, typecnt, charcnt] {
                b.extend_from_slice(&n.to_be_bytes());
            }
        };
        // An empty v1 block, then the 64-bit one.
        header(&mut b, 0, 1, 1);
        b.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0]);
        header(&mut b, 1, 2, 9);
        b.extend_from_slice(&1_774_746_000_i64.to_be_bytes());
        b.push(1);
        b.extend_from_slice(&0_i32.to_be_bytes());
        b.extend_from_slice(&[0, 0]);
        b.extend_from_slice(&3600_i32.to_be_bytes());
        b.extend_from_slice(&[1, 4]);
        b.extend_from_slice(b"GMT\0BST\0\0");
        b
    }

    #[test]
    fn follows_the_time_zone() {
        let zone = Zone::parse(&london()).unwrap();
        // Before the change, GMT; after it, BST, an hour ahead.
        assert_eq!(
            systemd(1_774_745_999_000_000, &zone),
            "Sun 2026-03-29 00:59:59 GMT"
        );
        assert_eq!(
            systemd(1_774_746_000_000_000, &zone),
            "Sun 2026-03-29 02:00:00 BST"
        );
        assert_eq!(Zone::parse(b"not a zone"), None);
        assert_eq!(Zone::parse(&london()[..60]), None);
    }
}
