//! HTTP address formatting shared by the listener, CORS, and native tray links.
use std::net::{AddrParseError, IpAddr, SocketAddr};

fn unbracket(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host)
}

pub(crate) fn listen_address(host: &str, port: u16) -> Result<SocketAddr, AddrParseError> {
    Ok(SocketAddr::new(unbracket(host).parse()?, port))
}

pub(crate) fn browser_origin(host: &str, port: u16, tls: bool) -> String {
    let host = match unbracket(host).parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) if ip.is_unspecified() => "127.0.0.1".to_string(),
        Ok(IpAddr::V6(ip)) if ip.is_unspecified() => "[::1]".to_string(),
        Ok(IpAddr::V6(ip)) => format!("[{ip}]"),
        _ => host.to_string(),
    };
    let scheme = if tls { "https" } else { "http" };
    format!("{scheme}://{host}:{port}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listener_accepts_ipv4_and_both_ipv6_spellings() {
        for host in ["127.0.0.1", "::1", "[::1]", "::", "[::]"] {
            let address = listen_address(host, 8080).unwrap();
            assert_eq!(address.port(), 8080);
            assert_eq!(address.ip(), unbracket(host).parse::<IpAddr>().unwrap());
        }
        for host in ["", "invalid", "[::1", "127.0.0.1:80"] {
            assert!(listen_address(host, 8080).is_err());
        }
    }

    #[test]
    fn browser_origins_use_loopback_for_wildcards_and_bracket_ipv6() {
        for (host, expected) in [
            ("0.0.0.0", "127.0.0.1"),
            ("::", "[::1]"),
            ("[::]", "[::1]"),
            ("::1", "[::1]"),
            ("[::1]", "[::1]"),
            ("2001:db8::1", "[2001:db8::1]"),
            ("192.168.1.20", "192.168.1.20"),
            ("localhost", "localhost"),
        ] {
            assert_eq!(
                browser_origin(host, 8080, false),
                format!("http://{expected}:8080")
            );
            assert_eq!(
                browser_origin(host, 8443, true),
                format!("https://{expected}:8443")
            );
        }
    }
}
