import { CdkMenuModule, type CdkMenuTrigger } from '@angular/cdk/menu';
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
import { type PathInspectionStatus, type PillTone } from '@app/types';
import { PathSelectionService } from 'src/app/services/remote/path-selection.service';
import {
  inspectAfterPause,
  PathInspectionService,
} from 'src/app/services/infrastructure/platform/path-inspection.service';
import { CdkOverlayAutoposDirective } from '../../directives/cdk-overlay-autopos.directive';
import { generatePrefixedId } from '../../utils/id.util';
import { PillDirective } from '../../directives/pill.directive';
import { controlVersion } from '../../utils/form-signal';
import {
  isWindowsDriveFolder,
  isWindowsDrivePath,
  isWindowsMountNetworkPath,
  mountDriveLetter,
  unquoteWindowsPath,
  windowsDriveLabel,
  windowsMountFolderTarget,
} from '../../utils/path.utils';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import {
  isOfferedLetter,
  type MountDriveOption,
  OFFERED_LETTERS,
  WindowsMountTargetService,
} from 'src/app/services/operations/windows-mount-target.service';

type MountLocation = 'letter' | 'folder';

/** The offered letters as plain choices: shown at once, before it is known which are taken. */
const PLAIN_LETTERS: readonly MountDriveOption[] = OFFERED_LETTERS.map(letter => ({
  letter,
  status: 'free' as const,
  availableForAutomatic: false,
}));

/** One drive letter of the picker: how it looks and what it says about the letter. */
interface DriveChip {
  letter: string;
  status: MountDriveOption['status'];
  selected: boolean;
  tone: PillTone | null;
  icon: string | null;
}

interface MountHint {
  key: string;
  params?: PathInspectionStatus['labelParams'];
  tone: 'warn' | 'dim' | null;
}

interface MountTargetDraft {
  location: MountLocation | null;
  paths: Partial<Record<MountLocation, string>>;
  networkDrive: boolean;
  names: { local?: string; network?: string };
}

@Component({
  selector: 'app-windows-mount-target',
  imports: [
    CdkMenuModule,
    CdkOverlayAutoposDirective,
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    PillDirective,
    TranslatePipe,
  ],
  templateUrl: './windows-mount-target.component.html',
  // The shared row first: the container rules of this component's own file must come after it.
  styleUrls: [
    '../app-operation-config/operation-path-row.scss',
    './windows-mount-target.component.scss',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WindowsMountTargetComponent {
  readonly pathControl = input.required<FormControl>();
  readonly networkModeControl = input<FormControl | null>(null);
  readonly volumeNameControl = input<FormControl | null>(null);
  readonly currentRemoteName = input.required<string>();
  readonly currentProfileName = input<string | null>(null);
  /** The Quick Run being edited, so that its own folder or letter does not count as taken. */
  readonly currentQuickRunId = input<string | null>(null);
  readonly mountProfiles = input<Record<string, unknown>>();
  readonly folderPickerDisabled = input(false);
  readonly selectFolder = output();

  private readonly windowsMountTarget = inject(WindowsMountTargetService);
  private readonly inspector = inject(PathInspectionService);
  /** What the mount path is now: free, taken by another mount, an existing folder or a file. */
  protected readonly inspection = signal<PathInspectionStatus | null>(null);
  private cancelInspection: (() => void) | null = null;
  private lastInspection: string | null = null;
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
  private readonly pathValueVersion = controlVersion(this.pathControl);
  private readonly networkModeVersion = controlVersion(this.networkModeControl);
  private readonly volumeNameVersion = controlVersion(this.volumeNameControl);
  /** Changes whenever the edited remote, profile or path control changes: state tied to it resets. */
  private readonly targetContext = computed(() => ({
    remote: this.currentRemoteName(),
    profile: this.currentProfileName(),
    quickRunId: this.currentQuickRunId(),
    control: this.pathControl(),
  }));

  private inspectPath(
    path: string,
    remote: string,
    profile: string | null,
    quickRunId: string | null
  ): void {
    const key = JSON.stringify([remote, profile, quickRunId, path]);
    if (this.lastInspection === key) return;
    this.lastInspection = key;
    this.cancelInspection?.();
    this.cancelInspection = null;
    this.inspection.set(null);
    if (!path) return;
    this.cancelInspection = inspectAfterPause(
      this.inspector,
      {
        path,
        remoteName: remote,
        profileName: profile ?? undefined,
        operation: 'mount',
        quickRunId,
      },
      status => {
        if (String(this.pathControl().value ?? '').trim() === path) this.inspection.set(status);
      }
    );
  }

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.pathSelection.unregisterField(this.folderField);
      this.cancelInspection?.();
    });
    effect(() => {
      this.pathValueVersion();
      const context = this.targetContext();
      const path = String(context.control.value ?? '').trim();
      untracked(() => this.inspectPath(path, context.remote, context.profile, context.quickRunId));
    });
    effect(() => {
      const context = this.targetContext();
      this.mountProfiles();
      const letters = this.mountLocation() === 'letter';
      // Untracked: only the context, the profiles and the location reload the drives, not what
      // the load reads.
      untracked(() => {
        // Another remote, profile or Quick Run has other letters of its own: its answer must not
        // wear the old one. The same owner keeps its letters until the new answer replaces them.
        const owner = JSON.stringify([context.remote, context.profile, context.quickRunId]);
        if (owner !== this.driveOwner) {
          this.driveOptions.set([]);
          this.driveOwner = owner;
        }
        if (letters) void this.loadDriveOptions();
        else ++this.driveRequest;
      });
    });
    effect(onCleanup => {
      const control = this.pathControl();
      control.addValidators(this.mountTargetRequired);
      onCleanup(() => {
        control.removeValidators(this.mountTargetRequired);
        control.updateValueAndValidity({ emitEvent: false });
      });
    });
  }

  protected readonly driveOptions = signal<MountDriveOption[]>([]);
  protected readonly driveStatus = signal<'checking' | 'ready' | 'unavailable'>('checking');
  /** The letter Automatic would take now, once the letters are known. */
  protected readonly automaticLetter = computed(() =>
    this.driveStatus() === 'ready'
      ? this.driveOptions().find(option => option.availableForAutomatic)?.letter
      : undefined
  );
  protected readonly driveStatusLabels = {
    occupied: 'wizards.appOperation.mountDriveOccupied',
    reserved: 'wizards.appOperation.mountDriveReserved',
    current: 'wizards.appOperation.mountDriveCurrent',
  };
  private readonly targetDraft = linkedSignal<unknown, MountTargetDraft>({
    source: this.targetContext,
    computation: () => ({ location: null, paths: {}, networkDrive: false, names: {} }),
  });
  private readonly mountPath = computed(() => {
    this.targetContext();
    this.pathValueVersion();
    return String(this.pathControl().value ?? '').trim();
  });
  /** Set when a paste lost its quotes; any later change of the path clears it. */
  protected readonly quotesRemoved = linkedSignal<unknown, boolean>({
    source: () => ({ context: this.targetContext(), path: this.mountPath() }),
    computation: () => false,
  });
  protected readonly automaticDrive = '*';
  private readonly legacyNetworkPath = computed(() => {
    const path = this.mountPath();
    return this.targetDraft().location !== 'folder' && isWindowsMountNetworkPath(path) ? path : '';
  });
  protected readonly selectedDriveLetter = computed(() => mountDriveLetter(this.mountPath()));
  protected readonly driveSelection = computed(() => {
    return this.mountPath() === this.automaticDrive || this.legacyNetworkPath()
      ? this.automaticDrive
      : this.selectedDriveLetter();
  });
  protected readonly selectedDriveOption = computed(() =>
    this.driveOptions().find(option => option.letter === this.selectedDriveLetter())
  );
  protected readonly mountLocation = computed((): MountLocation => {
    const override = this.targetDraft().location;
    if (override) return override;
    return !this.mountPath() || this.driveSelection() ? 'letter' : 'folder';
  });
  private readonly volumeName = computed(() => {
    this.volumeNameVersion();
    this.targetContext();
    return String(this.volumeNameControl()?.value ?? '');
  });
  protected readonly networkDrive = computed(() => {
    this.networkModeVersion();
    this.targetContext();
    const value: unknown = this.networkModeControl()?.value;
    return (
      this.mountLocation() === 'letter' &&
      (!!this.legacyNetworkPath() ||
        isWindowsMountNetworkPath(this.volumeName()) ||
        value === true ||
        value === 'true')
    );
  });
  protected readonly displayedVolumeName = computed(
    () => this.legacyNetworkPath() || this.volumeName()
  );
  /** Closed at first: most people keep the defaults. It opens when a disk name is set. */
  protected readonly appearanceOpen = linkedSignal<unknown, boolean>({
    source: this.targetContext,
    computation: () => untracked(() => !!this.displayedVolumeName()),
  });
  /** What File Explorer will call the drive. */
  protected readonly explorerLabel = computed(() =>
    this.mountLocation() === 'letter'
      ? windowsDriveLabel(
          this.selectedDriveLetter() ?? this.automaticLetter(),
          this.displayedVolumeName(),
          this.networkDrive(),
          this.currentRemoteName()
        )
      : ''
  );
  protected readonly driveChips = computed((): DriveChip[] => {
    const selected =
      this.driveSelection() === this.automaticDrive ? undefined : this.selectedDriveLetter();
    const options = this.driveOptions();
    // Until the check answers, and if it cannot, every letter is shown as an ordinary choice, so
    // the row has its size from the start and does not grow when the answer comes. A saved letter
    // outside D: to Z: stays visible.
    const known = options.length ? options : PLAIN_LETTERS;
    const shown: readonly MountDriveOption[] =
      selected && !known.some(({ letter }) => letter === selected)
        ? [...known, { letter: selected, status: 'free', availableForAutomatic: false }]
        : known;
    return shown
      .filter(({ letter }) => isOfferedLetter(letter) || letter === selected)
      .map(({ letter, status }) => ({
        letter,
        status,
        selected: letter === selected,
        tone:
          letter === selected
            ? 'purple'
            : status === 'reserved'
              ? 'yellow'
              : status === 'occupied'
                ? 'dim'
                : null,
        icon: status === 'occupied' ? 'lock' : status === 'current' ? 'check-circle' : null,
      }));
  });
  /** The one line below the drive picker, the most important thing first. */
  protected readonly letterHint = computed((): MountHint | null => {
    const status = this.inspection();
    if (status?.state === 'notDirectory') return { key: status.labelKey, tone: 'warn' };
    if (this.driveStatus() === 'unavailable') {
      return { key: 'wizards.appOperation.mountDriveLettersUnavailable', tone: null };
    }
    // Only the letters that are shown count: A: to C: are never offered.
    const options = this.driveOptions().filter(({ letter }) => isOfferedLetter(letter));
    if (
      this.driveStatus() === 'ready' &&
      options.length &&
      !options.some(({ status }) => status === 'free' || status === 'current')
    ) {
      return { key: 'wizards.appOperation.mountNoFreeLetter', tone: 'warn' };
    }
    const option = this.selectedDriveOption();
    if (option && option.status !== 'free' && option.status !== 'current') {
      return option.status === 'occupied'
        ? {
            key: 'wizards.appOperation.mountDriveOccupiedHint',
            params: { letter: option.letter },
            tone: 'warn',
          }
        : { key: this.driveStatusLabels[option.status], tone: 'warn' };
    }
    // A check under way is no news: it ends at once for a letter, and showing it would move
    // everything below the hint down and back up.
    if (status && status.state !== 'clean' && status.state !== 'checking') {
      const warns = ['colliding', 'nonEmpty', 'exists'].includes(status.state);
      return { key: status.labelKey, params: status.labelParams, tone: warns ? 'warn' : 'dim' };
    }
    return this.driveSelection() === this.automaticDrive
      ? { key: 'wizards.appOperation.mountAutomaticDriveHint', tone: null }
      : null;
  });
  protected readonly locations: readonly MountLocation[] = ['letter', 'folder'];
  protected readonly locationIcons = { letter: 'hard-drive', folder: 'folder' };
  protected readonly locationLabels = {
    letter: 'wizards.appOperation.mountDriveTarget',
    folder: 'wizards.appOperation.mountFolder',
  };
  /** A hint only: a folder outside a drive may still be what the user wants, so it never blocks. */
  protected readonly folderPathInvalid = computed(() => {
    const path = this.mountPath().replace(/[\\/]+$/, '');
    return this.targetDraft().location === 'folder' && !!path && !isWindowsDriveFolder(path);
  });
  private readonly mountTargetRequired: ValidatorFn = control =>
    this.targetDraft().location && Validators.required(control) ? { required: true } : null;
  private driveRequest = 0;
  private driveOwner = '';

  protected async loadDriveOptions(): Promise<void> {
    const request = ++this.driveRequest;
    this.driveStatus.set('checking');
    try {
      const options = await this.windowsMountTarget.getDriveOptions(
        this.currentRemoteName(),
        this.currentProfileName() ?? undefined,
        this.mountProfiles(),
        untracked(this.selectedDriveLetter),
        this.currentQuickRunId()
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

    this.setDiskAppearance(location === 'letter' && networkDrive);
    this.targetDraft.update(state => ({ ...state, location, paths, networkDrive }));
    control.markAsDirty();
    // Letters start on Automatic, so the picker is never empty; a folder starts empty.
    control.setValue(paths[location] || (location === 'letter' ? this.automaticDrive : ''));
  }

  protected selectDiskType(useNetwork: boolean): void {
    const control = this.networkModeControl();
    if (!control || control.disabled || this.mountLocation() === 'folder') return;
    const legacyPath = this.legacyNetworkPath();
    this.setDiskAppearance(useNetwork);
    if (legacyPath && !useNetwork) this.updateControl(this.pathControl(), this.automaticDrive);
  }

  protected changeVolumeName(name: string): void {
    if (this.legacyNetworkPath()) {
      this.updateControl(this.networkModeControl(), true);
      this.updateControl(this.pathControl(), this.automaticDrive);
    }
    this.updateControl(this.volumeNameControl(), name);
  }

  private setDiskAppearance(useNetwork: boolean): void {
    const wasNetwork = this.networkDrive();
    const volumeName = this.volumeName();
    const shownName = this.displayedVolumeName();
    if (wasNetwork !== useNetwork) {
      const names = {
        ...this.targetDraft().names,
        [wasNetwork ? 'network' : 'local']: shownName,
      };
      const defaultName =
        isWindowsMountNetworkPath(shownName) && !useNetwork
          ? isWindowsMountNetworkPath(volumeName)
            ? ''
            : volumeName
          : shownName;
      this.targetDraft.update(state => ({ ...state, names }));
      this.updateControl(
        this.volumeNameControl(),
        names[useNetwork ? 'network' : 'local'] ?? defaultName
      );
    }
    this.updateControl(this.networkModeControl(), useNetwork);
  }

  private updateControl(control: FormControl | null, value: string | boolean): void {
    if (!control || control.disabled || control.value === value) return;
    control.markAsDirty();
    control.setValue(value);
  }

  protected selectDriveLetter(letter: string): void {
    // A letter that is taken now (a removable or network drive) can be free at mount time, so
    // it stays selectable and the hint below the picker names its status.
    const legacyPath = this.legacyNetworkPath();
    if (legacyPath && letter !== this.automaticDrive) {
      this.updateControl(this.networkModeControl(), true);
      this.updateControl(this.volumeNameControl(), legacyPath);
    }
    this.updateControl(this.pathControl(), letter);
  }

  protected openFolderBrowser(): void {
    if (this.reopeningFolderMenu) return;
    this.updateFolderSuggestions(String(this.pathControl().value ?? ''), true);
  }

  protected pasteFolderPath(event: ClipboardEvent, field: HTMLInputElement): void {
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;

    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    const pasted = field.value.slice(0, start) + text + field.value.slice(end);
    if (this.acceptPastedFolderPath(pasted)) event.preventDefault();
  }

  /** Mounts into a new folder inside the folder that is entered, which must not exist. */
  protected useEnteredFolderAsParent(): void {
    const target = windowsMountFolderTarget(
      this.mountPath(),
      '',
      this.currentRemoteName(),
      this.volumeNameControl()?.value
    );
    if (target) this.updateControl(this.pathControl(), target);
  }

  private acceptPastedFolderPath(value: string): boolean {
    const pasted = value.trim();
    const path = unquoteWindowsPath(pasted);
    const control = this.pathControl();
    if (control.disabled || !isWindowsDrivePath(path) || /["\r\n]/.test(path)) return false;

    this.targetDraft.update(draft => ({ ...draft, location: 'folder' }));
    this.folderMenuTrigger()?.close();
    control.markAsDirty();
    control.setValue(path);
    this.quotesRemoved.set(path !== pasted);
    return true;
  }

  protected typeFolderPath(event: Event, field: HTMLInputElement): void {
    const value = field.value;
    if (
      (event as InputEvent).inputType === 'insertFromPaste' &&
      this.acceptPastedFolderPath(value)
    ) {
      return;
    }
    if (this.targetDraft().location === null) {
      this.targetDraft.update(state => ({ ...state, location: 'folder' }));
      this.pathControl().updateValueAndValidity();
    }
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
    const isAbsolute = isWindowsDrivePath(path);
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
    const target = windowsMountFolderTarget(
      this.folderState().currentPath,
      control.value ?? '',
      this.currentRemoteName(),
      this.volumeNameControl()?.value
    );
    if (!target || control.disabled) return;
    control.markAsDirty();
    control.setValue(target);
  }
}
