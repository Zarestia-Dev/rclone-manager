import { CommonModule, TitleCasePipe } from '@angular/common';
import {
  Component,
  Input,
  ChangeDetectionStrategy,
  Output,
  EventEmitter,
  OnInit,
  ChangeDetectorRef,
  inject,
  OnDestroy,
} from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatMenuModule } from '@angular/material/menu';
import { Subject, takeUntil } from 'rxjs';
import { FlagType } from '@app/types';

@Component({
  selector: 'app-operation-config',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSlideToggleModule,
    MatButtonModule,
    MatIconModule,
    MatSelectModule,
    MatMenuModule,
    TitleCasePipe,
  ],
  template: `
    <div class="operation-config" [formGroup]="opFormGroup">
      <div class="header-section">
        <mat-slide-toggle formControlName="autoStart" class="operation-enable">
          Enable Auto-{{ operationType | titlecase }}
        </mat-slide-toggle>
        <p class="section-description">{{ description }}</p>
      </div>
      <div class="path-section" formGroupName="source">
        @if (isMount) {
          <mat-form-field appearance="fill">
            <mat-label>Source Path</mat-label>
            <span matPrefix class="path-prefix mount-remote locked">
              <mat-icon svgIcon="hard-drive"></mat-icon>
              <span>{{ currentRemoteName }}:/</span>
            </span>
            <input
              matInput
              formControlName="path"
              placeholder="Root folder (optional)"
              aria-label="Source path on remote"
            />
          </mat-form-field>
        }

        @if (!isMount) {
          <mat-form-field appearance="fill">
            <mat-label>Source Path</mat-label>
            <mat-select
              matPrefix
              formControlName="pathType"
              class="path-prefix"
              [class.local]="sourcePathType === 'local'"
              [class.remote]="sourcePathType !== 'local'"
              aria-label="Change source path type"
              (click)="$event.stopPropagation()"
            >
              <mat-select-trigger>
                @switch (sourcePathType) {
                  @case ('local') {
                    <mat-icon svgIcon="folder"></mat-icon>
                    <span>Local Path</span>
                  }
                  @case ('currentRemote') {
                    <mat-icon svgIcon="hard-drive"></mat-icon>
                    <span>{{ currentRemoteName }}:/</span>
                  }
                  @case ('otherRemote') {
                    <mat-icon svgIcon="cloud"></mat-icon>
                    <span>{{ opFormGroup.get('source.otherRemoteName')?.value }}:/</span>
                  }
                }
              </mat-select-trigger>

              <!-- Options -->
              <mat-option value="local">
                <mat-icon svgIcon="folder"></mat-icon>
                Local Path
              </mat-option>
              <mat-option value="currentRemote">
                <mat-icon svgIcon="hard-drive"></mat-icon>
                {{ currentRemoteName }}:/
              </mat-option>
              @if (otherRemotes.length) {
                <mat-optgroup label="Other Remotes">
                  @for (remote of otherRemotes; track remote) {
                    <mat-option [value]="'otherRemote:' + remote">
                      <mat-icon svgIcon="cloud"></mat-icon>
                      {{ remote }}:/
                    </mat-option>
                  }
                </mat-optgroup>
              }
            </mat-select>

            <input
              matInput
              formControlName="path"
              placeholder="Enter source path..."
              aria-label="Source path"
              (click)="$event.stopPropagation()"
            />
            @if (sourcePathType === 'local') {
              <button
                matIconButton
                matSuffix
                (click)="onSelectFolder('source')"
                type="button"
                aria-label="Select source folder"
              >
                <mat-icon svgIcon="folder" class="primary"></mat-icon>
              </button>
            }
          </mat-form-field>
        }
      </div>

      <div class="path-section" formGroupName="dest">
        @if (isMount) {
          <mat-form-field appearance="fill">
            <mat-label>Destination Path</mat-label>
            <span matPrefix class="path-prefix mount-local locked">
              <mat-icon svgIcon="folder"></mat-icon>
              <span>Local Path</span>
            </span>
            <input
              matInput
              formControlName="path"
              placeholder="Select a mount folder..."
              aria-label="Destination mount path"
            />
            <button
              matIconButton
              matSuffix
              (click)="onSelectFolder('dest')"
              type="button"
              aria-label="Select destination folder"
            >
              <mat-icon svgIcon="folder" class="primary"></mat-icon>
            </button>
            @if (opFormGroup.get('dest.path')?.hasError('required')) {
              <mat-error>Destination is required</mat-error>
            }
          </mat-form-field>
        }

        @if (!isMount) {
          <mat-form-field appearance="fill">
            <mat-label>Destination Path</mat-label>
            <mat-select
              matPrefix
              formControlName="pathType"
              class="path-prefix local"
              [class.local]="destPathType === 'local'"
              [class.remote]="destPathType !== 'local'"
              aria-label="Change source path type"
              (click)="$event.stopPropagation()"
            >
              <mat-select-trigger>
                @switch (destPathType) {
                  @case ('local') {
                    <mat-icon svgIcon="folder"></mat-icon>
                    <span>Local Path</span>
                  }
                  @case ('currentRemote') {
                    <mat-icon svgIcon="hard-drive"></mat-icon>
                    <span>{{ currentRemoteName }}:/</span>
                  }
                  @case ('otherRemote') {
                    <mat-icon svgIcon="cloud"></mat-icon>
                    <span>{{ opFormGroup.get('dest.otherRemoteName')?.value }}:/</span>
                  }
                }
              </mat-select-trigger>

              <!-- Options -->
              <mat-option value="local">
                <mat-icon svgIcon="folder"></mat-icon>
                Local Path
              </mat-option>
              <mat-option value="currentRemote">
                <mat-icon svgIcon="hard-drive"></mat-icon>
                {{ currentRemoteName }}:/
              </mat-option>
              @if (otherRemotes.length) {
                <mat-optgroup label="Other Remotes">
                  @for (remote of otherRemotes; track remote) {
                    <mat-option [value]="'otherRemote:' + remote">
                      <mat-icon svgIcon="cloud"></mat-icon>
                      {{ remote }}:/
                    </mat-option>
                  }
                </mat-optgroup>
              }
            </mat-select>

            <!-- Path Input -->
            <input
              matInput
              formControlName="path"
              placeholder="Enter destination path..."
              aria-label="Destination path"
              (click)="$event.stopPropagation()"
            />
            @if (destPathType === 'local') {
              <button
                matIconButton
                matSuffix
                (click)="onSelectFolder('dest')"
                type="button"
                aria-label="Select destination folder"
              >
                <mat-icon svgIcon="folder" class="primary"></mat-icon>
              </button>
            }
            @if (opFormGroup.get('dest.path')?.hasError('required')) {
              <mat-error>Destination is required</mat-error>
            }
          </mat-form-field>
        }
      </div>
      <div class="message warning" role="status">
        <mat-icon svgIcon="info" class="orange"></mat-icon>
        <span> Note: Remote path completion available after creation of the remote. </span>
      </div>
    </div>
  `,
  styles: [
    `
      .operation-config {
        display: flex;
        flex-direction: column;
        gap: var(--space-xxs);
        padding: var(--space-md);

        .header-section {
          display: flex;
          flex-direction: column;
          gap: var(--space-xxs);
          padding: var(--space-md);
          margin-bottom: var(--space-sm);
          border: 2px solid var(--primary-color);
          border-radius: var(--panel-radius);
          background: rgba(var(--primary-color-rgb), 0.1);

          .operation-enable {
            display: flex;
            justify-content: space-between;
            align-items: center;
            width: 100%;
            font-weight: 500;
          }
          .section-description {
            font-size: var(--font-size-sm);
            color: var(--app-text-color-secondary);
            margin: 0;
          }
        }

        .message {
          display: flex;
          align-items: center;
          gap: var(--space-xxs);
          font-size: var(--font-size-md);
          margin-top: var(--space-sm);
          border-radius: var(--border-radius);

          &.warning {
            color: var(--orange);
            background: rgba(var(--orange-rgb), 0.1);
            padding: var(--space-xxs) var(--space-sm);
            border: 1px solid var(--orange);
          }
        }
      }

      .path-section {
        display: flex;
        flex-direction: column;
        gap: var(--space-xxs);
      }

      .path-prefix {
        cursor: pointer;

        &.mount-local,
        &.mount-remote,
        ::ng-deep .mat-mdc-select-trigger {
          display: flex;
          align-items: center;
          gap: var(--space-xxs);
        }

        &.mount-local,
        &.mount-remote {
          display: flex;
          align-items: center;
          gap: var(--space-xxs);
          padding: 19.4px;
        }

        ::ng-deep .ng-star-inserted {
          display: flex;
          align-items: center;
          gap: var(--space-xxs);
        }

        ::ng-deep .mat-mdc-select-value {
          padding: 19.4px;
        }

        ::ng-deep .mat-mdc-select-arrow-wrapper {
          display: none;
        }

        /* Apply styles to the trigger */
        ::ng-deep .mat-mdc-select-trigger {
          transition: all 150ms ease-in-out;
          min-width: 0;
        }

        &.mount-local,
        &.local ::ng-deep .mat-mdc-select-trigger {
          background: rgba(var(--accent-color-rgb), 0.1);
          color: var(--accent-color);
        }

        &.mount-remote,
        &.remote ::ng-deep .mat-mdc-select-trigger {
          background: rgba(var(--primary-color-rgb), 0.1);
          color: var(--primary-color);
        }

        &.locked {
          cursor: default;
        }

        mat-icon {
          font-size: 1.1rem;
          height: 1.1rem;
          width: 1.1rem;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OperationConfigComponent implements OnInit, OnDestroy {
  @Input({ required: true }) opFormGroup!: FormGroup;
  @Input({ required: true }) operationType: FlagType = 'mount';
  @Input({ required: true }) currentRemoteName = 'remote';
  @Input() existingRemotes: string[] = [];
  @Input() description = '';

  @Output() sourceFolderSelected = new EventEmitter<void>();
  @Output() destFolderSelected = new EventEmitter<void>();

  // Public properties for template binding
  isMount = false;
  otherRemotes: string[] = [];
  sourcePathType: 'local' | 'currentRemote' | 'otherRemote' = 'currentRemote';
  destPathType: 'local' | 'currentRemote' | 'otherRemote' = 'local';

  private destroy$ = new Subject<void>();
  private cdRef = inject(ChangeDetectorRef);

  ngOnInit(): void {
    this.isMount = this.operationType === 'mount';
    this.otherRemotes = this.existingRemotes.filter(r => r !== this.currentRemoteName);

    const sourceGroup = this.opFormGroup.get('source') as FormGroup;
    const destGroup = this.opFormGroup.get('dest') as FormGroup;

    if (!sourceGroup || !destGroup) {
      console.error('OperationConfigComponent: Missing source or dest FormGroup');
      return;
    }

    this.setupPathTypeListener(sourceGroup, 'source');
    this.setupPathTypeListener(destGroup, 'dest');
  }

  private setupPathTypeListener(formGroup: FormGroup, groupName: 'source' | 'dest'): void {
    const pathTypeControl = formGroup.get('pathType');
    if (!pathTypeControl) return;

    // Set initial value
    this.updatePathType(pathTypeControl.value, groupName, formGroup);

    // Listen for changes
    pathTypeControl.valueChanges.pipe(takeUntil(this.destroy$)).subscribe(value => {
      this.updatePathType(value, groupName, formGroup);
      this.cdRef.markForCheck(); // Update UI
    });
  }

  private updatePathType(value: string, groupName: 'source' | 'dest', formGroup: FormGroup): void {
    const propertyName = groupName === 'source' ? 'sourcePathType' : 'destPathType';

    if (typeof value === 'string' && value.startsWith('otherRemote:')) {
      const remoteName = value.split(':')[1] || '';
      this[propertyName] = 'otherRemote';
      formGroup.get('otherRemoteName')?.setValue(remoteName);
    } else {
      // Set to the value, with a fallback
      this[propertyName] = value as 'local' | 'currentRemote';
      const defaultValue = groupName === 'source' ? 'currentRemote' : 'local';
      if (value !== 'local' && value !== 'currentRemote') {
        this[propertyName] = defaultValue;
      }
    }
  }
  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /**
   * Emits the correct event based on which folder button was clicked.
   */
  onSelectFolder(pathType: 'source' | 'dest'): void {
    if (pathType === 'source') {
      this.sourceFolderSelected.emit();
    } else {
      this.destFolderSelected.emit();
    }
  }
}
