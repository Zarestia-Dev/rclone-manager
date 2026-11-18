import { CdkMenuModule, type CdkMenuTrigger } from '@angular/cdk/menu';
import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators, type ValidatorFn } from '@angular/forms';
import { type PathInspectionStatus } from '@app/types';
import { PathSelectionService } from 'src/app/services/remote/path-selection.service';
import { CdkOverlayAutoposDirective } from '../../directives/cdk-overlay-autopos.directive';
import { generatePrefixedId } from '../../utils/id.util';
import { PillDirective } from '../../directives/pill.directive';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { TranslatePipe } from '@ngx-translate/core';
import {
  type MountDriveOption,
  mountDriveLetter,
  windowsMountFolderTarget,
  WindowsMountTargetService,
} from 'src/app/services/operations/windows-mount-target.service';

type MountLocation = 'letter' | 'folder' | 'manual';

interface MountTargetDraft {
  location: MountLocation | null;
  paths: Partial<Record<MountLocation, string>>;
  networkDrive: boolean;
}

@Component({
  selector: 'app-windows-mount-target',
  imports: [
    CdkMenuModule,
    CdkOverlayAutoposDirective,
    NgTemplateOutlet,
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    PillDirective,
    MatSelectModule,
    TranslatePipe,
  ],
  templateUrl: './windows-mount-target.component.html',
  styleUrls: [
    './windows-mount-target.component.scss',
    '../app-operation-config/operation-path-row.scss',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WindowsMountTargetComponent {
  readonly pathControl = input.required<FormControl>();
  readonly networkModeControl = input<FormControl | null>(null);
  readonly volumeNameControl = input<FormControl | null>(null);
  readonly inspection = input<PathInspectionStatus | null>(null);
  readonly currentRemoteName = input.required<string>();
  readonly currentProfileName = input<string | null>(null);
  readonly mountProfiles = input<Record<string, unknown>>();
  readonly folderPickerDisabled = input(false);
  readonly selectFolder = output();

  private readonly windowsMountTarget = inject(WindowsMountTargetService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly pathSelection = inject(PathSelectionService);
  private readonly folderField = generatePrefixedId('mount-folder');
  protected readonly folderState = this.pathSelection.registerField(this.folderField, '');
  protected readonly folderMenuTrigger = viewChild<CdkMenuTrigger>('folderTrigger');
  private readonly folderFilter = signal('');
  private readonly typedParent = signal<string | null>(null);
  protected readonly folderLoading = computed(() => {
    const state = this.folderState();
    const parent = this.typedParent();
    return state.isLoading || (parent !== null && state.currentPath !== parent);
  });
  protected readonly folderOptions = computed(() => {
    const filter = this.folderFilter().toLowerCase();
    return this.folderState().options.filter(
      entry => entry.IsDir && entry.Name.toLowerCase().includes(filter)
    );
  });
  private reopeningFolderMenu = false;
  private readonly pathValueVersion = signal(0);
  private readonly networkModeVersion = signal(0);

  constructor() {
    this.destroyRef.onDestroy(() => this.pathSelection.unregisterField(this.folderField));
    effect(() => {
      this.currentRemoteName();
      this.currentProfileName();
      this.pathControl();
      this.mountProfiles();
      this.driveOptions.set([]);
      if (this.mountLocation() === 'letter') void this.loadDriveOptions();
      else ++this.driveRequest;
    });
    effect(onCleanup => {
      const subscription = this.networkModeControl()?.valueChanges.subscribe(() =>
        this.networkModeVersion.update(value => value + 1)
      );
      onCleanup(() => subscription?.unsubscribe());
    });
    effect(onCleanup => {
      const control = this.pathControl();
      control.addValidators(this.mountTargetRequired);
      const subscription = control.valueChanges.subscribe(() =>
        this.pathValueVersion.update(value => value + 1)
      );
      onCleanup(() => {
        subscription.unsubscribe();
        control.removeValidators(this.mountTargetRequired);
        control.updateValueAndValidity({ emitEvent: false });
      });
    });
  }

  protected readonly driveOptions = signal<MountDriveOption[]>([]);
  protected readonly driveStatus = signal<'checking' | 'ready' | 'unavailable'>('checking');
  protected readonly driveStatusLabels = {
    occupied: 'wizards.appOperation.mountDriveOccupied',
    reserved: 'wizards.appOperation.mountDriveReserved',
    current: 'wizards.appOperation.mountDriveCurrent',
  };
  private readonly targetDraft = linkedSignal<MountTargetDraft>(() => {
    this.currentProfileName();
    this.currentRemoteName();
    this.pathControl();
    return { location: null, paths: {}, networkDrive: false };
  });
  protected readonly selectedDriveLetter = computed(() => {
    this.pathValueVersion();
    return mountDriveLetter(this.pathControl().value);
  });
  protected readonly selectedDriveOption = computed(() =>
    this.driveOptions().find(option => option.letter === this.selectedDriveLetter())
  );
  protected readonly mountLocation = computed((): MountLocation => {
    const override = this.targetDraft().location;
    if (override) return override;
    this.pathValueVersion();
    const path = String(this.pathControl().value ?? '').trim();
    if (!path || mountDriveLetter(path)) return 'letter';
    return /^[a-z]:[\\/]./i.test(path) ? 'folder' : 'manual';
  });
  protected readonly networkDrive = computed(() => {
    this.networkModeVersion();
    this.currentProfileName();
    this.currentRemoteName();
    const value: unknown = this.networkModeControl()?.value;
    return value === true || value === 'true';
  });
  protected readonly locationIcons = { letter: 'hard-drive', folder: 'folder', manual: 'terminal' };
  protected readonly locationLabels = {
    letter: 'wizards.appOperation.mountDriveTarget',
    folder: 'wizards.appOperation.mountFolder',
    manual: 'wizards.appOperation.mountManualPath',
  };
  protected readonly folderPathInvalid = computed(() => {
    this.pathValueVersion();
    return this.mountLocation() === 'folder' && !!this.pathControl().errors?.['mountFolderPath'];
  });
  private readonly mountTargetRequired: ValidatorFn = control => {
    const selection = this.targetDraft().location;
    if (selection && Validators.required(control)) return { required: true };
    const path = String(control.value ?? '')
      .trim()
      .replace(/[\\/]+$/, '');
    if (selection === 'folder' && !/^[a-z]:[\\/]./i.test(path)) {
      return { mountFolderPath: true };
    }
    return null;
  };
  private driveRequest = 0;

  protected async loadDriveOptions(): Promise<void> {
    const request = ++this.driveRequest;
    this.driveStatus.set('checking');
    try {
      const options = await this.windowsMountTarget.getDriveOptions(
        this.currentRemoteName(),
        this.currentProfileName() ?? undefined,
        this.mountProfiles(),
        untracked(this.selectedDriveLetter)
      );
      if (!this.destroyRef.destroyed && request === this.driveRequest) {
        this.driveOptions.set(options);
        this.driveStatus.set('ready');
      }
    } catch {
      if (!this.destroyRef.destroyed && request === this.driveRequest) {
        this.driveStatus.set('unavailable');
      }
    }
  }

  protected changeMountLocation(location: MountLocation): void {
    const previous = this.mountLocation();
    if (location === previous) return;
    const control = this.pathControl();
    const draft = this.targetDraft();
    const currentPath = String(control.value ?? '');
    const paths = { ...draft.paths, [previous]: currentPath };
    const networkDrive = previous === 'folder' ? draft.networkDrive : this.networkDrive();

    this.targetDraft.set({ location, paths, networkDrive });
    control.markAsDirty();
    control.setValue(paths[location] ?? '');

    const networkMode = this.networkModeControl();
    if (networkMode && (location === 'folder' || previous === 'folder')) {
      const value = location !== 'folder' && networkDrive;
      if (networkMode.value !== value) {
        networkMode.markAsDirty();
        networkMode.setValue(value);
      }
    }
  }

  protected selectDiskType(useNetwork: boolean): void {
    const control = this.networkModeControl();
    if (!control || control.disabled || this.mountLocation() === 'folder') return;
    control.markAsDirty();
    control.setValue(useNetwork);
  }

  protected selectDriveLetter(letter: string): void {
    if (this.driveStatus() === 'unavailable') return;
    const option = this.driveOptions().find(option => option.letter === letter);
    if (option?.status !== 'free' && option?.status !== 'current') return;
    this.pathControl().markAsDirty();
    this.pathControl().setValue(letter);
  }

  protected openFolderBrowser(): void {
    if (this.reopeningFolderMenu) return;
    this.updateFolderSuggestions(String(this.pathControl().value ?? ''), true);
  }

  protected typeFolderPath(value: string): void {
    const trigger = this.folderMenuTrigger();
    if (trigger?.isOpen()) {
      this.updateFolderSuggestions(value, false);
    } else {
      trigger?.open();
    }
  }

  private updateFolderSuggestions(value: string, immediate: boolean): void {
    const path = value.trim().replaceAll('/', '\\');
    const letter = mountDriveLetter(path);
    const lastSeparator = path.lastIndexOf('\\');
    const isAbsolute = /^[a-z]:\\/i.test(path);
    const parent = letter ? letter + '\\' : isAbsolute ? path.slice(0, lastSeparator + 1) : '';
    this.typedParent.set(parent);
    this.folderFilter.set(isAbsolute ? path.slice(lastSeparator + 1) : '');
    if (immediate) {
      this.pathSelection.triggerLoad(this.folderField, '', parent);
    } else {
      this.pathSelection.updateInput(this.folderField, parent);
    }
  }

  protected browseFolder(name?: string): void {
    const trigger = this.folderMenuTrigger();
    this.typedParent.set(null);
    this.folderFilter.set('');
    if (name === undefined) {
      this.pathSelection.navigateUp(this.folderField);
    } else {
      this.pathSelection.selectEntry(this.folderField, name);
    }
    queueMicrotask(() => {
      if (this.destroyRef.destroyed || this.mountLocation() !== 'folder') return;
      this.reopeningFolderMenu = true;
      trigger?.open();
      this.reopeningFolderMenu = false;
    });
  }

  protected useFolderParent(): void {
    const control = this.pathControl();
    const target = windowsMountFolderTarget(this.folderState().currentPath, control.value ?? '');
    if (!target || control.disabled) return;
    control.markAsDirty();
    control.setValue(target);
  }
}
