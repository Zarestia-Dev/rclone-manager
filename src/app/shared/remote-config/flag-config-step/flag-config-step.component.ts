import {
  Component,
  EventEmitter,
  Input,
  Output,
  ChangeDetectionStrategy,
  inject,
} from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { FlagType, RcConfigOption } from '@app/types';
import { SettingControlComponent } from 'src/app/shared/components';
import { OperationConfigComponent } from 'src/app/shared/remote-config/app-operation-config/app-operation-config.component';
import { IconService } from '@app/services';
import { TranslateModule } from '@ngx-translate/core';

// Serve type information for icons and descriptions
const SERVE_TYPE_INFO: Record<string, { icon: string; description: string }> = {
  http: { icon: 'globe', description: 'Serve files via HTTP' },
  webdav: { icon: 'cloud', description: 'WebDAV for file access' },
  ftp: { icon: 'ftp', description: 'FTP file transfer' },
  sftp: { icon: 'sftp', description: 'Secure FTP over SSH' },
  nfs: { icon: 'server', description: 'Network File System' },
  dlna: { icon: 'play-circle', description: 'DLNA media server' },
  docker: { icon: 'box', description: 'Docker volume plugin' },
  restic: { icon: 'shield', description: 'Restic REST server' },
  s3: { icon: 'database', description: 'Amazon S3 compatible server' },
};

@Component({
  selector: 'app-flag-config-step',
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatIconModule,
    MatTooltipModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    SettingControlComponent,
    ScrollingModule,
    OperationConfigComponent,
    TranslateModule,
  ],
  templateUrl: './flag-config-step.component.html',
  styleUrl: './flag-config-step.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FlagConfigStepComponent {
  readonly iconService = inject(IconService);

  @Input() form!: FormGroup;
  @Input() flagType!: FlagType;
  @Input() isEditMode = false;
  @Input() existingRemotes: string[] = [];
  @Input({ required: true }) currentRemoteName = 'remote';
  @Input() isNewRemote = false;
  @Input() searchQuery = '';

  @Input() dynamicFlagFields: RcConfigOption[] = [];
  @Input() mountTypes: string[] = [];

  @Input() getControlKey!: (flagType: FlagType, field: RcConfigOption) => string;

  // Serve-specific inputs
  @Input() availableServeTypes: string[] = [];
  @Input() selectedServeType = 'http';
  @Input() isLoadingServeFields = false;

  @Output() sourceFolderSelected = new EventEmitter<void>();
  @Output() destFolderSelected = new EventEmitter<void>();
  @Output() serveTypeChange = new EventEmitter<string>();

  // Filtered dynamic fields based on search query
  get filteredDynamicFlagFields(): RcConfigOption[] {
    const query = this.searchQuery?.toLowerCase().trim();
    if (!query) {
      return this.dynamicFlagFields;
    }

    return this.dynamicFlagFields.filter(field => {
      const nameMatch = field.Name?.toLowerCase().includes(query);
      const fieldNameMatch = field.FieldName?.toLowerCase().includes(query);
      const helpMatch = field.Help?.toLowerCase().includes(query);
      return nameMatch || fieldNameMatch || helpMatch;
    });
  }

  get formFields(): { type: string }[] {
    const fields = [];

    // Operation config for all ops except vfs/filter/backend (serve gets it too)
    if (!this.isType(['vfs', 'filter', 'backend'])) {
      fields.push({ type: 'operation-config' });
    }

    // Mount type selector
    if (this.isType('mount')) {
      fields.push({ type: 'mount-type' });
    }

    // Serve type selector
    if (this.isType('serve')) {
      fields.push({ type: 'serve-type' });
    }

    // Loading state for serve fields
    if (this.isType('serve') && this.isLoadingServeFields) {
      fields.push({ type: 'loading' });
    }

    // Dynamic flag fields (skip if loading for serve)
    if (
      this.dynamicFlagFields?.length > 0 &&
      !(this.isType('serve') && this.isLoadingServeFields)
    ) {
      fields.push({ type: 'dynamic-fields' });
    }

    return fields;
  }

  trackByField(index: number, field: { type: string }): string {
    return `${field.type}-${index}`;
  }

  onSourceFolderSelect(): void {
    this.sourceFolderSelected.emit();
  }

  onDestFolderSelect(): void {
    this.destFolderSelected.emit();
  }

  onServeTypeChange(type: string): void {
    this.serveTypeChange.emit(type);
  }

  get configGroup(): FormGroup {
    return this.form.get(`${this.flagType}Config`) as FormGroup;
  }

  isType(type: FlagType | FlagType[]): boolean {
    if (Array.isArray(type)) {
      return type.includes(this.flagType);
    }
    return this.flagType === type;
  }

  get shouldRequireEmptyFolder(): boolean {
    if (this.isType('mount')) {
      const allowNonEmpty = this.configGroup?.get('options.AllowNonEmpty')?.value;
      return !allowNonEmpty;
    }
    return false;
  }

  getServeTypeDescription(type: string): string {
    return SERVE_TYPE_INFO[type]?.description || 'Network serve type';
  }
}
