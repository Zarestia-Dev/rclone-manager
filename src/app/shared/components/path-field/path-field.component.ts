import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  WritableSignal,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { CdkMenuModule } from '@angular/cdk/menu';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import type {
  DefaultPathOp,
  FileBrowserItem,
  FilePickerSelection,
  PathGroup,
  PathInspectionStatus,
  PillTone,
} from '@app/types';
import * as pathUtils from 'src/app/shared/utils/path.utils';
import { CdkOverlayAutoposDirective } from 'src/app/shared/directives/cdk-overlay-autopos.directive';
import { PillDirective } from 'src/app/shared/directives/pill.directive';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import {
  inspectAfterPause,
  PathInspectionService,
} from 'src/app/services/infrastructure/platform/path-inspection.service';
import {
  PathSelectionService,
  PathSelectionState,
} from 'src/app/services/remote/path-selection.service';

type PathType = 'local' | 'currentRemote' | 'otherRemote';

/** The colour role of each answer of the folder check; these are statuses, not operations. */
const INSPECTION_TONES: Readonly<Record<PathInspectionStatus['state'], PillTone>> = {
  clean: 'primary',
  nonEmpty: 'orange',
  exists: 'orange',
  unavailable: 'orange',
  notDirectory: 'warn',
  colliding: 'warn',
  willCreate: 'accent',
  checking: 'dim',
};

/**
 * One path of an operation: where it lives (this computer, the remote, another remote), a box with
 * folder suggestions as you type, a button for the folder picker and, for a mount or a two-way
 * copy, a check of the local folder. It edits a form group with `type`, `path` and `remote`, the
 * shape the operation forms already keep, so the profile mapping does not change.
 */
@Component({
  selector: 'app-path-field',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDividerModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    CdkMenuModule,
    TranslatePipe,
    PillDirective,
    CdkOverlayAutoposDirective,
  ],
  templateUrl: './path-field.component.html',
  // The shared row first: the container rules of this component's own file must come after it.
  styleUrls: [
    '../../remote-config/app-operation-config/operation-path-row.scss',
    './path-field.component.scss',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PathFieldComponent {
  private readonly selection = inject(PathSelectionService);
  private readonly inspector = inject(PathInspectionService);
  private readonly fileSystem = inject(FileSystemService);
  private readonly pathService = inject(PathService);
  private readonly notifications = inject(NotificationService);
  private readonly translate = inject(TranslateService);

  /** A group with the controls `type`, `path` and `remote`. */
  readonly control = input.required<FormGroup>();
  /** Unique among the fields that share a `PathSelectionService`. */
  readonly fieldId = input.required<string>();
  readonly currentRemote = input('');
  readonly otherRemotes = input<readonly string[]>([]);
  /** The type when the form has none yet. */
  readonly defaultType = input<'local' | 'currentRemote'>('currentRemote');
  /** The types the menu offers. */
  readonly types = input<readonly PathType[]>(['local', 'currentRemote', 'otherRemote']);
  /** A fixed type: the user cannot switch it. */
  readonly lock = input<'local' | 'currentRemote' | null>(null);
  readonly placeholderKey = input('wizards.appOperation.enterSourcePath');
  readonly pickerSelection = input<FilePickerSelection>('folders');
  /** The picker may return several paths; the first fills this field, the rest go to `morePicked`. */
  readonly multi = input(false);
  /** The system folder picker only accepts an empty folder (a mount point). */
  readonly requireEmpty = input(false);
  /** The built-in browser shows only the current remote (a mount or serve source). */
  readonly restrictToCurrentRemote = input(false);
  /** A path on another remote is refused (a mount point must be local). */
  readonly localOnly = input(false);
  readonly pickerDisabled = input(false);
  /** Off when another control picks for this field (a Windows mount point). */
  readonly showPicker = input(true);
  /** The type column takes the width of the Windows mount target row beneath it. */
  readonly alignWithMountTarget = input(false);
  /** Folder suggestions are listed while typing; off for a remote that does not exist yet. */
  readonly suggest = input(true);
  /** Checks a local folder for a mount or a two-way copy; null for no check. */
  readonly inspect = input<DefaultPathOp | null>(null);
  readonly profileName = input<string | undefined>(undefined);
  /** The Quick Run being edited, so that its own folders do not count as taken. */
  readonly quickRunId = input<string | null>(null);
  readonly removable = input(false);
  /**
   * The field sits in a `.path-list` that is the card and groups several rows. Alone, the field is
   * the card: it takes the same `.path-list` surface from the shared row styles.
   */
  readonly inList = input(false);

  /** The user changed the field, for a form that tracks `dirty`. */
  readonly dirty = output<void>();
  readonly morePicked = output<PathGroup[]>();
  readonly removed = output<void>();

  /** Moves when the group changes, so the values below follow the form. */
  private readonly version = signal(0);

  readonly typeValue = computed(() => {
    this.version();
    return (this.control().get('type')?.value as string) || this.defaultType();
  });
  readonly type = computed<PathType>(() => pathUtils.parsePathType(this.typeValue()));
  readonly remoteName = computed(
    () => pathUtils.getRemoteNameFromValue(this.typeValue(), this.currentRemote()) || ''
  );
  readonly path = computed<string>(() => {
    this.version();
    return (this.control().get('path')?.value as string) || '';
  });

  /** The service's signal of this field's suggestions; the template reads it. */
  readonly suggestions = signal<WritableSignal<PathSelectionState> | null>(null);
  readonly status = signal<PathInspectionStatus | null>(null);

  private registeredId: string | null = null;
  private cancelInspection: (() => void) | null = null;
  private lastInspection: string | null = null;

  /** The tone of the type and the picker: local purple, this remote primary, another remote accent. */
  readonly typeTone = computed<PillTone>(() => {
    switch (this.type()) {
      case 'local':
        return 'purple';
      case 'currentRemote':
        return 'primary';
      case 'otherRemote':
        return 'accent';
    }
  });

  readonly inspectionTone = (state: PathInspectionStatus['state']): PillTone =>
    INSPECTION_TONES[state];

  constructor() {
    effect(onCleanup => {
      const subscription = this.control().valueChanges.subscribe(() =>
        this.version.update(v => v + 1)
      );
      onCleanup(() => subscription.unsubscribe());
    });

    effect(() => {
      const id = this.fieldId();
      const remote = this.remoteName();
      const suggest = this.suggest();
      untracked(() => (suggest ? this.register(id, remote) : this.unregister()));
    });

    effect(() => {
      const op = this.inspect();
      const type = this.type();
      const path = this.path();
      const remote = this.currentRemote();
      const profile = this.profileName();
      const quickRunId = this.quickRunId();
      untracked(() => {
        if (op && type === 'local') this.runInspection(path, remote, profile, op, quickRunId);
        else this.clearInspection();
      });
    });

    inject(DestroyRef).onDestroy(() => {
      this.unregister();
      this.clearInspection();
    });
  }

  // ── Suggestions ──────────────────────────────────────────────────────────

  private register(id: string, remote: string): void {
    const current = this.suggestions()?.();
    if (this.registeredId === id && current?.remoteName === remote) return;
    this.unregister();
    const initial = (this.control().get('path')?.value as string) ?? '';
    this.suggestions.set(this.selection.registerField(id, remote, initial));
    this.registeredId = id;
  }

  private unregister(): void {
    if (this.registeredId) this.selection.unregisterField(this.registeredId);
    this.registeredId = null;
    this.suggestions.set(null);
  }

  onInput(event: Event): void {
    this.selection.updateInput(this.fieldId(), (event.target as HTMLInputElement).value);
  }

  onMenuOpened(): void {
    this.selection.triggerLoad(this.fieldId(), this.remoteName(), this.path());
  }

  onEntryPicked(entryName: string): void {
    this.dirty.emit();
    this.selection.selectEntry(this.fieldId(), entryName, this.control().get('path'));
  }

  goUp(): void {
    this.dirty.emit();
    this.selection.navigateUp(this.fieldId(), this.control().get('path'));
  }

  // ── Type ─────────────────────────────────────────────────────────────────

  setType(typeValue: string): void {
    const group = this.control();
    if (group.get('type')?.value === typeValue) return;
    this.dirty.emit();

    group.get('type')?.setValue(typeValue);
    group.get('path')?.setValue('', { emitEvent: false });
    group.get('path')?.updateValueAndValidity();
    const remote = typeValue.startsWith('otherRemote:')
      ? pathUtils.getRemoteNameFromValue(typeValue, this.currentRemote())
      : '';
    group.get('remote')?.setValue(remote, { emitEvent: false });

    this.selection.resetPath(this.fieldId());
    // One update with the final values, for whoever listens to the group.
    group.updateValueAndValidity();
    this.version.update(v => v + 1);
  }

  // ── Picker ───────────────────────────────────────────────────────────────

  async pick(): Promise<void> {
    if (this.pickerDisabled()) return;
    if (this.type() === 'local' || this.lock() === 'local') await this.pickLocal();
    else await this.pickRemote();
  }

  private async pickLocal(): Promise<void> {
    const group = this.control();
    const current = this.path();
    try {
      const selected =
        this.pickerSelection() === 'files'
          ? await this.fileSystem.selectFile(current)
          : await this.fileSystem.selectFolder(this.requireEmpty(), current);
      if (!selected) return;
      this.dirty.emit();
      group.get('path')?.setValue(selected);
      group.get('type')?.setValue('local');
      group.get('remote')?.setValue('');
    } catch (error) {
      console.error('Local picker error:', error);
    }
  }

  private async pickRemote(): Promise<void> {
    const restrict = this.restrictToCurrentRemote();
    const result = await this.fileSystem.selectPathWithNautilus({
      mode: restrict ? 'remote' : 'both',
      selection: this.pickerSelection(),
      multi: this.multi(),
      allowedRemotes: restrict ? [this.currentRemote()] : undefined,
      initialLocation: this.initialLocation(restrict),
    });
    if (result.cancelled || !result.items.length) return;

    this.dirty.emit();
    const group = this.control();
    const extras: PathGroup[] = [];
    result.items.forEach((item, index) => {
      const data = this.resolve(item);
      if (!data) return;
      if (index === 0) {
        group.get('path')?.setValue(data.path);
        group.get('type')?.setValue(data.type);
        group.get('remote')?.setValue(data.remote || '');
      } else {
        extras.push(data);
      }
    });
    if (extras.length) this.morePicked.emit(extras);
  }

  private initialLocation(restrict: boolean): string | undefined {
    if (this.type() === 'local') return this.path() || undefined;
    const remote = restrict ? this.currentRemote() : this.remoteName();
    if (!remote) return undefined;
    return this.path() ? pathUtils.joinPath(`${remote}:`, this.path()) : `${remote}:`;
  }

  private resolve(item: FileBrowserItem): PathGroup | null {
    const data = this.pathService.resolvePathGroup(item, this.currentRemote());
    if (this.localOnly() && data.type !== 'local') {
      this.notifications.showError(
        this.translate.instant('wizards.appOperation.mountDestMustBeLocal')
      );
      return null;
    }
    return data;
  }

  // ── Folder check ─────────────────────────────────────────────────────────

  private clearInspection(): void {
    this.cancelInspection?.();
    this.cancelInspection = null;
    this.lastInspection = null;
    if (this.status() !== null) this.status.set(null);
  }

  private runInspection(
    path: string,
    remote: string,
    profile: string | undefined,
    op: DefaultPathOp,
    quickRunId: string | null
  ): void {
    const trimmed = path.trim();
    if (!trimmed) {
      this.clearInspection();
      return;
    }
    const key = JSON.stringify([remote, profile, quickRunId, op, trimmed]);
    if (this.lastInspection === key) return;
    this.lastInspection = key;
    this.cancelInspection?.();
    this.status.set(null);
    this.cancelInspection = inspectAfterPause(
      this.inspector,
      { path: trimmed, remoteName: remote, profileName: profile, operation: op, quickRunId },
      status => {
        // The effect that follows an edit may not have run yet: an answer for the old path is dropped.
        if (this.path().trim() === trimmed) this.status.set(status);
      }
    );
  }
}
