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
import { MatCheckboxModule } from '@angular/material/checkbox';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

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
    MatRadioModule,
    MatSlideToggleModule,
    MatCheckboxModule,
    TranslateModule,
  ],
  templateUrl: './export-modal.component.html',
  styleUrls: ['./export-modal.component.scss', '../../../../styles/_shared-modal.scss'],
})
export class ExportModalComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<ExportModalComponent>);
  private readonly backupRestoreService = inject(BackupRestoreService);
  private readonly remoteManagementService = inject(RemoteManagementService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly translate = inject(TranslateService);
  public readonly data = inject<ExportModalData>(MAT_DIALOG_DATA);

  // Signals
  readonly exportPath = signal('');
  readonly selectedOption = signal<string>('full'); // Changed to string ID
  readonly selectedRemoteName = signal('');
  readonly withPassword = signal(false);
  readonly password = signal('');
  readonly showPassword = signal(false);
  readonly remotes = signal<readonly string[]>([]);
  readonly availableProfiles = signal<string[]>([]);
  readonly selectedProfiles = signal<string[]>([]);
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

  /**
   * Only show profile selection when there are multiple profiles
   */
  readonly shouldShowProfileSelection = computed(
    () => this.selectedOption() === 'full' && this.availableProfiles().length > 1
  );

  async ngOnInit(): Promise<void> {
    this.isLoading.set(true);
    try {
      const [remotesList, categoriesList, profilesList] = await Promise.allSettled([
        this.remoteManagementService.getRemotes(),
        this.backupRestoreService.getExportCategories(),
        this.backupRestoreService.getBackendProfiles(),
      ]);

      this.remotes.set(remotesList.status === 'fulfilled' ? Object.freeze(remotesList.value) : []);

      // Handle profiles
      if (profilesList.status === 'fulfilled') {
        this.availableProfiles.set(profilesList.value);
        // Default to all profiles or just default? Let's default to all for now or active?
        // For now empty means "default behavior" which might be active only or none.
        // Let's pre-select "default" if it exists.
        if (profilesList.value.includes('default')) {
          this.selectedProfiles.set(['default']);
        } else if (profilesList.value.length > 0) {
          this.selectedProfiles.set([profilesList.value[0]]);
        }
      }

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
        label: 'modals.export.fullBackup',
        description: 'modals.export.allConfigs',
        icon: 'box-archive',
      },
    ];

    // Add categories from backend
    for (const cat of categories) {
      options.push({
        id: cat.id,
        // Capitalize label if simple string
        label: this.formatLabel(cat.name),
        description: cat.description || this.getDefaultDescription(cat.categoryType),
        icon: this.iconMap[cat.categoryType] || 'file',
        categoryType: cat.categoryType,
      });
    }

    // Add "Single Remote" option if remotes category exists (check by ID 'remotes')
    if (categories.some(c => c.id === 'remotes')) {
      options.push({
        id: 'specific_remote',
        label: 'modals.export.singleRemote',
        description: 'modals.export.singleRemoteDesc',
        icon: 'hard-drive',
      });
    }

    this.exportOptions.set(options);
  }

  private formatLabel(name: string): string {
    // Simple title case if it looks like a raw ID
    if (name === name.toLowerCase()) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
    return name;
  }

  private getDefaultDescription(categoryType: string): string {
    switch (categoryType) {
      case 'settings':
        return 'modals.export.appPreferences';
      case 'subsettings':
        return 'modals.export.configFiles';
      case 'external':
        return 'modals.export.externalConfig';
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
      const type = this.data.defaultExportType;
      let id = 'full';

      if (typeof type === 'string') {
        if (type === 'All') id = 'full';
        else if (type === 'Settings') id = 'settings';
        else if (type === 'SpecificRemote') id = 'specific_remote';
      } else if ('Category' in type) {
        id = type.Category;
      }

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

      // Resolve ExportType dynamically
      let exportType: ExportType;

      switch (selectedId) {
        case 'full':
          exportType = ExportType.All;
          break;
        case 'settings':
          exportType = ExportType.Settings;
          break;
        case 'specific_remote':
          exportType = ExportType.SpecificRemote;
          break;
        default:
          // Assume any other ID is a category
          exportType = ExportType.Category(selectedId);
      }

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
        exportParams.userNote,
        this.selectedProfiles()
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
  onProfileSelectionChange(profiles: string[]): void {
    this.selectedProfiles.set(profiles);
  }

  toggleProfile(profile: string, checked: boolean): void {
    this.selectedProfiles.update(current => {
      if (checked) {
        // Add if not exists
        return current.includes(profile) ? current : [...current, profile];
      } else {
        // Remove
        return current.filter(p => p !== profile);
      }
    });
  }
}
