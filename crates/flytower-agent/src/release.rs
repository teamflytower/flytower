//! Checking Flytower releases. The key is the one the
//! installer embeds, built in at compile time. Only SHA256SUMS is signed: it covers every
//! archive.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use ed25519_dalek::{Signature, VerifyingKey};

/// The release signing key, as a PEM `PUBLIC KEY`.
pub const RELEASE_KEY: &str = include_str!("../../../installer/release-key.pem");

/// The DER prefix of an Ed25519 `SubjectPublicKeyInfo`; the raw key's 32 bytes follow it.
const SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// The raw key from a PEM `PUBLIC KEY` holding an Ed25519 key, or `None` for anything else.
fn public_key(pem: &str) -> Option<VerifyingKey> {
    let body: String = pem
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("-----"))
        .collect();
    let (header, footer) = ("-----BEGIN PUBLIC KEY-----", "-----END PUBLIC KEY-----");
    if !pem.contains(header) || !pem.contains(footer) {
        return None;
    }
    let der = STANDARD.decode(body).ok()?;
    let raw: [u8; 32] = der.strip_prefix(&SPKI_PREFIX)?.try_into().ok()?;
    VerifyingKey::from_bytes(&raw).ok()
}

/// True if `signature` (base64) is a valid Ed25519 signature of `sums` by `key_pem`.
#[must_use]
pub fn verify_sums(sums: &[u8], signature: &str, key_pem: &str) -> bool {
    let Some(key) = public_key(key_pem) else {
        return false;
    };
    let Ok(sig) = STANDARD.decode(signature.trim()) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(&sig) else {
        return false;
    };
    key.verify_strict(sums, &sig).is_ok()
}

/// The expected SHA-256 for `file` from a SHA256SUMS text, or `None`.
#[must_use]
pub fn sum_for<'a>(sums: &'a str, file: &str) -> Option<&'a str> {
    sums.lines().find_map(|line| {
        let line = line.trim();
        let (hash, rest) = line.split_at_checked(64)?;
        if !hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return None;
        }
        // At least one space, then an optional `*` (binary mode).
        let name = rest.strip_prefix(char::is_whitespace)?.trim_start();
        let name = name.strip_prefix('*').unwrap_or(name);
        (name == file).then_some(hash)
    })
}

#[cfg(test)]
#[allow(
    clippy::must_use_candidate,
    clippy::missing_panics_doc,
    reason = "test helpers, shared with other modules' tests, may panic and needn't be used"
)]
pub mod tests {
    use ed25519_dalek::{Signer, SigningKey};

    use super::*;

    /// A fixed test key pair, so tests need no randomness.
    pub fn test_key() -> (SigningKey, String) {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let mut der = SPKI_PREFIX.to_vec();
        der.extend_from_slice(signing.verifying_key().as_bytes());
        let pem = format!(
            "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n",
            STANDARD.encode(der)
        );
        (signing, pem)
    }

    pub fn sign(key: &SigningKey, data: &[u8]) -> String {
        STANDARD.encode(key.sign(data).to_bytes())
    }

    #[test]
    fn the_built_in_key_parses() {
        assert!(public_key(RELEASE_KEY).is_some());
    }

    #[test]
    fn verifies_signatures() {
        let (key, pem) = test_key();
        let sums = b"abc  flytower-1.0.0-linux-amd64.tar.gz\n";
        let sig = sign(&key, sums);
        assert!(verify_sums(sums, &sig, &pem));
        assert!(verify_sums(sums, &format!("{sig}\n"), &pem));
        assert!(!verify_sums(b"abd", &sig, &pem));
        assert!(!verify_sums(sums, &sig, RELEASE_KEY));
        assert!(!verify_sums(sums, "not base64!", &pem));
        assert!(!verify_sums(
            sums,
            &sig,
            "-----BEGIN PUBLIC KEY-----\nPENDING\n"
        ));
    }

    #[test]
    fn accepts_what_node_signs() {
        // Made with node:crypto, as release.ts and the release workflow's openssl do.
        let pem = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAIbQt7x8L3YvWTaW+fkonrkb6JtMRv4w4KfqUA5faZdI=\n-----END PUBLIC KEY-----\n";
        let sig = "E6WU0Rc1R/67WO8UY5342Riky8J5Pxui+xpAW57V30RV2e5821Q76shJhpQTOtBZIFyjAYJxShrPDeuGbmBiDA==";
        let sums = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  flytower-0.5.0-linux-amd64.tar.gz\n";
        assert!(verify_sums(sums.as_bytes(), sig, pem));
        assert!(!verify_sums(sums.trim_end().as_bytes(), sig, pem));
    }

    #[test]
    fn finds_sums() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        let sums = format!(
            "{a}  one.tar.gz\n{b} *two.tar.gz\n{}  three\n",
            "A".repeat(64)
        );
        assert_eq!(sum_for(&sums, "one.tar.gz"), Some(a.as_str()));
        assert_eq!(sum_for(&sums, "two.tar.gz"), Some(b.as_str()));
        assert_eq!(sum_for(&sums, "three"), None);
        assert_eq!(sum_for(&sums, "four"), None);
    }
}
