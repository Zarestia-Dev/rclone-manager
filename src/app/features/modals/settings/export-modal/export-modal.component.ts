import { Component, HostListener, OnInit, inject, signal, computed } from '@angular/core';
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
import { MatRadioModule } from '@angular/material/radio';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { CommonModule } from '@angular/common';

import { ExportModalData, ExportOption, ExportType } from '@app/types';
import { BackupRestoreService } from '@app/services';
import { RemoteManagementService } from '@app/services';
import { FileSystemService } from '@app/services';

@Component({
  selector: 'app-export-modal',
  standalone: true,
  imports: [
    CommonModule,
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
    MatRadioModule,
    MatSlideToggleModule,
  ],
  templateUrl: './export-modal.component.html',
  styleUrls: ['./export-modal.component.scss', '../../../../styles/_shared-modal.scss'],
})
export class ExportModalComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<ExportModalComponent>);
  private readonly backupRestoreService = inject(BackupRestoreService);
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly fileSystemService = inject(FileSystemService);
  public readonly data = inject<ExportModalData>(MAT_DIALOG_DATA);

  // Signals
  readonly exportPath = signal('');
  readonly selectedOption = signal<ExportType>(ExportType.All);
  readonly selectedRemoteName = signal('');
  readonly withPassword = signal(false);
  readonly password = signal('');
  readonly showPassword = signal(false);
  readonly remotes = signal<readonly string[]>([]);
  readonly isLoading = signal(false);
  readonly isExporting = signal(false);
  readonly userNote = signal('');

  readonly ExportType = ExportType;

  readonly exportOptions: readonly ExportOption[] = [
    {
      value: ExportType.All,
      label: 'Export All',
      description: 'Settings + Remotes + rclone.conf',
      icon: 'box-archive',
    },
    {
      value: ExportType.Settings,
      label: 'App Settings',
      description: 'Application preferences only',
      icon: 'gear',
    },
    {
      value: ExportType.Remotes,
      label: 'Remotes',
      description: 'Remotes list with rclone.conf',
      icon: 'server',
    },
    {
      value: ExportType.RemoteConfigs,
      label: 'Remote Configs',
      description: 'Settings for specific remotes',
      icon: 'wrench',
    },
    {
      value: ExportType.SpecificRemote,
      label: 'Single Remote',
      description: 'Export one specific remote',
      icon: 'hard-drive',
    },
    {
      value: ExportType.RCloneBackend,
      label: 'Backend Options',
      description: 'Global RClone backend flags',
      icon: 'terminal',
    },
  ] as const;

  readonly canExport = computed(() => {
    if (this.isLoading() || this.isExporting()) return false;
    const hasPath = !!this.exportPath().trim();
    const hasValidPassword = !this.withPassword() || !!this.password().trim();
    const hasRemoteSelected =
      this.selectedOption() !== ExportType.SpecificRemote || !!this.selectedRemoteName().trim();

    return hasPath && hasValidPassword && hasRemoteSelected;
  });

  readonly showSpecificRemoteSection = computed(
    () => this.selectedOption() === ExportType.SpecificRemote
  );

  async ngOnInit(): Promise<void> {
    this.isLoading.set(true);
    try {
      const [remotesList] = await Promise.allSettled([this.remoteManagementService.getRemotes()]);

      this.remotes.set(remotesList.status === 'fulfilled' ? Object.freeze(remotesList.value) : []);

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
    if (this.isExporting()) return;

    // Native dialog is modal, no need for loading state
    const selected = await this.fileSystemService.selectFolder(false);
    if (selected?.trim()) {
      this.exportPath.set(selected.trim());
    }
  }

  async onExport(): Promise<void> {
    if (!this.canExport()) return;

    this.isExporting.set(true);
    try {
      const exportParams = {
        path: this.exportPath().trim(),
        type: this.selectedOption(),
        password: this.withPassword() ? this.password().trim() : null,
        remoteName:
          this.selectedOption() === ExportType.SpecificRemote
            ? this.selectedRemoteName().trim()
            : '',
        userNote: this.userNote().trim() || null,
      };

      if (!exportParams.path) throw new Error('Export path is required');

      await this.backupRestoreService.backupSettings(
        exportParams.path,
        exportParams.type,
        exportParams.password,
        exportParams.remoteName,
        exportParams.userNote
      );
    } catch (error) {
      console.error('Export failed:', error);
    } finally {
      this.isExporting.set(false);
    }
  }

  // Simple setters
  onNoteChange(value: string): void {
    this.userNote.set(value);
  }
  togglePasswordVisibility(): void {
    this.showPassword.update(s => !s);
  }
  onPasswordChange(value: string): void {
    this.password.set(value);
  }
  onRemoteSelectionChange(name: string): void {
    this.selectedRemoteName.set(name?.trim() ?? '');
  }

  onExportOptionChange(option: ExportType): void {
    this.selectedOption.set(option);
    if (option !== ExportType.SpecificRemote) {
      this.selectedRemoteName.set('');
    }
  }

  onPasswordProtectionChange(enabled: boolean): void {
    this.withPassword.set(enabled);
    if (!enabled) {
      this.password.set('');
      this.showPassword.set(false);
    }
  }
}
