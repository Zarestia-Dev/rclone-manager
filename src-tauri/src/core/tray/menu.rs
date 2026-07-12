use tauri::{
    AppHandle, Runtime,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
};

use super::tray_action::TrayAction;
use super::{TrayProfileSummary, TrayRemoteSummary, TraySnapshot};
use crate::t;
use crate::utils::types::remotes::OperationType;

#[derive(Debug, PartialEq, Clone)]
pub struct RegularItem {
    pub id: String,
    pub label: String,
    pub enabled: bool,
}

#[derive(Debug, PartialEq, Clone)]
pub struct CheckItem {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    pub checked: bool,
}

#[derive(Debug, PartialEq, Clone)]
pub struct SubmenuPlan {
    pub label: String,
    pub enabled: bool,
    pub items: Vec<MenuItemKind>,
}

#[derive(Debug, PartialEq, Clone)]
pub enum MenuItemKind {
    Regular(RegularItem),
    Check(CheckItem),
    Submenu(SubmenuPlan),
    Separator,
}

#[derive(PartialEq, Clone, Debug)]
pub struct MenuPlan {
    pub items: Vec<MenuItemKind>,
}

impl MenuPlan {
    pub fn build(snapshot: &TraySnapshot, max_tray_items: usize) -> Self {
        let mut items: Vec<MenuItemKind> = Vec::new();

        #[cfg(not(feature = "web-server"))]
        items.push(MenuItemKind::Regular(RegularItem {
            id: TrayAction::ShowApp.to_id(),
            label: t!("tray.showApp"),
            enabled: true,
        }));

        #[cfg(feature = "web-server")]
        items.push(MenuItemKind::Regular(RegularItem {
            id: TrayAction::OpenWebUI.to_id(),
            label: t!("tray.openWebUI"),
            enabled: true,
        }));

        items.push(MenuItemKind::Regular(RegularItem {
            id: TrayAction::OpenFileBrowser.to_id(),
            label: t!("tray.openFileBrowser"),
            enabled: true,
        }));

        items.push(MenuItemKind::Separator);

        let visible_remotes: Vec<&TrayRemoteSummary> = snapshot
            .remotes
            .iter()
            .filter(|r| r.show_on_tray)
            .take(max_tray_items)
            .collect();

        if !visible_remotes.is_empty() {
            for remote_summary in &visible_remotes {
                items.push(MenuItemKind::Submenu(build_remote_submenu(
                    remote_summary,
                    snapshot,
                )));
            }

            items.push(MenuItemKind::Separator);
            items.push(MenuItemKind::Regular(RegularItem {
                id: TrayAction::UnmountAll.to_id(),
                label: t!("tray.unmountAll"),
                enabled: true,
            }));
            items.push(MenuItemKind::Regular(RegularItem {
                id: TrayAction::StopAllJobs.to_id(),
                label: t!("tray.stopAllJobs"),
                enabled: true,
            }));
            items.push(MenuItemKind::Regular(RegularItem {
                id: TrayAction::StopAllServes.to_id(),
                label: t!("tray.stopAllServes"),
                enabled: true,
            }));
            items.push(MenuItemKind::Separator);
        }

        items.push(MenuItemKind::Regular(RegularItem {
            id: TrayAction::Quit.to_id(),
            label: t!("tray.quit"),
            enabled: true,
        }));

        Self { items }
    }
}

// Plan builders (pure data, off main thread)

struct ProfileSubmenuConfig {
    label_key: &'static str,
    start_label_key: &'static str,
    stop_label_key: &'static str,
    op: OperationType,
}

fn build_remote_submenu(
    remote_summary: &TrayRemoteSummary,
    snapshot: &TraySnapshot,
) -> SubmenuPlan {
    let remote = &remote_summary.name;
    let mut submenu_items: Vec<MenuItemKind> = Vec::new();

    let active_jobs_count = snapshot
        .active_jobs
        .iter()
        .filter(|j| j.remote_name == *remote)
        .count();

    let total_job_profiles = remote_summary.sync_profiles.len()
        + remote_summary.copy_profiles.len()
        + remote_summary.move_profiles.len()
        + remote_summary.bisync_profiles.len()
        + remote_summary.check_profiles.len()
        + remote_summary.delete_profiles.len()
        + remote_summary.copyurl_profiles.len()
        + remote_summary.archivecreate_profiles.len()
        + remote_summary.cryptcheck_profiles.len();

    let job_status_text = if total_job_profiles > 0 {
        t!(
            "tray.jobsCount",
            "active" => &active_jobs_count.to_string(),
            "total" => &total_job_profiles.to_string()
        )
    } else {
        t!("tray.jobsNone")
    };

    submenu_items.push(MenuItemKind::Check(CheckItem {
        id: format!("status__{remote}"),
        label: job_status_text,
        enabled: false,
        checked: active_jobs_count > 0,
    }));
    submenu_items.push(MenuItemKind::Separator);

    for action in &remote_summary.primary_actions {
        let (profiles, cfg) = match action.as_str() {
            "mount" => (
                remote_summary.mount_profiles.as_slice(),
                ProfileSubmenuConfig {
                    label_key: "tray.mountCount",
                    start_label_key: "tray.mount",
                    stop_label_key: "tray.unmount",
                    op: OperationType::Mount,
                },
            ),
            "sync" => (
                remote_summary.sync_profiles.as_slice(),
                ProfileSubmenuConfig {
                    label_key: "tray.syncCount",
                    start_label_key: "tray.start",
                    stop_label_key: "tray.stop",
                    op: OperationType::Sync,
                },
            ),
            "copy" => (
                remote_summary.copy_profiles.as_slice(),
                ProfileSubmenuConfig {
                    label_key: "tray.copyCount",
                    start_label_key: "tray.start",
                    stop_label_key: "tray.stop",
                    op: OperationType::Copy,
                },
            ),
            "move" => (
                remote_summary.move_profiles.as_slice(),
                ProfileSubmenuConfig {
                    label_key: "tray.moveCount",
                    start_label_key: "tray.start",
                    stop_label_key: "tray.stop",
                    op: OperationType::Move,
                },
            ),
            "bisync" => (
                remote_summary.bisync_profiles.as_slice(),
                ProfileSubmenuConfig {
                    label_key: "tray.bisyncCount",
                    start_label_key: "tray.start",
                    stop_label_key: "tray.stop",
                    op: OperationType::Bisync,
                },
            ),
            "check" => (
                remote_summary.check_profiles.as_slice(),
                ProfileSubmenuConfig {
                    label_key: "tray.checkCount",
                    start_label_key: "tray.start",
                    stop_label_key: "tray.stop",
                    op: OperationType::Check,
                },
            ),
            "delete" => (
                remote_summary.delete_profiles.as_slice(),
                ProfileSubmenuConfig {
                    label_key: "tray.deleteCount",
                    start_label_key: "tray.start",
                    stop_label_key: "tray.stop",
                    op: OperationType::Delete,
                },
            ),
            "copyurl" => (
                remote_summary.copyurl_profiles.as_slice(),
                ProfileSubmenuConfig {
                    label_key: "tray.copyurlCount",
                    start_label_key: "tray.start",
                    stop_label_key: "tray.stop",
                    op: OperationType::Copyurl,
                },
            ),
            "archivecreate" => (
                remote_summary.archivecreate_profiles.as_slice(),
                ProfileSubmenuConfig {
                    label_key: "tray.archivecreateCount",
                    start_label_key: "tray.start",
                    stop_label_key: "tray.stop",
                    op: OperationType::Archivecreate,
                },
            ),
            "cryptcheck" => (
                remote_summary.cryptcheck_profiles.as_slice(),
                ProfileSubmenuConfig {
                    label_key: "tray.cryptcheckCount",
                    start_label_key: "tray.start",
                    stop_label_key: "tray.stop",
                    op: OperationType::Cryptcheck,
                },
            ),
            "serve" => (
                remote_summary.serve_profiles.as_slice(),
                ProfileSubmenuConfig {
                    label_key: "tray.serveCount",
                    start_label_key: "tray.start",
                    stop_label_key: "tray.stop",
                    op: OperationType::Serve,
                },
            ),
            _ => continue,
        };
        submenu_items.push(MenuItemKind::Submenu(build_profile_submenu(
            remote, profiles, cfg,
        )));
    }

    submenu_items.push(MenuItemKind::Separator);

    let is_mounted = remote_summary.mount_profiles.iter().any(|p| p.is_active);
    let is_serving = remote_summary.serve_profiles.iter().any(|p| p.is_active);

    if is_mounted {
        let mounted_profiles: Vec<&TrayProfileSummary> = remote_summary
            .mount_profiles
            .iter()
            .filter(|p| p.is_active)
            .collect();
        if mounted_profiles.len() <= 1 {
            let p = mounted_profiles
                .first()
                .map(|p| p.name.clone())
                .unwrap_or_default();
            submenu_items.push(MenuItemKind::Regular(RegularItem {
                id: TrayAction::Browse(remote.clone(), p).to_id(),
                label: t!("tray.browse"),
                enabled: true,
            }));
        } else {
            let items = mounted_profiles
                .iter()
                .map(|p| {
                    MenuItemKind::Regular(RegularItem {
                        id: TrayAction::Browse(remote.clone(), p.name.clone()).to_id(),
                        label: p.name.clone(),
                        enabled: true,
                    })
                })
                .collect();
            submenu_items.push(MenuItemKind::Submenu(SubmenuPlan {
                label: t!("tray.browse"),
                enabled: true,
                items,
            }));
        }
    } else {
        submenu_items.push(MenuItemKind::Regular(RegularItem {
            id: TrayAction::BrowseInApp(remote.clone()).to_id(),
            label: t!("tray.browseInApp"),
            enabled: true,
        }));
    }

    let display_name = if remote.chars().count() > 20 {
        let truncated: String = remote.chars().take(17).collect();
        format!("{truncated}...")
    } else {
        remote.clone()
    };

    let indicators = [
        is_mounted.then_some("🗃️"),
        (active_jobs_count > 0).then_some("🔄"),
        is_serving.then_some("📡"),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ");

    let submenu_label = if indicators.is_empty() {
        display_name
    } else {
        format!("{display_name} {indicators}")
    };

    SubmenuPlan {
        label: submenu_label,
        enabled: true,
        items: submenu_items,
    }
}

fn build_profile_submenu(
    remote: &str,
    profiles: &[TrayProfileSummary],
    cfg: ProfileSubmenuConfig,
) -> SubmenuPlan {
    let active = profiles.iter().filter(|p| p.is_active).count();
    let label = t!(
        cfg.label_key,
        "active" => &active.to_string(),
        "total"  => &profiles.len().to_string()
    );

    let items = profiles
        .iter()
        .map(|p| {
            let action = if p.is_active {
                TrayAction::StopProfile(cfg.op, remote.to_string(), p.name.clone())
            } else {
                TrayAction::StartProfile(cfg.op, remote.to_string(), p.name.clone())
            };
            let item_label = if p.is_active {
                format!("● {} ▸ {}", p.name, t!(cfg.stop_label_key))
            } else {
                format!("  {} ▸ {}", p.name, t!(cfg.start_label_key))
            };
            MenuItemKind::Regular(RegularItem {
                id: action.to_id(),
                label: item_label,
                enabled: true,
            })
        })
        .collect();

    SubmenuPlan {
        label,
        enabled: !profiles.is_empty(),
        items,
    }
}

// Tauri object construction (main thread only)

pub fn create_tray_menu_from_plan<R: Runtime>(
    app: &AppHandle<R>,
    plan: &MenuPlan,
) -> tauri::Result<Menu<R>> {
    let items = plan
        .items
        .iter()
        .map(|kind| kind_to_tauri(app, kind))
        .collect::<tauri::Result<Vec<_>>>()?;

    let refs: Vec<&dyn tauri::menu::IsMenuItem<R>> =
        items.iter().map(std::convert::AsRef::as_ref).collect();
    Menu::with_items(app, &refs)
}

fn kind_to_tauri<R: Runtime>(
    app: &AppHandle<R>,
    kind: &MenuItemKind,
) -> tauri::Result<Box<dyn tauri::menu::IsMenuItem<R>>> {
    match kind {
        MenuItemKind::Separator => Ok(Box::new(PredefinedMenuItem::separator(app)?)),

        MenuItemKind::Regular(item) => Ok(Box::new(MenuItem::with_id(
            app,
            &item.id,
            &item.label,
            item.enabled,
            None::<&str>,
        )?)),

        MenuItemKind::Check(item) => Ok(Box::new(CheckMenuItem::with_id(
            app,
            &item.id,
            &item.label,
            item.enabled,
            item.checked,
            None::<&str>,
        )?)),

        MenuItemKind::Submenu(s) => {
            let children = s
                .items
                .iter()
                .map(|k| kind_to_tauri(app, k))
                .collect::<tauri::Result<Vec<_>>>()?;
            let refs: Vec<&dyn tauri::menu::IsMenuItem<R>> =
                children.iter().map(std::convert::AsRef::as_ref).collect();
            Ok(Box::new(Submenu::with_items(
                app, &s.label, s.enabled, &refs,
            )?))
        }
    }
}
