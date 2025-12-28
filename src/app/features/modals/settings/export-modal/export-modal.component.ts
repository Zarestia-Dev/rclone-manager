import { Component, HostListener, OnInit, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatRadioModule } from '@angular/material/radio';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';

import { ExportModalData, ExportType } from '@app/types';
import {
  BackupRestoreService,
  ExportCategory,
  RemoteManagementService,
  FileSystemService,
} from '@app/services';

// Display option for UI
interface ExportOption {
  id: string;
  label: string;
  description: string;
  icon: string;
  categoryType?: string;
}

@Component({
  selector: 'app-export-modal',
  standalone: true,
  imports: [
    MatIconModule,
    MatDialogModule,
    MatFormFieldModule,
    MatSelectModule,
    FormsModule,
    MatInputModule,
    MatTooltipModule,
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
  readonly selectedOption = signal<string>('full'); // Changed to string ID
  readonly selectedRemoteName = signal('');
  readonly withPassword = signal(false);
  readonly password = signal('');
  readonly showPassword = signal(false);
  readonly remotes = signal<readonly string[]>([]);
  readonly isLoading = signal(false);
  readonly isExporting = signal(false);
  readonly userNote = signal('');

  // Dynamic export options from backend
  readonly exportOptions = signal<ExportOption[]>([]);

  // Icon mapping for category types
  private readonly iconMap: Record<string, string> = {
    settings: 'gear',
    sub_settings: 'folder-tree',
    external: 'file-export',
  };

  readonly canExport = computed(() => {
    if (this.isLoading() || this.isExporting()) return false;
    const hasPath = !!this.exportPath().trim();
    const hasValidPassword = !this.withPassword() || !!this.password().trim();
    const hasRemoteSelected =
      this.selectedOption() !== 'specific_remote' || !!this.selectedRemoteName().trim();

    return hasPath && hasValidPassword && hasRemoteSelected;
  });

  readonly showSpecificRemoteSection = computed(() => this.selectedOption() === 'specific_remote');

  async ngOnInit(): Promise<void> {
    this.isLoading.set(true);
    try {
      const [remotesList, categoriesList] = await Promise.allSettled([
        this.remoteManagementService.getRemotes(),
        this.backupRestoreService.getExportCategories(),
      ]);

      this.remotes.set(remotesList.status === 'fulfilled' ? Object.freeze(remotesList.value) : []);

      // Build export options from backend categories
      const backendCategories = categoriesList.status === 'fulfilled' ? categoriesList.value : [];
      this.buildExportOptions(backendCategories);

      this.initializeFromData();
    } catch (error) {
      console.error('Failed to initialize export modal:', error);
    } finally {
      this.isLoading.set(false);
    }
  }

  private buildExportOptions(categories: ExportCategory[]): void {
    const options: ExportOption[] = [
      // Full backup is always first (special option)
      {
        id: 'full',
        label: 'Full Backup',
        description: 'All Configs',
        icon: 'box-archive',
      },
    ];

    // Add categories from backend
    for (const cat of categories) {
      options.push({
        id: cat.id,
        label: cat.name,
        description: cat.description || this.getDefaultDescription(cat.categoryType),
        icon: this.iconMap[cat.categoryType] || 'file',
        categoryType: cat.categoryType,
      });
    }

    // Add "Single Remote" option if remotes sub-settings exists
    if (categories.some(c => c.id === 'remotes')) {
      options.push({
        id: 'specific_remote',
        label: 'Single Remote',
        description: 'Export one specific remote config',
        icon: 'hard-drive',
      });
    }

    this.exportOptions.set(options);
  }

  private getDefaultDescription(categoryType: string): string {
    switch (categoryType) {
      case 'settings':
        return 'Application preferences';
      case 'sub_settings':
        return 'Per-entity configuration files';
      case 'external':
        return 'External configuration file';
      default:
        return '';
    }
  }

  private initializeFromData(): void {
    if (this.data?.remoteName) {
      this.selectedOption.set('specific_remote');
      this.selectedRemoteName.set(this.data.remoteName);
    }
    if (this.data?.defaultExportType) {
      // Map old ExportType enum to new IDs
      const typeToIdMap: Record<string, string> = {
        [ExportType.All]: 'full',
        [ExportType.Settings]: 'settings',
        [ExportType.Remotes]: 'remotes',
        [ExportType.RemoteConfigs]: 'remotes',
        [ExportType.SpecificRemote]: 'specific_remote',
        [ExportType.RCloneBackend]: 'backend',
      };
      const id = typeToIdMap[this.data.defaultExportType] || 'full';
      this.selectedOption.set(id);
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

    const selected = await this.fileSystemService.selectFolder(false);
    if (selected?.trim()) {
      this.exportPath.set(selected.trim());
    }
  }

  async onExport(): Promise<void> {
    if (!this.canExport()) return;

    this.isExporting.set(true);
    try {
      const selectedId = this.selectedOption();

      // Map IDs back to ExportType for backend compatibility
      const idToTypeMap: Record<string, ExportType> = {
        full: ExportType.All,
        settings: ExportType.Settings,
        remotes: ExportType.Remotes,
        backend: ExportType.RCloneBackend,
        connections: ExportType.Connections,
        specific_remote: ExportType.SpecificRemote,
      };

      const exportType = idToTypeMap[selectedId] || ExportType.All;

      const exportParams = {
        path: this.exportPath().trim(),
        type: exportType,
        password: this.withPassword() ? this.password().trim() : null,
        remoteName: selectedId === 'specific_remote' ? this.selectedRemoteName().trim() : '',
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

  onExportOptionChange(optionId: string): void {
    this.selectedOption.set(optionId);
    if (optionId !== 'specific_remote') {
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
