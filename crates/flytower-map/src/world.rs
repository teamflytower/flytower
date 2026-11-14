//! Which dimensions to draw, and how. Finding them is shared with `flytower-world`, in
//! [`flytower_anvil::world`].

use std::path::{Path, PathBuf};

pub use flytower_anvil::world::{Dimension, dimensions};

use crate::draw::Style;

/// What the map needs to know about a dimension beyond where its files are.
pub trait MapDimension {
    /// How this dimension is drawn.
    fn style(&self) -> Style;

    /// Where its tiles go, relative to the output folder.
    fn tiles(&self) -> PathBuf;
}

impl MapDimension for Dimension {
    fn style(&self) -> Style {
        Style {
            ceiling: (self.id == "minecraft:the_nether").then_some(127),
        }
    }

    fn tiles(&self) -> PathBuf {
        Path::new("tiles").join(&self.namespace).join(&self.name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dim(namespace: &str, name: &str) -> Dimension {
        Dimension {
            id: format!("{namespace}:{name}"),
            namespace: namespace.into(),
            name: name.into(),
            regions: PathBuf::from("region"),
        }
    }

    #[test]
    fn styles_and_tile_folders() {
        assert_eq!(dim("minecraft", "the_nether").style().ceiling, Some(127));
        assert_eq!(dim("minecraft", "overworld").style().ceiling, None);
        assert_eq!(dim("mod", "sky").tiles(), Path::new("tiles/mod/sky"));
    }
}
