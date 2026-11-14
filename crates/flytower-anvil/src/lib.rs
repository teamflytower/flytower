//! Minecraft's Anvil world format, for Flytower's world tools (`flytower-map`,
//! `flytower-world`): region files, the NBT inside them, and where each dimension keeps its
//! files. Everything here treats the world as untrusted input and never panics on it.

pub mod nbt;
pub mod region;
pub mod world;
