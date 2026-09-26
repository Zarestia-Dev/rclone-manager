//! Zero-dependency Semantic Version parsing and comparison utilities.
//!
//! Provides natural numeric sorting for multi-digit version segments,
//! SemVer pre-release comparisons (`alpha` < `beta` < `rc` < `stable`),
//! and safe normalization for repository release tags (`headless-`, `v`, `+metadata`).

pub fn clean_app_version(tag: &str) -> &str {
    let tag = tag.strip_prefix("headless-").unwrap_or(tag);
    let tag = tag.strip_prefix('v').unwrap_or(tag);
    tag.split_once('+').map(|(c, _)| c).unwrap_or(tag)
}

pub fn split_version_parts(v: &str) -> ((u32, u32, u32), Option<&str>) {
    let (core_str, pre_str) = if let Some((c, p)) = v.split_once('-') {
        (c, Some(p))
    } else if let Some(idx) = v.find(|c: char| !c.is_ascii_digit() && c != '.') {
        let (c, p) = v.split_at(idx);
        let c = c.trim_end_matches('.');
        let p = p.trim_start_matches(['.', '-']);
        (c, if p.is_empty() { None } else { Some(p) })
    } else {
        (v, None)
    };

    let mut parts = core_str.split('.').filter_map(|p| p.parse::<u32>().ok());
    let core = (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    );

    (core, pre_str)
}

#[derive(Debug, PartialEq, Eq)]
enum PreToken<'a> {
    Num(u32),
    Str(&'a str),
}

impl PartialOrd for PreToken<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for PreToken<'_> {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match (self, other) {
            (PreToken::Num(a), PreToken::Num(b)) => a.cmp(b),
            (PreToken::Str(a), PreToken::Str(b)) => {
                let a_lower = a.to_ascii_lowercase();
                let b_lower = b.to_ascii_lowercase();
                a_lower.cmp(&b_lower)
            }
            (PreToken::Num(_), PreToken::Str(_)) => std::cmp::Ordering::Less,
            (PreToken::Str(_), PreToken::Num(_)) => std::cmp::Ordering::Greater,
        }
    }
}

fn tokenize_prerelease(pre: &str) -> Vec<PreToken<'_>> {
    let mut tokens = Vec::new();
    let mut start = 0;
    let bytes = pre.as_bytes();
    let len = bytes.len();

    let mut i = 0;
    while i < len {
        let b = bytes[i];
        if b == b'.' || b == b'-' || b == b'_' {
            if i > start {
                let segment = &pre[start..i];
                if let Ok(num) = segment.parse::<u32>() {
                    tokens.push(PreToken::Num(num));
                } else {
                    tokens.push(PreToken::Str(segment));
                }
            }
            i += 1;
            start = i;
            continue;
        }

        // Split transition between digits and ASCII letters (e.g. "beta1" -> "beta", 1)
        if i + 1 < len {
            let next_b = bytes[i + 1];
            let is_digit_curr = b.is_ascii_digit();
            let is_digit_next = next_b.is_ascii_digit();
            if is_digit_curr != is_digit_next && next_b != b'.' && next_b != b'-' && next_b != b'_'
            {
                let segment = &pre[start..=i];
                if let Ok(num) = segment.parse::<u32>() {
                    tokens.push(PreToken::Num(num));
                } else {
                    tokens.push(PreToken::Str(segment));
                }
                start = i + 1;
            }
        }
        i += 1;
    }

    if start < len {
        let segment = &pre[start..];
        if let Ok(num) = segment.parse::<u32>() {
            tokens.push(PreToken::Num(num));
        } else {
            tokens.push(PreToken::Str(segment));
        }
    }

    tokens
}

fn compare_prerelease(a: &str, b: &str) -> std::cmp::Ordering {
    let a_tokens = tokenize_prerelease(a);
    let b_tokens = tokenize_prerelease(b);

    for (t1, t2) in a_tokens.iter().zip(b_tokens.iter()) {
        let cmp = t1.cmp(t2);
        if cmp != std::cmp::Ordering::Equal {
            return cmp;
        }
    }
    a_tokens.len().cmp(&b_tokens.len())
}

/// Checks whether `target` is strictly newer than `current`.
///
/// Handles natural number comparisons, release channels, pre-releases, and build metadata.
pub fn is_version_newer(current: &str, target: &str) -> bool {
    let current_clean = clean_app_version(current);
    let target_clean = clean_app_version(target);

    let (curr_core, curr_pre) = split_version_parts(current_clean);
    let (tgt_core, tgt_pre) = split_version_parts(target_clean);

    if tgt_core != curr_core {
        return tgt_core > curr_core;
    }

    match (curr_pre, tgt_pre) {
        (Some(_), None) => true,
        (None, Some(_)) => false,
        (Some(cp), Some(tp)) => compare_prerelease(tp, cp).is_gt(),
        (None, None) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clean_app_version() {
        assert_eq!(clean_app_version("v0.3.3"), "0.3.3");
        assert_eq!(clean_app_version("0.3.3"), "0.3.3");
        assert_eq!(clean_app_version("headless-v0.3.4"), "0.3.4");
        assert_eq!(clean_app_version("headless-0.3.4"), "0.3.4");
        assert_eq!(clean_app_version("v1.0.0-beta.1"), "1.0.0-beta.1");
        assert_eq!(clean_app_version("v1.0.0+build.42"), "1.0.0");
    }

    #[test]
    fn test_is_version_newer() {
        // Standard core version jumps
        assert!(is_version_newer("0.3.3", "0.3.4"));
        assert!(is_version_newer("v0.3.3", "v0.3.4"));
        assert!(is_version_newer("0.3.3", "headless-v0.3.4"));
        assert!(!is_version_newer("0.3.4", "0.3.3"));
        assert!(!is_version_newer("0.3.3", "0.3.3"));
        assert!(is_version_newer("0.3.3", "0.4.0"));
        assert!(is_version_newer("0.3.3", "1.0.0"));
        assert!(!is_version_newer("1.0.0", "0.9.9"));

        // Multi-digit components (avoiding string-sorting pitfalls)
        assert!(is_version_newer("0.3.4", "0.3.10"));
        assert!(!is_version_newer("0.3.10", "0.3.4"));
        assert!(is_version_newer("0.9.0", "0.10.0"));
        assert!(!is_version_newer("0.10.0", "0.9.0"));

        // Beta to stable (stable is strictly newer than any beta of the same core version)
        assert!(is_version_newer("0.1.0-beta", "0.1.0"));
        assert!(is_version_newer("v0.1.0-beta", "v0.1.0"));
        assert!(is_version_newer("0.3.3-beta.1", "0.3.3"));
        assert!(!is_version_newer("0.3.3", "0.3.3-beta.1"));
        assert!(!is_version_newer("0.1.0", "0.1.0-beta"));

        // Pre-release numeric iterations
        assert!(is_version_newer("0.3.3-beta.1", "0.3.3-beta.2"));
        assert!(is_version_newer("0.3.3-beta.1", "0.3.3-beta.10"));
        assert!(!is_version_newer("0.3.3-beta.10", "0.3.3-beta.2"));

        // Pre-release with attached numbers without dots (beta1 vs beta10)
        assert!(is_version_newer("0.3.3-beta1", "0.3.3-beta2"));
        assert!(is_version_newer("0.3.3-beta2", "0.3.3-beta10"));
        assert!(!is_version_newer("0.3.3-beta10", "0.3.3-beta2"));

        // Pre-release with hyphens or underscores
        assert!(is_version_newer("0.3.3-beta-1", "0.3.3-beta-2"));
        assert!(is_version_newer("0.3.3-beta-2", "0.3.3-beta-10"));
        assert!(is_version_newer("0.3.3-beta_1", "0.3.3-beta_2"));

        // Pre-release attached directly to core (e.g. 0.3.3beta1)
        assert!(is_version_newer("0.3.3beta1", "0.3.3beta2"));
        assert!(is_version_newer("0.3.3beta1", "0.3.3"));

        // Different pre-release lifecycle stages (alpha < beta < rc < stable)
        assert!(is_version_newer("0.3.3-alpha.1", "0.3.3-beta.1"));
        assert!(is_version_newer("0.3.3-beta.1", "0.3.3-rc.1"));
        assert!(is_version_newer("0.3.3-rc.1", "0.3.3"));

        // Case-insensitivity in pre-release labels
        assert!(is_version_newer("0.3.3-Beta.1", "0.3.3-beta.2"));
        assert!(is_version_newer("0.3.3-BETA.1", "0.3.3-beta.10"));

        // Real repository historical tags
        assert!(is_version_newer("v0.1.0-beta", "v0.1.1-beta"));
        assert!(is_version_newer("v0.1.3-beta", "v0.1.4"));
        assert!(is_version_newer("headless-v0.1.8", "headless-v0.3.3"));

        // Build metadata ignored
        assert!(is_version_newer("0.3.3+build1", "0.3.4"));
        assert!(!is_version_newer("0.3.3", "0.3.3+build2"));
    }
}
