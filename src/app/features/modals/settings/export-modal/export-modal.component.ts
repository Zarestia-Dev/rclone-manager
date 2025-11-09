import {
  Component,
  HostListener,
  OnInit,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { ExportModalData, ExportOption, ExportType } from '@app/types';
import { AnimationsService } from '../../../../shared/services/animations.service';
import { BackupRestoreService } from '@app/services';
import { RemoteManagementService } from '@app/services';
import { FileSystemService } from '@app/services';

@Component({
  selector: 'app-export-modal',
  imports: [
    MatIconModule,
    MatDialogModule,
    MatFormFieldModule,
    MatSelectModule,
    FormsModule,
    MatInputModule,
    MatTooltipModule,
    MatCheckboxModule,
    MatButtonModule,
    MatProgressSpinnerModule,
  ],
  animations: [AnimationsService.slideInOut()],
  templateUrl: './export-modal.component.html',
  styleUrls: ['./export-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExportModalComponent implements OnInit {
  // Injected services - make them readonly for better performance
  private readonly dialogRef = inject(MatDialogRef<ExportModalComponent>);
  private readonly backupRestoreService = inject(BackupRestoreService);
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly fileSystemService = inject(FileSystemService);
  public readonly data = inject<ExportModalData>(MAT_DIALOG_DATA);

  // Reactive state using Angular 17+ signals for better performance
  readonly exportPath = signal<string>('');
  readonly selectedOption = signal<ExportType>(ExportType.All);
  readonly selectedRemoteName = signal<string>('');
  readonly withPassword = signal<boolean>(false);
  readonly password = signal<string>('');
  readonly showPassword = signal<boolean>(false);
  readonly sevenZipSupported = signal<boolean>(false);
  readonly remotes = signal<readonly string[]>([]);
  readonly isLoading = signal<boolean>(false);
  readonly isExporting = signal<boolean>(false);
  readonly userNote = signal<string>('');
  readonly folderSelectionInProgress = signal<boolean>(false);

  // Expose ExportType enum for template
  readonly ExportType = ExportType;

  // Immutable export options - better for performance and memory
  readonly exportOptions: readonly ExportOption[] = [
    {
      value: ExportType.All,
      label: '📦 Export All',
      description: 'Settings + Remotes + rclone.conf + Backend',
    },
    {
      value: ExportType.Settings,
      label: '⚙️ Only App Settings',
      description: 'Application configuration only',
    },
    {
      value: ExportType.Remotes,
      label: '🗂 Only Remotes',
      description: 'Remotes with rclone.conf',
    },
    {
      value: ExportType.RemoteConfigs,
      label: '🔧 Only Remote Configurations',
      description: 'Remote settings without rclone.conf',
    },
    {
      value: ExportType.SpecificRemote,
      label: '🔍 Specific Remote',
      description: 'Single remote configuration',
    },
    {
      value: ExportType.RCloneBackend,
      label: '⚡ RClone Backend Settings',
      description: 'RClone backend options',
    },
  ] as const;

  // Computed properties for reactive UI updates and better performance
  readonly canExport = computed(() => {
    if (this.isLoading() || this.isExporting()) return false;

    const hasPath = this.exportPath().trim().length > 0;
    const hasValidPassword = !this.withPassword() || this.password().trim().length > 0;
    const hasRemoteSelected =
      this.selectedOption() !== ExportType.SpecificRemote ||
      this.selectedRemoteName().trim().length > 0;

    return hasPath && hasValidPassword && hasRemoteSelected;
  });

  readonly exportTooltip = computed(() => {
    if (this.isExporting()) return 'Export in progress...';
    if (this.isLoading()) return 'Loading...';
    if (!this.exportPath().trim()) return 'Please select a folder to save the export';
    if (this.withPassword() && !this.password().trim())
      return 'Please enter a password for encryption';
    if (this.selectedOption() === ExportType.SpecificRemote && !this.selectedRemoteName().trim()) {
      return 'Please select a remote to export';
    }
    return 'Export your settings to the selected folder';
  });

  readonly selectedOptionLabel = computed(() => {
    const option = this.exportOptions.find(opt => opt.value === this.selectedOption());
    return option?.label ?? 'Settings';
  });

  readonly showSpecificRemoteSection = computed(
    () => this.selectedOption() === ExportType.SpecificRemote
  );

  readonly showPasswordField = computed(() => this.withPassword() && this.sevenZipSupported());

  readonly showSecurityWarning = computed(() => !this.sevenZipSupported());

  async ngOnInit(): Promise<void> {
    try {
      this.isLoading.set(true);

      // Initialize data concurrently for better performance
      const [is7zSupported, remotesList] = await Promise.allSettled([
        this.backupRestoreService.check7zSupport(),
        this.remoteManagementService.getRemotes(),
      ]);

      // Handle results with proper error handling
      this.sevenZipSupported.set(
        is7zSupported.status === 'fulfilled' ? is7zSupported.value : false
      );

      this.remotes.set(remotesList.status === 'fulfilled' ? Object.freeze(remotesList.value) : []);

      // Initialize from input data
      this.initializeFromData();
    } catch (error) {
      console.error('Failed to initialize export modal:', error);
    } finally {
      this.isLoading.set(false);
    }
  }

  private initializeFromData(): void {
    if (this.data?.remoteName) {
      this.selectedOption.set(ExportType.SpecificRemote);
      this.selectedRemoteName.set(this.data.remoteName);
    }

    if (this.data?.defaultExportType) {
      this.selectedOption.set(this.data.defaultExportType);
    }
  }

  @HostListener('document:keydown.escape')
  close(): void {
    if (!this.isExporting()) {
      this.dialogRef.close(false);
    }
  }

  async selectFolder(): Promise<void> {
    if (this.folderSelectionInProgress() || this.isExporting()) return;

    try {
      this.folderSelectionInProgress.set(true);
      const selected = await this.fileSystemService.selectFolder(false);

      if (typeof selected === 'string' && selected.trim()) {
        this.exportPath.set(selected.trim());
      }
    } catch (error) {
      console.error('Folder selection cancelled or failed:', error);
    } finally {
      this.folderSelectionInProgress.set(false);
    }
  }

  async onExport(): Promise<void> {
    if (!this.canExport()) return;

    try {
      this.isExporting.set(true);

      // Prepare export parameters with proper validation
      const exportParams = {
        path: this.exportPath().trim(),
        type: this.selectedOption(),
        password: this.withPassword() && this.password().trim() ? this.password().trim() : null,
        remoteName:
          this.selectedOption() === ExportType.SpecificRemote
            ? this.selectedRemoteName().trim()
            : '',
        userNote: this.userNote().trim() ? this.userNote().trim() : null,
      };

      // Validate parameters before sending to backend
      if (!exportParams.path) {
        throw new Error('Export path is required');
      }

      if (exportParams.type === ExportType.SpecificRemote && !exportParams.remoteName) {
        throw new Error('Remote name is required for specific remote export');
      }

      await this.backupRestoreService.backupSettings(
        exportParams.path,
        exportParams.type,
        exportParams.password,
        exportParams.remoteName,
        exportParams.userNote
      );
    } catch (error) {
      console.error('Export failed:', error);
      // Error is already handled by the service via notifications
    } finally {
      this.isExporting.set(false);
    }
  }

  // Use proper signal setter instead of custom input handler
  onNoteChange(value: string): void {
    this.userNote.set(value);
  }

  togglePasswordVisibility(): void {
    this.showPassword.update(show => !show);
  }

  // Use proper signal setter
  onPasswordChange(value: string): void {
    this.password.set(value);
  }

  onExportOptionChange(option: ExportType): void {
    this.selectedOption.set(option);
    // Clear remote selection when not needed to prevent stale data
    if (option !== ExportType.SpecificRemote) {
      this.selectedRemoteName.set('');
    }
  }

  onRemoteSelectionChange(remoteName: string): void {
    this.selectedRemoteName.set(remoteName?.trim() ?? '');
  }

  onPasswordProtectionChange(enabled: boolean): void {
    this.withPassword.set(enabled);
    if (!enabled) {
      this.password.set('');
      this.showPassword.set(false);
    }
  }

  // TrackBy functions for better *ngFor performance
  trackByExportOption(_index: number, option: ExportOption): ExportType {
    return option.value;
  }

  trackByRemote(_index: number, remote: string): string {
    return remote;
  }
}
