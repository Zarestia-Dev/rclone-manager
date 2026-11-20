/// The deployment declared by `RCLONE_MANAGER_INSTALLATION_TYPE`, or a container when
/// the runtime marks one (Docker and Podman). Other runtimes may leave neither marker
/// and need the variable. An updated executable inside a container would be lost when
/// the container is recreated.
pub fn deployment_type() -> Option<String> {
    std::env::var("RCLONE_MANAGER_INSTALLATION_TYPE")
        .ok()
        .or_else(|| {
            ["/.dockerenv", "/run/.containerenv"]
                .iter()
                .any(|marker| std::path::Path::new(marker).exists())
                .then(|| "container".to_owned())
        })
}

#[must_use]
pub fn is_librclone() -> bool {
    cfg!(feature = "librclone")
}

/// The names other devices can use to reach this machine.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAddresses {
    pub host_name: Option<String>,
    /// IPv4 addresses of the network interfaces, a home or office network first.
    pub addresses: Vec<String>,
}

/// An address another device on the network can use: IPv4, and not loopback, link-local,
/// unspecified or multicast.
fn is_reachable(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            !(v4.is_loopback() || v4.is_link_local() || v4.is_unspecified() || v4.is_multicast())
        }
        std::net::IpAddr::V6(_) => false,
    }
}

/// Interfaces that exist for containers, virtual machines and tunnels. A phone on the home network
/// cannot reach an address on them.
fn is_virtual_interface(name: &str) -> bool {
    const PREFIXES: [&str; 22] = [
        "docker",
        "br-",
        "virbr",
        "vmnet",
        "vboxnet",
        "veth",
        "lxc",
        "lxd",
        "cni",
        "flannel",
        "cali",
        "podman",
        "tun",
        "tap",
        "utun",
        "awdl",
        "llw",
        "bridge",
        "vethernet",
        "anpi",
        "gif",
        "stf",
    ];
    const PARTS: [&str; 3] = ["vmware", "virtualbox", "hyper-v"];
    let name = name.to_ascii_lowercase();
    PREFIXES.iter().any(|prefix| name.starts_with(prefix))
        || PARTS.iter().any(|part| name.contains(part))
}

/// The address this machine reaches the outside with: the one of the interface that has the
/// default route. Connecting a UDP socket sends nothing, it only picks the route.
fn outbound_address() -> Option<std::net::IpAddr> {
    let socket = std::net::UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    socket.connect(("192.0.2.1", 9)).ok()?;
    socket.local_addr().ok().map(|address| address.ip())
}

/// The addresses a device on the network can use, best first: the one of the interface with the
/// default route, then those of the other real interfaces, private ranges (`192.168.x.x`,
/// `10.x.x.x`, `172.16-31.x.x`) before public ones. Interfaces of containers and virtual machines
/// are left out; each address is listed once.
pub fn lan_addresses<I>(primary: Option<std::net::IpAddr>, interfaces: I) -> Vec<String>
where
    I: IntoIterator<Item = (String, std::net::IpAddr)>,
{
    let mut others: Vec<std::net::Ipv4Addr> = interfaces
        .into_iter()
        .filter(|(name, ip)| !is_virtual_interface(name) && is_reachable(ip))
        .filter_map(|(_, ip)| match ip {
            std::net::IpAddr::V4(v4) => Some(v4),
            std::net::IpAddr::V6(_) => None,
        })
        .collect();
    others.sort_by_key(|ip| (!ip.is_private(), *ip));

    let mut found: Vec<std::net::Ipv4Addr> = Vec::new();
    if let Some(std::net::IpAddr::V4(ip)) = primary.filter(is_reachable) {
        found.push(ip);
    }
    for ip in others {
        if !found.contains(&ip) {
            found.push(ip);
        }
    }
    found.into_iter().map(|ip| ip.to_string()).collect()
}

/// The host name and network addresses of the machine the backend runs on, for telling a phone
/// or a TV where a share is.
pub fn get_local_addresses() -> Result<LocalAddresses, String> {
    let networks = sysinfo::Networks::new_with_refreshed_list();
    let interfaces = networks.iter().flat_map(|(name, data)| {
        data.ip_networks()
            .iter()
            .map(|network| (name.clone(), network.addr))
    });
    Ok(LocalAddresses {
        host_name: sysinfo::System::host_name().filter(|name| !name.trim().is_empty()),
        addresses: lan_addresses(outbound_address(), interfaces),
    })
}

#[cfg(test)]
mod local_address_tests {
    use super::*;
    use std::net::IpAddr;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    fn named(list: &[(&str, &str)]) -> Vec<(String, IpAddr)> {
        list.iter()
            .map(|(name, address)| ((*name).to_string(), ip(address)))
            .collect()
    }

    #[test]
    fn drops_loopback_link_local_unspecified_multicast_and_ipv6() {
        let found = lan_addresses(
            None,
            named(&[
                ("lo", "127.0.0.1"),
                ("wlan0", "169.254.10.4"),
                ("wlan0", "0.0.0.0"),
                ("wlan0", "224.0.0.1"),
                ("wlan0", "fe80::1"),
                ("wlan0", "::1"),
                ("wlan0", "192.168.1.20"),
            ]),
        );
        assert_eq!(found, vec!["192.168.1.20"]);
    }

    #[test]
    fn leaves_out_container_and_virtual_machine_interfaces() {
        let found = lan_addresses(
            None,
            named(&[
                ("docker0", "172.17.0.1"),
                ("br-1a2b3c", "172.18.0.1"),
                ("virbr0", "192.168.122.1"),
                ("vmnet8", "172.16.229.1"),
                ("vboxnet0", "192.168.56.1"),
                ("veth12ab", "172.19.0.1"),
                ("vEthernet (Default Switch)", "172.20.0.1"),
                ("VMware Network Adapter VMnet1", "192.168.117.1"),
                ("wlan0", "192.168.1.104"),
            ]),
        );
        assert_eq!(found, vec!["192.168.1.104"]);
    }

    #[test]
    fn keeps_real_interfaces_of_every_system() {
        for name in [
            "wlan0", "eth0", "enp3s0", "wlp2s0", "en0", "Wi-Fi", "Ethernet",
        ] {
            assert_eq!(
                lan_addresses(None, named(&[(name, "192.168.1.20")])),
                vec!["192.168.1.20"],
                "{name}"
            );
        }
    }

    #[test]
    fn puts_the_address_with_the_default_route_first() {
        let found = lan_addresses(
            Some(ip("192.168.1.104")),
            named(&[("eth0", "10.0.0.5"), ("wlan0", "192.168.1.104")]),
        );
        assert_eq!(found, vec!["192.168.1.104", "10.0.0.5"]);
    }

    #[test]
    fn keeps_the_default_route_address_even_on_an_odd_interface() {
        let found = lan_addresses(Some(ip("10.8.0.2")), named(&[("tun0", "10.8.0.2")]));
        assert_eq!(found, vec!["10.8.0.2"]);
    }

    #[test]
    fn puts_private_networks_before_public_ones_in_numeric_order() {
        let found = lan_addresses(
            None,
            named(&[
                ("eth0", "8.8.4.4"),
                ("eth1", "192.168.1.20"),
                ("eth2", "10.0.0.5"),
                ("eth3", "172.20.0.9"),
            ]),
        );
        assert_eq!(
            found,
            vec!["10.0.0.5", "172.20.0.9", "192.168.1.20", "8.8.4.4"]
        );
    }

    #[test]
    fn lists_an_address_once() {
        let found = lan_addresses(
            Some(ip("192.168.1.20")),
            named(&[("wlan0", "192.168.1.20"), ("eth0", "192.168.1.20")]),
        );
        assert_eq!(found, vec!["192.168.1.20"]);
    }

    #[test]
    fn has_no_address_for_no_interface() {
        assert!(lan_addresses(None, Vec::new()).is_empty());
        assert!(lan_addresses(Some(ip("127.0.0.1")), Vec::new()).is_empty());
    }

    #[test]
    fn reading_the_machine_never_fails() {
        let local = get_local_addresses().unwrap();
        assert!(
            local
                .addresses
                .iter()
                .all(|a| a.parse::<std::net::Ipv4Addr>().is_ok())
        );
    }
}
