import { Component, DestroyRef, OnInit, inject, signal, computed } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
import { TranslateModule } from '@ngx-translate/core';

import { ExportModalData, ExportType } from '@app/types';
import {
  BackupRestoreService,
  ExportCategory,
  RemoteManagementService,
  FileSystemService,
  ModalService,
} from '@app/services';

interface ExportOption {
  id: string;
  label: string;
  description: string;
  icon: string;
  categoryType?: string;
  isTranslationKey?: boolean;
}

// Static lookup — mapping specific IDs and category types to icons
const CATEGORY_ICON_MAP: Record<string, string> = {
  settings: 'gear',
  backend: 'server',
  connections: 'globe',
  remotes: 'cloud',
  external: 'file-export',
};

// Maps specific category IDs to their translation key roots
const CATEGORY_TRANSLATION_MAP: Record<string, string> = {
  settings: 'modals.export.categories.settings',
  backend: 'modals.export.categories.backend',
  connections: 'modals.export.categories.connections',
  remotes: 'modals.export.categories.remotes',
};

// Maps ExportType string values to option IDs used in the UI
const EXPORT_TYPE_TO_ID: Record<string, string> = {
  All: 'full',
  Settings: 'settings',
  SpecificRemote: 'specific_remote',
};

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
  private readonly modalService = inject(ModalService);
  private readonly destroyRef = inject(DestroyRef);

  public readonly data = inject<ExportModalData>(MAT_DIALOG_DATA);

  readonly exportPath = signal('');
  readonly selectedOption = signal<string>('full');
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
  readonly exportOptions = signal<ExportOption[]>([]);

  readonly canExport = computed(() => {
    if (this.isLoading() || this.isExporting()) return false;
    const hasPath = !!this.exportPath().trim();
    const hasValidPassword = !this.withPassword() || !!this.password().trim();
    const hasRemoteSelected =
      this.selectedOption() !== 'specific_remote' || !!this.selectedRemoteName().trim();
    return hasPath && hasValidPassword && hasRemoteSelected;
  });

  readonly showSpecificRemoteSection = computed(() => this.selectedOption() === 'specific_remote');

  readonly shouldShowProfileSelection = computed(
    () => this.selectedOption() === 'full' && this.availableProfiles().length > 1
  );

  async ngOnInit(): Promise<void> {
    // Scope escape handling to this dialog only — avoids global HostListener conflicts
    this.dialogRef
      .keydownEvents()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(event => {
        if (event.key === 'Escape') this.close();
      });

    this.isLoading.set(true);
    try {
      const [remotesList, categoriesList, profilesList] = await Promise.allSettled([
        this.remoteManagementService.getRemotes(),
        this.backupRestoreService.getExportCategories(),
        this.backupRestoreService.getBackendProfiles(),
      ]);

      this.remotes.set(remotesList.status === 'fulfilled' ? Object.freeze(remotesList.value) : []);

      if (profilesList.status === 'fulfilled') {
        const profiles = profilesList.value;
        this.availableProfiles.set(profiles);
        // Pre-select "default" if present, otherwise first available
        const preselect = profiles.includes('default') ? 'default' : profiles[0];
        if (preselect) this.selectedProfiles.set([preselect]);
      }

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
      {
        id: 'full',
        label: 'modals.export.fullBackup',
        description: 'modals.export.allConfigs',
        icon: 'box-archive',
        isTranslationKey: true,
      },
    ];

    for (const cat of categories) {
      const translationRoot = CATEGORY_TRANSLATION_MAP[cat.id];
      const hasTranslation = !!translationRoot;

      options.push({
        id: cat.id,
        label: hasTranslation ? `${translationRoot}.label` : this.toTitleCase(cat.name),
        description: hasTranslation
          ? `${translationRoot}.description`
          : cat.description || this.defaultDescriptionFor(cat.categoryType),
        icon: CATEGORY_ICON_MAP[cat.id] || CATEGORY_ICON_MAP[cat.categoryType] || 'file',
        categoryType: cat.categoryType,
        isTranslationKey: hasTranslation,
      });
    }

    if (categories.some(c => c.id === 'remotes')) {
      options.push({
        id: 'specific_remote',
        label: 'modals.export.singleRemote',
        description: 'modals.export.singleRemoteDesc',
        icon: 'hard-drive',
        isTranslationKey: true,
      });
    }

    this.exportOptions.set(options);
  }

  /** Capitalises the first letter only for raw lowercase IDs from the backend. */
  private toTitleCase(name: string): string {
    return name === name.toLowerCase() ? name.charAt(0).toUpperCase() + name.slice(1) : name;
  }

  /** Returns a fallback i18n key for categories without a backend description. */
  private defaultDescriptionFor(categoryType: string): string {
    switch (categoryType) {
      case 'settings':
        return 'modals.export.appPreferences';
      case 'sub_settings':
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
      let id: string;

      if (typeof type === 'string') {
        id = EXPORT_TYPE_TO_ID[type] ?? 'full';
      } else {
        // Discriminated union: { Category: string }
        id = 'Category' in type ? type.Category : 'full';
      }

      this.selectedOption.set(id);
    }
  }

  close(): void {
    if (!this.isExporting()) {
      this.modalService.animatedClose(this.dialogRef, false);
    }
  }

  async selectFolder(): Promise<void> {
    if (this.isExporting()) return;
    const selected = await this.fileSystemService.selectFolder(false);
    if (selected?.trim()) this.exportPath.set(selected.trim());
  }

  async onExport(): Promise<void> {
    if (!this.canExport()) return;

    this.isExporting.set(true);
    try {
      const selectedId = this.selectedOption();

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
          exportType = ExportType.Category(selectedId);
      }

      const path = this.exportPath().trim();
      if (!path) throw new Error('Export path is required');

      await this.backupRestoreService.backupSettings(
        path,
        exportType,
        this.withPassword() ? this.password().trim() : null,
        selectedId === 'specific_remote' ? this.selectedRemoteName().trim() : '',
        this.userNote().trim() || null,
        this.selectedProfiles()
      );
    } catch (error) {
      console.error('Export failed:', error);
    } finally {
      this.isExporting.set(false);
    }
  }

  onNoteChange(value: string): void {
    this.userNote.set(value);
  }
  onPasswordChange(value: string): void {
    this.password.set(value);
  }
  onRemoteSelectionChange(name: string): void {
    this.selectedRemoteName.set(name?.trim() ?? '');
  }
  togglePasswordVisibility(): void {
    this.showPassword.update(v => !v);
  }

  onExportOptionChange(optionId: string): void {
    this.selectedOption.set(optionId);
    if (optionId !== 'specific_remote') this.selectedRemoteName.set('');
  }

  onPasswordProtectionChange(enabled: boolean): void {
    this.withPassword.set(enabled);
    if (!enabled) {
      this.password.set('');
      this.showPassword.set(false);
    }
  }

  toggleProfile(profile: string, checked: boolean): void {
    this.selectedProfiles.update(current =>
      checked
        ? current.includes(profile)
          ? current
          : [...current, profile]
        : current.filter(p => p !== profile)
    );
  }
}
