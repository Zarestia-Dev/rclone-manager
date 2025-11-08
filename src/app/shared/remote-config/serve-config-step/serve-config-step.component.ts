import {
  Component,
  inject,
  Input,
  Output,
  EventEmitter,
  OnChanges,
  SimpleChanges,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { FormsModule } from '@angular/forms';
import { ScrollingModule } from '@angular/cdk/scrolling';

import { IconService } from '../../services/icon.service';
import { RcConfigOption } from '@app/types';
import { SettingControlComponent } from '../../components/setting-control/setting-control.component';
import { OperationConfigComponent } from '../app-operation-config/app-operation-config.component';

interface TypeInfo {
  icon: string;
  description: string;
}

const TYPE_INFO: Record<string, TypeInfo> = {
  http: { icon: 'globe', description: 'Serve files via HTTP' },
  webdav: { icon: 'cloud', description: 'WebDAV for file access' },
  ftp: { icon: 'folder-open', description: 'FTP file transfer' },
  sftp: { icon: 'lock', description: 'Secure FTP over SSH' },
  nfs: { icon: 'server', description: 'Network File System' },
  dlna: { icon: 'play-circle', description: 'DLNA media server' },
  docker: { icon: 'box', description: 'Docker volume plugin' },
  restic: { icon: 'shield', description: 'Restic REST server' },
  s3: { icon: 'database', description: 'Amazon S3 compatible server' },
};

@Component({
  selector: 'app-serve-config-step',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatProgressSpinner,
    SettingControlComponent,
    OperationConfigComponent,
    ScrollingModule,
  ],
  templateUrl: './serve-config-step.component.html',
  styleUrl: './serve-config-step.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServeConfigStepComponent implements OnChanges {
  readonly iconService = inject(IconService);
  private readonly cdr = inject(ChangeDetectorRef);

  @Input() form!: FormGroup;
  @Input() remoteName = '';
  @Input() hasSavedServeConfig = false;
  @Input() savedType = 'http';
  @Input() availableServeTypes: string[] = [];
  @Input() selectedType = 'http';
  @Input() dynamicServeFields: RcConfigOption[] = [];
  @Input() isLoadingFields = false;
  @Input() getControlKey!: (field: RcConfigOption) => string;

  @Output() typeChange = new EventEmitter<string>();

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['dynamicServeFields']) {
      this.cdr.markForCheck();
    }
  }

  // Direct access to form groups
  get configGroup(): FormGroup {
    return this.form;
  }

  get autoStart(): boolean {
    return this.configGroup?.get('autoStart')?.value || false;
  }

  // Get all form fields as an array for virtual scrolling
  get formFields(): any[] {
    const fields = [];
    // Custom configuration
    fields.push({ type: 'path-config' });
    fields.push({ type: 'type-selection' });

    // Loading state or dynamic fields
    if (this.isLoadingFields) {
      fields.push({ type: 'loading' });
    } else if (this.dynamicServeFields?.length > 0) {
      fields.push({ type: 'dynamic-fields' });
    }

    return fields;
  }

  trackByField(index: number, field: any): string {
    return `${field.type}-${index}`;
  }

  onTypeChange(type: string): void {
    this.typeChange.emit(type);
  }

  getRemotePathFromForm(): string {
    const path = this.configGroup?.get('source.path')?.value || '';
    return `${this.remoteName}:/${path}`;
  }

  getTypeIcon(type: string): string {
    return TYPE_INFO[type]?.icon || 'satellite-dish';
  }

  getTypeDescription(type: string): string {
    return TYPE_INFO[type]?.description || 'Network serve type';
  }
}
