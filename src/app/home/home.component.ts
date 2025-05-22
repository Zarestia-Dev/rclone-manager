import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  HostListener,
  NgZone,
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
import {
  from,
  interval,
  Subject,
  Subscription,
  switchMap,
  takeUntil,
} from "rxjs";

// Components
import { SidebarComponent } from "../components/sidebar/sidebar.component";
import { RemoteConfigModalComponent } from "../modals/remote-config-modal/remote-config-modal.component";
import { QuickAddRemoteComponent } from "../modals/quick-add-remote/quick-add-remote.component";
import { MountOverviewComponent } from "../components/overviews/mount-overview/mount-overview.component";
import { CopyOverviewComponent } from "../components/overviews/copy-overview/copy-overview.component";
import { JobsOverviewComponent } from "../components/overviews/jobs-overview/jobs-overview.component";
import { MountDetailComponent } from "../components/details/mount-detail/mount-detail.component";
import { SyncDetailComponent } from "../components/details/sync-detail/sync-detail.component";
import { CopyDetailComponent } from "../components/details/copy-detail/copy-detail.component";
import { JobDetailComponent } from "../components/details/job-detail/job-detail.component";
import { LogsModalComponent } from "../modals/logs-modal/logs-modal.component";
import { ExportModalComponent } from "../modals/export-modal/export-modal.component";

// Services
import { StateService } from "../services/state.service";
import { RcloneService } from "../services/rclone.service";
import { SettingsService } from "../services/settings.service";
import { InfoService } from "../services/info.service";
import { IconService } from "../services/icon.service";

// home.types.ts
export type AppTab = "mount" | "sync" | "copy" | "jobs";
export type RemoteAction =
  | "mount"
  | "unmount"
  | "sync"
  | "stop"
  | "open"
  | null;

export interface RemoteSpecs {
  name: string;
  type: string;
  [key: string]: any;
}

export interface DiskUsage {
  total_space: string;
  used_space: string;
  free_space: string;
  loading?: boolean;
  error?: boolean;
  notSupported?: boolean;
}

export interface Remote {
  remoteSpecs: RemoteSpecs;
  mounted?: boolean | "error";
  diskUsage?: DiskUsage;
  isOnSync?: boolean | "error";
  syncJobID?: number;
}

export interface MountedRemote {
  fs: string;
  mount_point: string;
}

export interface RemoteSettings {
  [remoteName: string]: {
    [key: string]: any;
  };
}

export interface ModalSize {
  width: string;
  maxWidth: string;
  minWidth: string;
  height: string;
  maxHeight: string;
}

export const STANDARD_MODAL_SIZE: ModalSize = {
  width: "90vw",
  maxWidth: "642px",
  minWidth: "360px",
  height: "80vh",
  maxHeight: "600px",
};

export interface RemoteActionProgress {
  [remoteName: string]: RemoteAction;
}

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
    MountOverviewComponent,
    CopyOverviewComponent,
    JobsOverviewComponent,
    MountDetailComponent,
    SyncDetailComponent,
    CopyDetailComponent,
    JobDetailComponent,
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
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef,
    private infoService: InfoService,
    public iconService: IconService
  ) {}

  // Lifecycle Hooks
  ngOnInit(): void {
    this.setupResponsiveLayout();
    this.setupSubscriptions();
    this.loadInitialData();
    this.setupTauriListeners();
    this.loadJobsForRemote(this.selectedRemote?.remoteSpecs.name || "");
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  // UI Event Handlers
  @HostListener("window:resize")
  onResize(): void {
    this.updateSidebarMode();
  }

  async selectRemote(remote: Remote): Promise<void> {
    // this.selectedRemote = { ...remote };
    this.stateService.setSelectedRemote(remote);
    this.cdr.markForCheck();
  }

  // Remote Operations
  async mountRemote(remoteName: string): Promise<void> {
    if (!remoteName) return;

    try {
      this.actionInProgress[remoteName] = "mount";
      this.cdr.markForCheck();

      const settings = this.loadRemoteSettings(remoteName);
      await this.rcloneService.mountRemote(
        remoteName + ":" + settings.mountConfig?.source,
        settings.mountConfig?.dest,
        settings.mountConfig?.options,
        settings.vfsConfig || {}
      );

      await this.refreshMounts();
      // this.selectRemoteByName(remoteName);
    } catch (error) {
      console.error(`Failed to mount ${remoteName}:`, error);
      this.infoService.openSnackBar(`Failed to mount ${remoteName}`, "Close");
    } finally {
      this.actionInProgress[remoteName] = null;
      this.cdr.markForCheck();
    }
  }

  async unmountRemote(remoteName: string): Promise<void> {
    if (!remoteName) return;

    try {
      this.actionInProgress[remoteName] = "unmount";
      this.cdr.markForCheck();

      const mountPoint = this.getMountPoint(remoteName);
      if (!mountPoint) {
        throw new Error(`No mount point found for ${remoteName}`);
      }

      await this.rcloneService.unmountRemote(mountPoint, remoteName);
      await this.refreshMounts();
      this.selectRemoteByName(remoteName);
    } catch (error) {
      console.error(`Failed to unmount ${remoteName}:`, error);
      this.infoService.openSnackBar(`Failed to unmount ${remoteName}`, "Close");
    } finally {
      this.actionInProgress[remoteName] = null;
      this.cdr.markForCheck();
    }
  }

  async openRemoteInFiles(remoteName: string): Promise<void> {
    if (!remoteName) return;

    try {
      this.actionInProgress[remoteName] = "open";
      this.cdr.markForCheck();

      const mountPoint = this.loadRemoteSettings(remoteName)?.mountConfig?.dest;
      if (!mountPoint) {
        throw new Error(`No mount point found for ${remoteName}`);
      }

      await this.rcloneService.openInFiles(mountPoint);
    } catch (error) {
      console.error(`Failed to open ${remoteName} in files:`, error);
      this.infoService.openSnackBar(`Failed to open ${remoteName}`, "Close");
    } finally {
      this.actionInProgress[remoteName] = null;
      this.cdr.markForCheck();
    }
  }

  async deleteRemote(remoteName: string): Promise<void> {
    if (!remoteName) return;

    try {
      const confirmed = await this.infoService.confirmModal(
        "Delete Confirmation",
        `Are you sure you want to delete '${remoteName}'? This action cannot be undone.`
      );

      if (!confirmed) return;

      // Unmount if mounted
      if (this.isRemoteMounted(remoteName)) {
        await this.unmountRemote(remoteName);
      }

      await this.rcloneService.deleteRemote(remoteName);
      this.remotes = this.remotes.filter(
        (r) => r.remoteSpecs.name !== remoteName
      );

      if (this.selectedRemote?.remoteSpecs.name === remoteName) {
        this.selectedRemote = null;
      }
      this.cdr.markForCheck();
      this.infoService.openSnackBar(
        `Remote ${remoteName} deleted successfully.`,
        "Close"
      );
    } catch (error) {
      console.error(`Failed to delete remote ${remoteName}:`, error);
      this.infoService.openSnackBar(
        `Failed to delete remote ${remoteName}`,
        "Close"
      );
    }
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
    const result = await this.infoService.confirmModal(
      "Reset Remote Settings",
      `Are you sure you want to reset settings for ${this.selectedRemote?.remoteSpecs.name}? This action cannot be undone.`
    );
    console.log("Reset Remote Settings", result);
    // If the user confirms, proceed with the reset
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
      console.error("Failed to load initial data:", error);
      this.infoService.openSnackBar("Failed to load initial data", "Close");
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
      this.loadJobsForRemote(this.selectedRemote?.remoteSpecs.name || ""),
    ]);

    if (this.selectedRemote?.remoteSpecs.name) {
      this.selectRemoteByName(this.selectedRemote.remoteSpecs.name);
    }
  }

  private async loadRemotes(): Promise<void> {
    try {
      const remoteConfigs = await this.rcloneService.getAllRemoteConfigs();

      // Initial load with basic info
      this.remotes = Object.keys(remoteConfigs).map((name) => ({
        remoteSpecs: { name, ...remoteConfigs[name] },
        mounted: this.isRemoteMounted(name),
        diskUsage: {
          total_space: "Loading...",
          used_space: "Loading...",
          free_space: "Loading...",
          loading: true,
        },
        isOnSync: false,
        syncJobID: 0,
      }));

      // Load disk usage in background
      this.loadDiskUsageInBackground();
      this.loadJobs();
      this.cdr.markForCheck();
    } catch (error) {
      console.error("Failed to load remotes:", error);
      throw error;
    }
  }

  private async loadDiskUsageInBackground(): Promise<void> {
    for (const remote of this.remotes) {
      if (!remote.mounted) continue;

      try {
        if (remote.diskUsage) {
          remote.diskUsage.loading = true;
        }
        this.cdr.markForCheck();

        const fsInfo = await this.rcloneService.getFsInfo(
          remote.remoteSpecs.name
        );

        if (fsInfo?.Features?.About === false) {
          remote.diskUsage = {
            total_space: "Not supported",
            used_space: "Not supported",
            free_space: "Not supported",
            loading: false,
            error: false,
          };
          this.cdr.markForCheck();
          continue;
        }

        const usage = await this.rcloneService.getDiskUsage(
          remote.remoteSpecs.name
        );
        remote.diskUsage = {
          total_space: usage.total || "N/A",
          used_space: usage.used || "N/A",
          free_space: usage.free || "N/A",
          loading: false,
        };

        if (this.selectedRemote?.remoteSpecs.name === remote.remoteSpecs.name) {
          this.selectedRemote = { ...remote };
        }

        this.cdr.markForCheck();
      } catch (error) {
        console.error(
          `Failed to fetch disk usage for ${remote.remoteSpecs.name}:`,
          error
        );
        remote.diskUsage = {
          total_space: "Error",
          used_space: "Error",
          free_space: "Error",
          loading: false,
          error: true,
        };
        this.cdr.markForCheck();
      }

      if (this.selectedRemote?.remoteSpecs.name === remote.remoteSpecs.name) {
        this.selectedRemote = { ...remote };
      }

      // await new Promise((resolve) => setTimeout(resolve, 100));
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

  // Update startSync method
  async startSync(remoteName: string): Promise<void> {
    if (!remoteName) return;

    console.log("Starting sync for remote:", remoteName);
    try {
      this.actionInProgress[remoteName] = "sync";
      this.cdr.markForCheck();

      const settings = this.loadRemoteSettings(remoteName);
      const jobInfo = await this.rcloneService.startSync(
        remoteName + ":" + settings.syncConfig?.source,
        settings.syncConfig?.dest,
        settings.syncConfig?.options,
        settings.syncConfig?.syncOptions || {}
      );

      // Update state immediately
      console.log("Job Info:", jobInfo);
      this.remotes = this.remotes.map((remote) => {
        if (remote.remoteSpecs.name === remoteName) {
          return {
            ...remote,
            isOnSync: true,
            syncJobID: jobInfo, // Capture the job ID
          };
        }
        return remote;
      });

      // Update selected remote if it's the current one
      if (this.selectedRemote?.remoteSpecs.name === remoteName) {
        this.selectedRemote = {
          ...this.selectedRemote,
          isOnSync: true,
          syncJobID: jobInfo,
        };
      }
      
      this.loadJobsForRemote(remoteName);
      this.cdr.markForCheck();
    } catch (error) {
      console.error(`Failed to start sync for ${remoteName}:`, error);
      this.infoService.openSnackBar(
        `Failed to start sync for ${remoteName}`,
        "Close"
      );
    } finally {
      this.actionInProgress[remoteName] = null;
      this.cdr.markForCheck();
    }
  }

  // Update stopSync method
  async stopSync(remoteName: string): Promise<void> {
    if (!remoteName) return;

    try {
      this.actionInProgress[remoteName] = "stop";
      this.cdr.markForCheck();

      const remote = this.remotes.find(
        (r) => r.remoteSpecs.name === remoteName
      );
      if (!remote?.syncJobID) {
        throw new Error(`No job ID found for ${remoteName}`);
      }

      await this.rcloneService.stopJob(remote.syncJobID);

      // Update state immediately
      this.remotes = this.remotes.map((r) => {
        if (r.remoteSpecs.name === remoteName) {
          return { ...r, isOnSync: false, syncJobID: undefined };
        }
        return r;
      });

      // Update selected remote if it's the current one
      if (this.selectedRemote?.remoteSpecs.name === remoteName) {
        this.selectedRemote = {
          ...this.selectedRemote,
          isOnSync: false,
          syncJobID: undefined,
        };
      }

      this.loadJobsForRemote(remoteName);
      this.cdr.markForCheck();
    } catch (error) {
      console.error(`Failed to stop sync for ${remoteName}:`, error);
      this.infoService.openSnackBar(
        `Failed to stop sync for ${remoteName}`,
        "Close"
      );
    } finally {
      this.actionInProgress[remoteName] = null;
      this.cdr.markForCheck();
    }
  }

  private async loadJobs(): Promise<void> {
    try {
      const jobs = await this.rcloneService.getActiveJobs();

      // Update remotes array with current job status
      this.remotes = this.remotes.map((remote) => {
        const remoteJobs = jobs.filter(
          (j: any) => j.remote_name === remote.remoteSpecs.name
        );
        const runningJob = remoteJobs.find((j: any) => j.status === "running");

        return {
          ...remote,
          isOnSync: !!runningJob,
          syncJobID: runningJob?.jobid,
        };
      });

      // Update selected remote if needed
      if (this.selectedRemote) {
        const updatedRemote = this.remotes.find(
          (r) => r.remoteSpecs.name === this.selectedRemote?.remoteSpecs.name
        );
        if (updatedRemote) {
          this.selectedRemote = { ...updatedRemote };
        }
      }
      this.cdr.markForCheck();
    } catch (error) {
      console.error("Failed to load jobs:", error);
    }
  }

  private async loadJobsForRemote(remoteName: string): Promise<void> {
    try {
      const jobs = await this.rcloneService.getActiveJobs();
      const remoteJobs = jobs.filter(
        (j: { remote_name: string | undefined }) =>
          j.remote_name === this.selectedRemote?.remoteSpecs?.name
      );
      if (remoteJobs.length > 0) {
        const runningJob = remoteJobs.find(
          (j: { status: string }) => j.status === "running"
        );
        console.log("Running job:", runningJob);
        if (runningJob) {
          this.selectedRemote = {
            ...(this.selectedRemote as Remote),
            isOnSync: true,
            syncJobID: runningJob.jobid,
          };
          console.log("Job Id", runningJob.jobid);
        } else {
          this.selectedRemote = {
            ...(this.selectedRemote as Remote),
            isOnSync: false,
          };
        }
        this.cdr.markForCheck();
      }
    } catch (error) {
      console.error(`Failed to load jobs for ${remoteName}:`, error);
      this.infoService.openSnackBar(
        `Failed to load jobs for ${remoteName}`,
        "Close"
      );
    }
  }

  private selectRemoteByName(remoteName: string): void {
    const remote = this.remotes.find((r) => r.remoteSpecs.name === remoteName);
    if (remote) {
      this.selectedRemote = { ...remote };
      this.cdr.markForCheck();
    }
  }

  private setupTauriListeners(): void {
    const events = [
      "mount_cache_updated",
      "remote_cache_updated",
      "rclone_api_ready",
    ];

    events.forEach((event) => {
      listen<string>(event, async () => {
        try {
          await this.refreshData();
        } catch (error) {
          console.error(`Error handling ${event}:`, error);
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
