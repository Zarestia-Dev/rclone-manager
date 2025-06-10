import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  HostListener,
  OnDestroy,
  OnInit,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import { MatDrawerMode, MatSidenavModule } from "@angular/material/sidenav";
import { MatCardModule } from "@angular/material/card";
import { MatDividerModule } from "@angular/material/divider";
import { MatChipsModule } from "@angular/material/chips";
import { MatDialog } from "@angular/material/dialog";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatSlideToggleModule } from "@angular/material/slide-toggle";
import { MatMenuModule } from "@angular/material/menu";
import { MatIconModule } from "@angular/material/icon";
import { MatButtonModule } from "@angular/material/button";
import { listen } from "@tauri-apps/api/event";
import { Subject, takeUntil } from "rxjs";

// Components
import { SidebarComponent } from "../components/sidebar/sidebar.component";
import { RemoteConfigModalComponent } from "../modals/remote-config-modal/remote-config-modal.component";
import { QuickAddRemoteComponent } from "../modals/quick-add-remote/quick-add-remote.component";
import { MountDetailComponent } from "../components/details/mount-detail/mount-detail.component";
import { OperationDetailComponent } from "../components/details/operation-detail/operation-detail.component";
import { LogsModalComponent } from "../modals/logs-modal/logs-modal.component";
import { ExportModalComponent } from "../modals/export-modal/export-modal.component";

// Services
import { StateService } from "../services/state.service";
import { RcloneService } from "../services/rclone.service";
import { SettingsService } from "../services/settings.service";
import { InfoService } from "../services/info.service";
import { IconService } from "../services/icon.service";
import { AppOverviewComponent } from "../components/overviews/app-overview/app-overview.component";
import {
  AppTab,
  JobInfo,
  MountedRemote,
  Remote,
  RemoteAction,
  RemoteActionProgress,
  RemoteSettings,
  STANDARD_MODAL_SIZE,
} from "../shared/components/types";
import { GeneralDetailComponent } from "../components/details/general-detail/general-detail.component";
import { GeneralOverviewComponent } from "../components/overviews/general-overview/general-overview.component";

@Component({
  selector: "app-home",
  standalone: true,
  imports: [
    CommonModule,
    MatSidenavModule,
    MatDividerModule,
    MatChipsModule,
    MatCardModule,
    MatTooltipModule,
    MatSlideToggleModule,
    MatMenuModule,
    MatIconModule,
    MatButtonModule,
    SidebarComponent,
    GeneralDetailComponent,
    GeneralOverviewComponent,
    MountDetailComponent,
    OperationDetailComponent,
    AppOverviewComponent,
  ],
  templateUrl: "./home.component.html",
  styleUrls: ["./home.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomeComponent implements OnInit, OnDestroy {
  // UI State
  isSidebarOpen = false;
  sidebarMode: MatDrawerMode = "side";
  currentTab: AppTab = "mount";
  isLoading = false;
  restrictMode = true;
  jobs: JobInfo[] = [];

  // Data State
  remotes: Remote[] = [];
  mountedRemotes: MountedRemote[] = [];
  selectedRemote: Remote | null = null;
  remoteSettings: RemoteSettings = {};
  actionInProgress: RemoteActionProgress = {};

  // Cleanup
  private destroy$ = new Subject<void>();
  private resizeObserver?: ResizeObserver;

  constructor(
    private dialog: MatDialog,
    private stateService: StateService,
    private rcloneService: RcloneService,
    private settingsService: SettingsService,
    private cdr: ChangeDetectorRef,
    private infoService: InfoService,
    public iconService: IconService
  ) {
    this.restrictValue();
  }

  // Lifecycle Hooks
  ngOnInit(): void {
    this.setupResponsiveLayout();
    this.setupSubscriptions();
    this.loadInitialData();
    this.setupTauriListeners();
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  // UI Event Handlers
  @HostListener("window:resize")
  onResize(): void {
    this.updateSidebarMode();
  }

  // Remote Selection
  async selectRemote(remote: Remote): Promise<void> {
    this.stateService.setSelectedRemote(remote);
    this.cdr.markForCheck();
    await this.loadJobsForRemote(remote.remoteSpecs.name);
  }

  // Remote Operations
  async mountRemote(remoteName: string): Promise<void> {
    await this.executeRemoteAction(
      remoteName,
      "mount",
      async () => {
        const settings = this.loadRemoteSettings(remoteName);
        await this.rcloneService.mountRemote(
          remoteName,
          settings.mountConfig.source,
          settings.mountConfig.dest,
          settings.mountConfig.options,
          settings.vfsConfig || {}
        );
        await this.refreshMounts();
      },
      `Failed to mount ${remoteName}`
    );
  }

  async unmountRemote(remoteName: string): Promise<void> {
    await this.executeRemoteAction(
      remoteName,
      "unmount",
      async () => {
        const mountPoint = this.getMountPoint(remoteName);
        if (!mountPoint) {
          throw new Error(`No mount point found for ${remoteName}`);
        }
        await this.rcloneService.unmountRemote(mountPoint, remoteName);
        await this.refreshMounts();
      },
      `Failed to unmount ${remoteName}`
    );
  }

  async openRemoteInFiles(remoteName: string, appTab: AppTab): Promise<void> {
    await this.executeRemoteAction(
      remoteName,
      "open",
      async () => {
        const path = this.getPathForOperation(remoteName, appTab);
        await this.rcloneService.openInFiles(path || "");
      },
      `Failed to open ${remoteName}`
    );
  }

  async openRemoteInFilesWithPath(
    remoteName: string,
    path?: string
  ): Promise<void> {
    await this.executeRemoteAction(
      remoteName,
      "open",
      async () => {
        await this.rcloneService.openInFiles(path || "");
      },
      `Failed to open ${remoteName}`
    );
  }

  async deleteRemote(remoteName: string): Promise<void> {
    if (!remoteName) return;

    try {
      const confirmed = await this.infoService.confirmModal(
        "Delete Confirmation",
        `Are you sure you want to delete '${remoteName}'? This action cannot be undone.`
      );

      if (!confirmed) return;

      await this.executeRemoteAction(
        remoteName,
        null,
        async () => {
          if (this.isRemoteMounted(remoteName)) {
            await this.unmountRemote(remoteName);
          }
          await this.rcloneService.deleteRemote(remoteName);
          this.handleRemoteDeletion(remoteName);
        },
        `Failed to delete remote ${remoteName}`
      );
    } catch (error) {
      this.handleError(`Failed to delete remote ${remoteName}`, error);
    }
  }

  // Operation Control
  async startOperation(
    type: "sync" | "copy",
    remoteName: string
  ): Promise<void> {
    await this.executeRemoteAction(
      remoteName,
      type,
      async () => {
        const settings = this.loadRemoteSettings(remoteName);
        const configKey = `${type}Config`;
        const optionsKey = `${type}Options`;

        if (type === "sync") {
          await this.rcloneService.startSync(
            remoteName,
            settings[configKey]?.source,
            settings[configKey]?.dest,
            settings[optionsKey] || {},
            settings.filterConfig || {}
          );
        } else {
          await this.rcloneService.startCopy(
            remoteName,
            settings[configKey]?.source,
            settings[configKey]?.dest,
            settings[optionsKey] || {},
            settings.filterConfig || {}
          );
        }
      },
      `Failed to start ${type} for ${remoteName}`
    );
  }

  async stopOperation(
    type: "sync" | "copy",
    remoteName: string
  ): Promise<void> {
    await this.executeRemoteAction(
      remoteName,
      "stop",
      async () => {
        const remote = this.remotes.find(
          (r) => r.remoteSpecs.name === remoteName
        );
        const jobId = this.getJobIdForOperation(remote, type);

        if (!jobId) {
          throw new Error(`No ${type} job ID found for ${remoteName}`);
        }

        await this.rcloneService.stopJob(jobId, remoteName);
      },
      `Failed to stop ${type} for ${remoteName}`
    );
  }

  // Modal Dialogs
  openQuickAddRemoteModal(): void {
    this.dialog.open(QuickAddRemoteComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
    });
  }

  openRemoteConfigModal(editTarget?: string, existingConfig?: any[]): void {
    this.dialog.open(RemoteConfigModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data: {
        name: this.selectedRemote?.remoteSpecs.name,
        editTarget,
        existingConfig,
        restrictMode: this.restrictMode,
      },
    });
  }

  openLogsModal(remoteName: string): void {
    this.dialog.open(LogsModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data: { remoteName },
    });
  }

  private generateUniqueRemoteName(baseName: string): string {
    const existingNames = this.remotes.map((r) => r.remoteSpecs.name);
    let newName = baseName;
    let counter = 1;
    while (existingNames.includes(newName)) {
      newName = `${baseName}-${counter++}`;
    }
    return newName;
  }

  cloneRemote(remoteName: string) {
    const remote = this.remotes.find((r) => r.remoteSpecs.name === remoteName);
    if (!remote) return;

    const baseName = remote.remoteSpecs.name.replace(/-\d+$/, "");
    const newName = this.generateUniqueRemoteName(baseName);

    const clonedSpecs = {
      ...remote.remoteSpecs,
      remoteSpecs: { ...remote.remoteSpecs, name: newName },
      name: newName,
    };

    // Deep clone settings
    const settings = this.remoteSettings[remoteName]
      ? JSON.parse(JSON.stringify(this.remoteSettings[remoteName]))
      : {};

    // Update all source fields to use the new name
    const clonedSettings = this.updateSourcesForClonedRemote(
      { ...settings, name: newName },
      remoteName,
      newName
    );

    this.dialog.open(RemoteConfigModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data: {
        name: newName,
        editTarget: undefined,
        cloneTarget: true,
        existingConfig: {
          ...clonedSpecs,
          ...clonedSettings,
        },
        restrictMode: this.restrictMode,
      },
    });
  }

  private updateSourcesForClonedRemote(
    settings: any,
    oldName: string,
    newName: string
  ): any {
    // Helper to update source fields in all configs
    const updateSource = (obj: any, key: string) => {
      if (
        obj &&
        typeof obj[key] === "string" &&
        obj[key].startsWith(`${oldName}:`)
      ) {
        obj[key] = obj[key].replace(`${oldName}:`, `${newName}:`);
      }
    };

    if (settings.mountConfig) updateSource(settings.mountConfig, "source");
    if (settings.syncConfig) updateSource(settings.syncConfig, "source");
    if (settings.copyConfig) updateSource(settings.copyConfig, "source");

    return settings;
  }

  getJobsForRemote(remoteName: string): JobInfo[] {
    return this.jobs.filter((j) => j.remote_name === remoteName);
  }

  openExportModal(remoteName: string): void {
    this.dialog.open(ExportModalComponent, {
      ...STANDARD_MODAL_SIZE,
      disableClose: true,
      data: {
        remoteName,
        defaultExportType: "specific-remote",
      },
    });
  }

  // Remote Settings
  loadRemoteSettings(remoteName: string): any {
    return this.remoteSettings[remoteName] || {};
  }

  getRemoteSettingValue(remoteName: string, key: string): any {
    return this.remoteSettings[remoteName]?.[key];
  }

  saveRemoteSettings(remoteName: string, settings: any): void {
    this.settingsService.saveRemoteSettings(remoteName, settings);
    this.remoteSettings[remoteName] = {
      ...this.remoteSettings[remoteName],
      ...settings,
    };
    this.cdr.markForCheck();
  }

  async resetRemoteSettings(): Promise<void> {
    if (!this.selectedRemote?.remoteSpecs.name) return;

    try {
      const result = await this.infoService.confirmModal(
        "Reset Remote Settings",
        `Are you sure you want to reset settings for ${this.selectedRemote?.remoteSpecs.name}? This action cannot be undone.`
      );

      if (result) {
        const remoteName = this.selectedRemote.remoteSpecs.name;
        await this.settingsService.resetRemoteSettings(remoteName);
        delete this.remoteSettings[remoteName];
        this.cdr.markForCheck();
        this.infoService.openSnackBar(
          `Settings for ${remoteName} have been reset.`,
          "Close"
        );
      }
    } catch (error) {
      this.handleError("Failed to reset remote settings", error);
    }
  }

  // Utility Methods
  isLocalPath(path: string): boolean {
    if (!path) return false;
    return (
      /^[a-zA-Z]:[\\/]/.test(path) ||
      path.startsWith("/") ||
      path.startsWith("~/") ||
      path.startsWith("./")
    );
  }

  // Private Helpers
  private setupResponsiveLayout(): void {
    this.updateSidebarMode();
    this.setupResizeObserver();
  }

  private updateSidebarMode(): void {
    this.sidebarMode = window.innerWidth < 900 ? "over" : "side";
    this.cdr.markForCheck();
  }

  private setupResizeObserver(): void {
    if (typeof window !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.updateSidebarMode());
      this.resizeObserver.observe(document.body);
    }
  }

  private setupSubscriptions(): void {
    this.stateService.currentTab$
      .pipe(takeUntil(this.destroy$))
      .subscribe((tab) => {
        this.currentTab = tab;
        this.cdr.markForCheck();
      });

    this.stateService.selectedRemote$
      .pipe(takeUntil(this.destroy$))
      .subscribe((remote) => {
        this.selectedRemote = remote;
        this.cdr.markForCheck();
      });
  }

  private async loadInitialData(): Promise<void> {
    this.isLoading = true;
    this.cdr.markForCheck();

    try {
      await this.refreshData();
    } catch (error) {
      this.handleError("Failed to load initial data", error);
    } finally {
      this.isLoading = false;
      this.cdr.markForCheck();
    }
  }

  private async refreshData(): Promise<void> {
    await Promise.all([
      this.refreshMounts(),
      this.loadRemotes(),
      this.getRemoteSettings(),
      this.loadJobs(),
    ]);
  }

  private async loadRemotes(): Promise<void> {
    try {
      const remoteConfigs = await this.rcloneService.getAllRemoteConfigs();
      this.remotes = this.createRemotesFromConfigs(remoteConfigs);
      this.loadDiskUsageInBackground();
      await this.loadActiveJobs();
      this.cdr.markForCheck();
    } catch (error) {
      this.handleError("Failed to load remotes", error);
    }
  }

  private async loadJobs(): Promise<void> {
    try {
      this.jobs = await this.rcloneService.getJobs();
      this.cdr.markForCheck();
    } catch (error) {
      this.handleError("Failed to load jobs", error);
    }
  }

  private createRemotesFromConfigs(remoteConfigs: any): Remote[] {
    return Object.keys(remoteConfigs).map((name) => ({
      remoteSpecs: { name, ...remoteConfigs[name] },
      mountState: {
        mounted: this.isRemoteMounted(name),
        diskUsage: {
          total_space: "Loading...",
          used_space: "Loading...",
          free_space: "Loading...",
          loading: true,
        },
      },
      syncState: {
        isOnSync: false,
        syncJobID: 0,
        isLocal: this.isLocalPath(
          this.remoteSettings[name]?.["syncConfig"]?.dest || ""
        ),
      },
      copyState: {
        isOnCopy: false,
        copyJobID: 0,
        isLocal: this.isLocalPath(
          this.remoteSettings[name]?.["copyConfig"]?.dest || ""
        ),
      },
    }));
  }

  private async loadDiskUsageInBackground(): Promise<void> {
    const promises = this.remotes
      .filter(
        (remote) =>
          !remote.mountState?.diskUsage ||
          remote.mountState.diskUsage.loading ||
          remote.mountState.diskUsage.error
      )
      .map((remote) => this.updateRemoteDiskUsage(remote));

    await Promise.all(promises);
  }

  private async updateRemoteDiskUsage(remote: Remote): Promise<void> {
    if (!remote.mountState) return;

    try {
      this.setDiskUsageLoading(remote, true);

      const fsInfo = await this.rcloneService.getFsInfo(
        remote.remoteSpecs.name
      );

      if (fsInfo?.Features?.About === false) {
        this.setDiskUsageNotSupported(remote);
        return;
      }

      const usage = await this.rcloneService.getDiskUsage(
        remote.remoteSpecs.name
      );
      this.updateDiskUsage(remote, usage);
    } catch (error) {
      this.setDiskUsageError(remote);
    }
  }

  private setDiskUsageLoading(remote: Remote, loading: boolean): void {
    if (remote.mountState?.diskUsage) {
      remote.mountState.diskUsage.loading = loading;
    } else {
      remote.mountState = {
        ...remote.mountState,
        diskUsage: {
          total_space: "Loading...",
          used_space: "Loading...",
          free_space: "Loading...",
          loading: true,
        },
      };
    }
    this.cdr.markForCheck();
  }

  private setDiskUsageNotSupported(remote: Remote): void {
    if (remote.mountState?.diskUsage) {
      remote.mountState.diskUsage = {
        total_space: "Not supported",
        used_space: "Not supported",
        free_space: "Not supported",
        notSupported: true,
        loading: false,
        error: false,
      };
      this.cdr.markForCheck();
    }
  }

  private updateDiskUsage(remote: Remote, usage: any): void {
    if (remote.mountState?.diskUsage) {
      remote.mountState.diskUsage = {
        total_space: usage.total || "N/A",
        used_space: usage.used || "N/A",
        free_space: usage.free || "N/A",
        loading: false,
        error: false,
      };
      if (
        this.selectedRemote &&
        this.selectedRemote.remoteSpecs.name === remote.remoteSpecs.name
      ) {
        this.selectedRemote = {
          ...this.selectedRemote,
          mountState: {
            ...this.selectedRemote.mountState,
            diskUsage: { ...remote.mountState.diskUsage },
          },
        };
        this.cdr.markForCheck();
      }
    }
  }

  private setDiskUsageError(remote: Remote): void {
    if (remote.mountState?.diskUsage) {
      remote.mountState.diskUsage.loading = false;
      remote.mountState.diskUsage.error = true;
      this.cdr.markForCheck();
    }
  }

  private async getRemoteSettings(): Promise<void> {
    this.remoteSettings = await this.settingsService.getRemoteSettings();
    this.cdr.markForCheck();
  }

  private async refreshMounts(): Promise<void> {
    this.mountedRemotes = await this.rcloneService.getMountedRemotes();
    this.cdr.markForCheck();
  }

  private getMountPoint(remoteName: string): string | undefined {
    const mount = this.mountedRemotes.find((m) =>
      m.fs.startsWith(`${remoteName}:`)
    );
    return mount?.mount_point;
  }

  private isRemoteMounted(remoteName: string): boolean {
    return this.mountedRemotes.some((mount) =>
      mount.fs.startsWith(`${remoteName}:`)
    );
  }

  private async loadActiveJobs(): Promise<void> {
    try {
      const jobs = await this.rcloneService.getActiveJobs();
      this.updateRemotesWithJobs(jobs);
      this.updateSelectedRemoteIfNeeded();
      this.cdr.markForCheck();
    } catch (error) {
      this.handleError("Failed to load jobs", error);
    }
  }

  private updateRemotesWithJobs(jobs: any[]): void {
    this.remotes = this.remotes.map((remote) => {
      const remoteJobs = jobs.filter(
        (j) => j.remote_name === remote.remoteSpecs.name
      );
      return this.updateRemoteWithJobs(remote, remoteJobs);
    });
  }

  private updateRemoteWithJobs(remote: Remote, jobs: any[]): Remote {
    const runningSyncJob = jobs.find(
      (j) => j.status === "Running" && j.job_type === "sync"
    );
    const runningCopyJob = jobs.find(
      (j) => j.status === "Running" && j.job_type === "copy"
    );

    return {
      ...remote,
      syncState: {
        isOnSync: !!runningSyncJob,
        syncJobID: runningSyncJob?.jobid,
        isLocal: this.isLocalPath(
          this.remoteSettings[remote.remoteSpecs.name]?.["syncConfig"]?.dest ||
            ""
        ),
      },
      copyState: {
        isOnCopy: !!runningCopyJob,
        copyJobID: runningCopyJob?.jobid,
        isLocal: this.isLocalPath(
          this.remoteSettings[remote.remoteSpecs.name]?.["copyConfig"]?.dest ||
            ""
        ),
      },
    };
  }

  private updateSelectedRemoteIfNeeded(): void {
    if (!this.selectedRemote) return;

    const updatedRemote = this.remotes.find(
      (r) => r.remoteSpecs.name === this.selectedRemote?.remoteSpecs.name
    );

    if (updatedRemote) {
      this.selectedRemote = { ...updatedRemote };
    }
  }

  private async loadJobsForRemote(remoteName: string): Promise<void> {
    try {
      const jobs = await this.rcloneService.getActiveJobs();
      const remoteJobs = jobs.filter(
        (j: { remote_name: string }) => j.remote_name === remoteName
      );

      if (remoteJobs.length > 0 && this.selectedRemote) {
        this.selectedRemote = this.updateRemoteWithJobs(
          this.selectedRemote,
          remoteJobs
        );
        this.cdr.markForCheck();
      }
    } catch (error) {
      this.handleError(`Failed to load jobs for ${remoteName}`, error);
    }
  }

  private getPathForOperation(
    remoteName: string,
    appTab: AppTab
  ): string | undefined {
    const settings = this.loadRemoteSettings(remoteName);

    switch (appTab) {
      case "mount":
        return settings?.mountConfig?.dest;
      case "sync":
        return this.remoteSettings[remoteName]?.["syncConfig"]?.dest;
      case "copy":
        return this.remoteSettings[remoteName]?.["copyConfig"]?.dest;
      default:
        throw new Error(`Invalid app tab: ${appTab}`);
    }
  }

  private getJobIdForOperation(
    remote: Remote | undefined,
    type: "sync" | "copy"
  ): number | undefined {
    if (!remote) return undefined;
    return type === "sync"
      ? remote.syncState?.syncJobID
      : remote.copyState?.copyJobID;
  }

  private handleRemoteDeletion(remoteName: string): void {
    this.remotes = this.remotes.filter(
      (r) => r.remoteSpecs.name !== remoteName
    );

    if (this.selectedRemote?.remoteSpecs.name === remoteName) {
      this.selectedRemote = null;
    }

    this.infoService.openSnackBar(
      `Remote ${remoteName} deleted successfully.`,
      "Close"
    );
    this.cdr.markForCheck();
  }

  private async executeRemoteAction(
    remoteName: string,
    action: RemoteAction,
    operation: () => Promise<void>,
    errorMessage: string
  ): Promise<void> {
    if (!remoteName) return;

    try {
      this.actionInProgress[remoteName] = action;
      this.cdr.markForCheck();

      await operation();
    } catch (error) {
      this.handleError(errorMessage, error);
    } finally {
      this.actionInProgress[remoteName] = null;
      this.cdr.markForCheck();
    }
  }

  private handleError(message: string, error: any): void {
    console.error(`${message}:`, error);
    this.infoService.openSnackBar(String(error), "Close");
  }

  private async restrictValue(): Promise<void> {
    try {
      this.restrictMode = await this.settingsService.load_setting_value(
        "general",
        "restrict"
      );
    } catch (error) {
      this.handleError("Failed to load restrict setting", error);
    }
  }

  private setupTauriListeners(): void {
    const events = [
      "mount_cache_updated",
      "remote_cache_updated",
      "rclone_api_ready",
      "job_cache_changed",
    ];

    events.forEach((event) => {
      listen<string>(event, async () => {
        try {
          await this.refreshData();
          await this.restrictValue();
          this.cdr.markForCheck();
        } catch (error) {
          this.handleError(`Error handling ${event}`, error);
        }
      });
    });
  }

  private cleanup(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.resizeObserver?.disconnect();
    this.stateService.resetSelectedRemote();
  }
}
