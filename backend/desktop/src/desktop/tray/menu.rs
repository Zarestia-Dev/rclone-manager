use tauri::{
    AppHandle, Runtime,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
};

use super::tray_action::TrayAction;
use super::{
    TrayProfileSummary, TrayQuickRunSummary, TrayRemoteSummary, TraySnapshot, TrayWorkflowSummary,
};
use crate::utils::types::remotes::OperationType;
use rclone_manager_core::t;

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
    /// A locked tray exposes no remote names, profiles, or operational controls.
    pub fn locked() -> Self {
        let mut plan = Self::build(
            &TraySnapshot {
                active_jobs: vec![],
                mounted_remotes: vec![],
                active_serves: vec![],
                remotes: vec![],
                quick_runs: vec![],
                workflows: vec![],
            },
            0,
        );
        plan.items.retain(|item| match item {
            MenuItemKind::Regular(item) => {
                TrayAction::from_id(&item.id).is_some_and(|action| action.allowed_when_locked())
            }
            _ => false,
        });
        plan
    }

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

        let visible_quick_runs: Vec<&TrayQuickRunSummary> = snapshot
            .quick_runs
            .iter()
            .filter(|qr| qr.show_on_tray)
            .collect();

        if !visible_quick_runs.is_empty() {
            items.push(MenuItemKind::Submenu(build_quick_runs_submenu(
                &visible_quick_runs,
            )));
            items.push(MenuItemKind::Separator);
        }

        let visible_workflows: Vec<&TrayWorkflowSummary> = snapshot
            .workflows
            .iter()
            .filter(|w| w.show_on_tray)
            .collect();

        if !visible_workflows.is_empty() {
            items.push(MenuItemKind::Submenu(build_workflows_submenu(
                &visible_workflows,
            )));
            items.push(MenuItemKind::Separator);
        }

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

    let total_job_profiles: usize = remote_summary
        .profiles
        .iter()
        .filter(|(op, _)| op.is_transfer())
        .map(|(_, profiles)| profiles.len())
        .sum();

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
        let Ok(op) = action.parse::<OperationType>() else {
            continue;
        };
        submenu_items.push(MenuItemKind::Submenu(build_profile_submenu(
            remote,
            op,
            remote_summary.profiles_for(op),
        )));
    }

    submenu_items.push(MenuItemKind::Separator);

    let mounted_profiles: Vec<&TrayProfileSummary> = remote_summary
        .profiles_for(OperationType::Mount)
        .iter()
        .filter(|p| p.is_active)
        .collect();
    let is_mounted = !mounted_profiles.is_empty();
    let is_serving = remote_summary
        .profiles_for(OperationType::Serve)
        .iter()
        .any(|p| p.is_active);

    if is_mounted {
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

/// A toggle entry: "● name ▸ stop" while active, "  name ▸ start" otherwise.
fn toggle_item(
    name: &str,
    active: bool,
    action: &TrayAction,
    start_key: &str,
    stop_key: &str,
) -> MenuItemKind {
    let label = if active {
        format!("● {name} ▸ {}", t!(stop_key))
    } else {
        format!("  {name} ▸ {}", t!(start_key))
    };
    MenuItemKind::Regular(RegularItem {
        id: action.to_id(),
        label,
        enabled: true,
    })
}

/// A submenu labelled "<active>/<total>" through `count_key`, disabled when empty.
fn counted_submenu(count_key: &str, active: usize, items: Vec<MenuItemKind>) -> SubmenuPlan {
    SubmenuPlan {
        label: t!(
            count_key,
            "active" => &active.to_string(),
            "total" => &items.len().to_string()
        ),
        enabled: !items.is_empty(),
        items,
    }
}

fn build_profile_submenu(
    remote: &str,
    op: OperationType,
    profiles: &[TrayProfileSummary],
) -> SubmenuPlan {
    let (start_key, stop_key) = if op == OperationType::Mount {
        ("tray.mount", "tray.unmount")
    } else {
        ("tray.start", "tray.stop")
    };
    let items = profiles
        .iter()
        .map(|p| {
            let action = if p.is_active {
                TrayAction::StopProfile(op, remote.to_string(), p.name.clone())
            } else {
                TrayAction::StartProfile(op, remote.to_string(), p.name.clone())
            };
            toggle_item(&p.name, p.is_active, &action, start_key, stop_key)
        })
        .collect();
    let active = profiles.iter().filter(|p| p.is_active).count();
    counted_submenu(count_label_key(op), active, items)
}

/// Spelled out (not formatted from the operation name) so the i18n audit sees each key.
fn count_label_key(op: OperationType) -> &'static str {
    match op {
        OperationType::Mount => "tray.mountCount",
        OperationType::Sync => "tray.syncCount",
        OperationType::Copy => "tray.copyCount",
        OperationType::Move => "tray.moveCount",
        OperationType::Bisync => "tray.bisyncCount",
        OperationType::Serve => "tray.serveCount",
        OperationType::Check => "tray.checkCount",
        OperationType::Delete => "tray.deleteCount",
        OperationType::Copyurl => "tray.copyurlCount",
        OperationType::Archivecreate => "tray.archivecreateCount",
        OperationType::Cryptcheck => "tray.cryptcheckCount",
    }
}

fn build_quick_runs_submenu(quick_runs: &[&TrayQuickRunSummary]) -> SubmenuPlan {
    let items = quick_runs
        .iter()
        .map(|qr| {
            let action = if qr.is_active {
                TrayAction::StopQuickRun(qr.id.clone())
            } else {
                TrayAction::StartQuickRun(qr.id.clone())
            };
            toggle_item(&qr.name, qr.is_active, &action, "tray.start", "tray.stop")
        })
        .collect();
    let active = quick_runs.iter().filter(|qr| qr.is_active).count();
    counted_submenu("tray.quickRunsCount", active, items)
}

fn build_workflows_submenu(workflows: &[&TrayWorkflowSummary]) -> SubmenuPlan {
    let items = workflows
        .iter()
        .map(|wf| {
            let action = if wf.is_active {
                TrayAction::StopWorkflow(wf.id.clone())
            } else {
                TrayAction::StartWorkflow(wf.id.clone())
            };
            toggle_item(&wf.name, wf.is_active, &action, "tray.start", "tray.stop")
        })
        .collect();
    let active = workflows.iter().filter(|w| w.is_active).count();
    counted_submenu("tray.workflowsCount", active, items)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locked_menu_only_exposes_open_and_quit() {
        let plan = MenuPlan::locked();
        assert_eq!(plan.items.len(), 2);
        for item in plan.items {
            let MenuItemKind::Regular(item) = item else {
                panic!("unexpected locked menu item")
            };
            assert!(TrayAction::from_id(&item.id).unwrap().allowed_when_locked());
        }
        assert!(!TrayAction::OpenFileBrowser.allowed_when_locked());
        assert!(!TrayAction::StopAllJobs.allowed_when_locked());
        assert!(!TrayAction::StartQuickRun("example".into()).allowed_when_locked());
    }

    fn profile(name: &str, is_active: bool) -> TrayProfileSummary {
        TrayProfileSummary {
            name: name.into(),
            is_active,
        }
    }

    fn remote(name: &str, show_on_tray: bool) -> TrayRemoteSummary {
        TrayRemoteSummary {
            name: name.into(),
            show_on_tray,
            primary_actions: vec!["sync".into(), "mount".into(), "not-an-operation".into()],
            profiles: vec![
                (
                    OperationType::Sync,
                    vec![profile("A", true), profile("B", false)],
                ),
                (OperationType::Mount, vec![profile("M", true)]),
            ],
        }
    }

    fn snapshot(remotes: Vec<TrayRemoteSummary>) -> TraySnapshot {
        TraySnapshot {
            active_jobs: vec![],
            mounted_remotes: vec![],
            active_serves: vec![],
            remotes,
            quick_runs: vec![],
            workflows: vec![],
        }
    }

    fn collect_ids(items: &[MenuItemKind], ids: &mut Vec<String>) {
        for item in items {
            match item {
                MenuItemKind::Regular(item) => ids.push(item.id.clone()),
                MenuItemKind::Submenu(submenu) => collect_ids(&submenu.items, ids),
                _ => {}
            }
        }
    }

    fn plan_ids(snapshot: &TraySnapshot, max_items: usize) -> Vec<String> {
        let mut ids = Vec::new();
        collect_ids(&MenuPlan::build(snapshot, max_items).items, &mut ids);
        ids
    }

    #[test]
    fn running_profiles_offer_stop_and_idle_ones_offer_start() {
        let ids = plan_ids(&snapshot(vec![remote("r", true)]), 10);
        let has = |action: TrayAction| ids.contains(&action.to_id());
        let (r, s, m) = ("r".to_string(), OperationType::Sync, OperationType::Mount);

        assert!(has(TrayAction::StopProfile(s, r.clone(), "A".into())));
        assert!(!has(TrayAction::StartProfile(s, r.clone(), "A".into())));
        assert!(has(TrayAction::StartProfile(s, r.clone(), "B".into())));
        assert!(has(TrayAction::StopProfile(m, r.clone(), "M".into())));
        // A mounted remote is browsed through its mount, not in the app.
        assert!(has(TrayAction::Browse(r.clone(), "M".into())));
        assert!(!has(TrayAction::BrowseInApp(r)));
        assert!(has(TrayAction::Quit));
    }

    #[test]
    fn unmounted_remotes_browse_in_the_app() {
        let mut idle = remote("r", true);
        idle.profiles[1].1[0].is_active = false;
        let ids = plan_ids(&snapshot(vec![idle]), 10);
        assert!(ids.contains(&TrayAction::BrowseInApp("r".into()).to_id()));
    }

    #[test]
    fn hidden_and_surplus_remotes_are_left_out() {
        let remotes = vec![
            remote("one", true),
            remote("hidden", false),
            remote("two", true),
        ];
        let all = plan_ids(&snapshot(remotes.clone()), 10);
        let browse =
            |name: &str| all.contains(&TrayAction::Browse(name.into(), "M".into()).to_id());
        assert!(browse("one") && browse("two") && !browse("hidden"));

        let limited = plan_ids(&snapshot(remotes), 1);
        assert!(limited.contains(&TrayAction::Browse("one".into(), "M".into()).to_id()));
        assert!(!limited.contains(&TrayAction::Browse("two".into(), "M".into()).to_id()));
    }
}
