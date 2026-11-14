//! A small reader for Minecraft's binary NBT format, as used in chunk data.
//!
//! It reads the whole tree into memory. Chunk data is untrusted (anyone with a world upload
//! can craft it), so every length is checked against the bytes left, nesting is capped, and
//! nothing here can panic on bad input.

use std::fmt;

/// How deep compounds and lists may nest. Vanilla caps this at 512 too.
const MAX_DEPTH: usize = 512;

/// One NBT value.
#[derive(Debug, Clone, PartialEq)]
pub enum Tag {
    Byte(i8),
    Short(i16),
    Int(i32),
    Long(i64),
    Float(f32),
    Double(f64),
    ByteArray(Vec<u8>),
    String(String),
    List(Vec<Self>),
    Compound(Vec<(String, Self)>),
    IntArray(Vec<i32>),
    LongArray(Vec<i64>),
}

impl Tag {
    /// A field of a compound.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Compound(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// A whole number of any width that fits in an `i32`.
    #[must_use]
    pub fn as_i32(&self) -> Option<i32> {
        match *self {
            Self::Byte(n) => Some(n.into()),
            Self::Short(n) => Some(n.into()),
            Self::Int(n) => Some(n),
            Self::Long(n) => i32::try_from(n).ok(),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(s) => Some(s),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_list(&self) -> Option<&[Self]> {
        match self {
            Self::List(items) => Some(items),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_longs(&self) -> Option<&[i64]> {
        match self {
            Self::LongArray(longs) => Some(longs),
            _ => None,
        }
    }
}

/// Why some NBT couldn't be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub &'static str);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "bad NBT: {}", self.0)
    }
}

impl std::error::Error for Error {}

/// Reads a named root compound, as stored in region files. The root's name is dropped.
///
/// # Errors
///
/// When the bytes aren't well-formed NBT with a compound at the root.
pub fn parse(bytes: &[u8]) -> Result<Tag, Error> {
    let mut r = Reader { bytes, pos: 0 };
    if r.u8()? != 10 {
        return Err(Error("the root isn't a compound"));
    }
    r.string()?;
    r.payload(10, 0)
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    const fn left(&self) -> usize {
        self.bytes.len() - self.pos
    }

    fn take(&mut self, n: usize) -> Result<&[u8], Error> {
        if n > self.left() {
            return Err(Error("ends early"));
        }
        let out = &self.bytes[self.pos..self.pos + n];
        self.pos += n;
        Ok(out)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], Error> {
        let mut out = [0; N];
        out.copy_from_slice(self.take(N)?);
        Ok(out)
    }

    fn u8(&mut self) -> Result<u8, Error> {
        Ok(self.array::<1>()?[0])
    }

    fn i32(&mut self) -> Result<i32, Error> {
        Ok(i32::from_be_bytes(self.array()?))
    }

    /// A length prefix, checked against what's left so a bad one can't make us allocate
    /// gigabytes. `each` is the smallest an element can be.
    fn len(&mut self, each: usize) -> Result<usize, Error> {
        let n = usize::try_from(self.i32()?).map_err(|_| Error("negative length"))?;
        if n.saturating_mul(each) > self.left() {
            return Err(Error("length runs past the end"));
        }
        Ok(n)
    }

    fn string(&mut self) -> Result<String, Error> {
        let n = u16::from_be_bytes(self.array()?);
        // Java's modified UTF-8 only differs for NUL and characters outside the BMP, which
        // block and biome names never use.
        Ok(String::from_utf8_lossy(self.take(n.into())?).into_owned())
    }

    fn payload(&mut self, kind: u8, depth: usize) -> Result<Tag, Error> {
        if depth > MAX_DEPTH {
            return Err(Error("nested too deeply"));
        }
        Ok(match kind {
            1 => Tag::Byte(i8::from_be_bytes(self.array()?)),
            2 => Tag::Short(i16::from_be_bytes(self.array()?)),
            3 => Tag::Int(self.i32()?),
            4 => Tag::Long(i64::from_be_bytes(self.array()?)),
            5 => Tag::Float(f32::from_be_bytes(self.array()?)),
            6 => Tag::Double(f64::from_be_bytes(self.array()?)),
            7 => {
                let n = self.len(1)?;
                Tag::ByteArray(self.take(n)?.to_vec())
            }
            8 => Tag::String(self.string()?),
            9 => {
                let item = self.u8()?;
                let n = self.len(min_size(item))?;
                if item == 0 && n > 0 {
                    return Err(Error("a list of nothing with items"));
                }
                let mut items = Vec::with_capacity(n);
                for _ in 0..n {
                    items.push(self.payload(item, depth + 1)?);
                }
                Tag::List(items)
            }
            10 => {
                let mut fields = Vec::new();
                loop {
                    let field = self.u8()?;
                    if field == 0 {
                        break;
                    }
                    let name = self.string()?;
                    fields.push((name, self.payload(field, depth + 1)?));
                }
                Tag::Compound(fields)
            }
            11 => {
                let n = self.len(4)?;
                let raw = self.take(n * 4)?;
                Tag::IntArray(
                    raw.chunks_exact(4)
                        .map(|b| i32::from_be_bytes([b[0], b[1], b[2], b[3]]))
                        .collect(),
                )
            }
            12 => {
                let n = self.len(8)?;
                let raw = self.take(n * 8)?;
                Tag::LongArray(
                    raw.chunks_exact(8)
                        .map(|b| {
                            i64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])
                        })
                        .collect(),
                )
            }
            _ => return Err(Error("unknown tag type")),
        })
    }
}

/// The fewest bytes one payload of this type takes.
const fn min_size(kind: u8) -> usize {
    match kind {
        2 | 8 => 2,
        3 | 5 | 7 | 9 | 11 | 12 => 4,
        4 | 6 => 8,
        // Bytes take one; an empty compound takes its end byte.
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_small_tree() {
        // {"": {"a": 5b, "b": "hi", "c": [1L, 2L]}} with a long array instead of a list.
        let mut b = vec![10, 0, 0];
        b.extend([1, 0, 1, b'a', 5]);
        b.extend([8, 0, 1, b'b', 0, 2, b'h', b'i']);
        b.extend([12, 0, 1, b'c', 0, 0, 0, 2]);
        b.extend(1i64.to_be_bytes());
        b.extend(2i64.to_be_bytes());
        b.push(0);
        let tag = parse(&b).unwrap();
        assert_eq!(tag.get("a").and_then(Tag::as_i32), Some(5));
        assert_eq!(tag.get("b").and_then(Tag::as_str), Some("hi"));
        assert_eq!(tag.get("c").and_then(Tag::as_longs), Some(&[1, 2][..]));
        assert_eq!(tag.get("d"), None);
    }

    #[test]
    fn refuses_lengths_past_the_end() {
        // A long array that claims a billion entries.
        let b = [10, 0, 0, 12, 0, 1, b'c', 0x3b, 0x9a, 0xca, 0x00, 0];
        assert!(parse(&b).is_err());
    }

    #[test]
    fn refuses_deep_nesting() {
        let mut b = vec![10, 0, 0];
        for _ in 0..1000 {
            b.extend([10, 0, 0]);
        }
        assert_eq!(parse(&b), Err(Error("nested too deeply")));
    }

    #[test]
    fn never_panics_on_noise() {
        // A cheap generator: no dependency for random bytes.
        let mut seed = 0x2545_f491_4f6c_dd1d_u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _ in 0..20_000 {
            let len = usize::try_from(next() % 64).unwrap();
            let mut b: Vec<u8> = (0..len).map(|_| next().to_le_bytes()[0] % 14).collect();
            if let Some(first) = b.first_mut() {
                *first = 10;
            }
            let _ = parse(&b);
        }
    }
}
