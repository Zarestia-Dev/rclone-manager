use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::str::FromStr;

/// Strongly-typed origin for operations and notifications.
/// Keeps known origins explicit and preserves unknown values in `Other`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    Ui,
    Tray,
    Internal,
    Nautilus,
    Dashboard,
    Scheduled,
    System,
    Api,
    Other(String),
}

impl Origin {
    pub fn as_str(&self) -> &str {
        match self {
            Origin::Ui => "ui",
            Origin::Tray => "tray",
            Origin::Internal => "internal",
            Origin::Nautilus => "nautilus",
            Origin::Dashboard => "dashboard",
            Origin::Scheduled => "scheduled",
            Origin::System => "system",
            Origin::Api => "api",
            Origin::Other(s) => s.as_str(),
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "ui" => Origin::Ui,
            "tray" => Origin::Tray,
            "internal" => Origin::Internal,
            "nautilus" => Origin::Nautilus,
            "dashboard" => Origin::Dashboard,
            "scheduled" => Origin::Scheduled,
            "system" => Origin::System,
            "api" => Origin::Api,
            other => Origin::Other(other.to_string()),
        }
    }
}

impl fmt::Display for Origin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl FromStr for Origin {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Origin::parse(s))
    }
}

impl From<String> for Origin {
    fn from(s: String) -> Self {
        Origin::parse(&s)
    }
}

impl From<&str> for Origin {
    fn from(s: &str) -> Self {
        Origin::parse(s)
    }
}

impl Serialize for Origin {
    fn serialize<S: Serializer>(
        &self,
        serializer: S,
    ) -> Result<<S as Serializer>::Ok, <S as Serializer>::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Origin {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Ok(Origin::parse(&s))
    }
}
