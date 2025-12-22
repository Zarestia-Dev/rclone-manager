import { Component, Input, Output, EventEmitter, inject, OnInit } from '@angular/core';
import { FormControl, ReactiveFormsModule, FormsModule } from '@angular/forms';
import { NgClass } from '@angular/common';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { FileSystemService, SystemInfoService } from '@app/services';
import { ValidatorRegistryService } from '../../services/validator-registry.service';
import { InstallationOptionsData, InstallationTabOption } from '../../types';

type LocationType = 'default' | 'custom' | 'existing';
type BinaryStatus = 'untested' | 'testing' | 'valid' | 'invalid';

@Component({
  selector: 'app-installation-options',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    FormsModule,
    NgClass,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
  ],
  templateUrl: './installation-options.component.html',
  styleUrl: './installation-options.component.scss',
})
export class InstallationOptionsComponent implements OnInit {
  @Input() disabled = false;
  @Input() mode: 'install' | 'config' = 'install';
  @Input() tabOptions: InstallationTabOption[] = [
    { key: 'default', label: 'Quick Fix', icon: 'bolt' },
    { key: 'custom', label: 'Custom', icon: 'folder' },
    { key: 'existing', label: 'Existing', icon: 'file' },
  ];

  @Output() dataChange = new EventEmitter<InstallationOptionsData>();
  @Output() validChange = new EventEmitter<boolean>();

  installLocation: LocationType = 'default';
  binaryTestResult: BinaryStatus = 'untested';

  customPathControl = new FormControl('');
  existingBinaryControl = new FormControl('');

  private fs = inject(FileSystemService);
  private system = inject(SystemInfoService);
  private validators = inject(ValidatorRegistryService);

  ngOnInit(): void {
    const pathValidator = this.validators.getValidator('crossPlatformPath');
    if (pathValidator) {
      this.customPathControl.setValidators([pathValidator]);
      this.existingBinaryControl.setValidators([pathValidator]);
    }

    this.customPathControl.valueChanges.subscribe(() => this.emit());
    this.existingBinaryControl.valueChanges.subscribe(() => {
      if (this.installLocation === 'existing') {
        this.binaryTestResult = 'untested';
      }
      this.emit();
    });

    this.emit();
  }

  setLocation(location: LocationType): void {
    this.installLocation = location;

    // Reset other fields when switching
    if (location !== 'custom') this.customPathControl.setValue('');
    if (location !== 'existing') {
      this.existingBinaryControl.setValue('');
      this.binaryTestResult = 'untested';
    }

    // Auto-test if path exists
    if (location === 'existing' && this.existingBinaryControl.value?.trim()) {
      this.testBinary();
    }

    this.emit();
  }

  async selectCustomPath(): Promise<void> {
    const path = this.mode === 'config' ? await this.fs.selectFile() : await this.fs.selectFolder();

    if (path) this.customPathControl.setValue(path);
  }

  async selectBinary(): Promise<void> {
    const path = await this.fs.selectFolder();
    if (path) {
      this.existingBinaryControl.setValue(path);
      this.binaryTestResult = 'untested';
      await this.testBinary();
    }
  }

  async testBinary(): Promise<void> {
    const path = this.existingBinaryControl.value?.trim();
    if (!path) {
      this.binaryTestResult = 'untested';
      this.emit();
      return;
    }

    this.binaryTestResult = 'testing';
    this.emit();

    try {
      const valid = await this.system.isRcloneAvailable(path);
      this.binaryTestResult = valid ? 'valid' : 'invalid';
    } catch {
      this.binaryTestResult = 'invalid';
    }

    this.emit();
  }

  getStatusText(): string {
    const labels: Record<BinaryStatus, string> = {
      untested: 'Not tested',
      testing: 'Testing...',
      valid: 'Valid rclone binary',
      invalid: 'Invalid or not rclone',
    };
    return labels[this.binaryTestResult];
  }

  getStatusIcon(): string {
    const icons: Record<BinaryStatus, string> = {
      untested: 'help',
      testing: 'refresh',
      valid: 'circle-check',
      invalid: 'circle-xmark',
    };
    return icons[this.binaryTestResult];
  }

  getError(control: FormControl): string {
    if (control.hasError('invalidPath')) return 'Invalid path format';
    if (control.hasError('required')) return 'Required';
    return '';
  }

  private emit(): void {
    const data: InstallationOptionsData = {
      installLocation: this.installLocation,
      customPath: this.customPathControl.value || '',
      existingBinaryPath: this.existingBinaryControl.value || '',
      binaryTestResult: this.binaryTestResult,
    };

    this.dataChange.emit(data);
    this.validChange.emit(this.isValid());
  }

  private isValid(): boolean {
    switch (this.installLocation) {
      case 'default':
        return true;
      case 'custom':
        return !!this.customPathControl.value?.trim() && this.customPathControl.valid;
      case 'existing':
        return (
          !!this.existingBinaryControl.value?.trim() &&
          this.existingBinaryControl.valid &&
          this.binaryTestResult === 'valid'
        );
    }
  }
}
