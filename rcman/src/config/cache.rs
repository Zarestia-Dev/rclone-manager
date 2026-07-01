//! Cache management types

/// Cache strategy for settings components
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CacheStrategy {
    /// Always cache everything (default)
    #[default]
    Full,
    /// LRU cache with maximum entries
    Lru(usize),
    /// No caching - always read from disk (high I/O, minimal memory)
    None,
}

impl CacheStrategy {
    /// Validate cache strategy configuration
    ///
    /// # Errors
    ///
    /// Returns error if LRU size is 0 (would panic on `NonZeroUsize`)
    pub fn validate(&self) -> crate::Result<()> {
        match self {
            CacheStrategy::Lru(size) if *size == 0 => Err(crate::Error::Config(
                "LRU cache size must be greater than 0".into(),
            )),
            _ => Ok(()),
        }
    }
}
