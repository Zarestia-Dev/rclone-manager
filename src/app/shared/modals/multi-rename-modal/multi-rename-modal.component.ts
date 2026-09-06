import {
  Component,
  inject,
  signal,
  computed,
  viewChild,
  ElementRef,
  ChangeDetectionStrategy,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ReactiveFormsModule, FormGroup, FormControl, Validators } from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { CdkMenuModule } from '@angular/cdk/menu';
import { MatSelectModule } from '@angular/material/select';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { ErrorStateMatcher } from '@angular/material/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { FileBrowserItem, ExplorerRoot, RenameItem } from '@app/types';
import { PathService } from '../../../services/infrastructure/platform/path.service';
import { RemoteFileOperationsService } from '../../../services/remote/remote-file-operations.service';
import { NotificationService } from '../../../services/ui/notification.service';

export interface MultiRenameData {
  items: FileBrowserItem[];
  remote: ExplorerRoot;
}

export type MultiRenameTargetScope = 'all' | 'files' | 'folders';
export type MultiRenameCaseTransform = 'none' | 'lowercase' | 'uppercase' | 'titlecase';

export interface MultiRenameFormValue {
  targetScope?: MultiRenameTargetScope;
  caseTransform?: MultiRenameCaseTransform;
  preserveExtension?: boolean;
  prefix?: string;
  suffix?: string;
  template?: string;
  counterStart?: number;
  counterStep?: number;
  counterPadding?: number;
  findText?: string;
  replaceWith?: string;
  useRegex?: boolean;
  caseSensitive?: boolean;
}

export interface MultiRenamePreviewItem {
  item: FileBrowserItem;
  originalName: string;
  newName: string;
  isDir: boolean;
  hasError: boolean;
  isChanged: boolean;
}

@Component({
  selector: 'app-multi-rename-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    CdkMenuModule,
    MatSelectModule,
    MatCheckboxModule,
    MatButtonToggleModule,
    ScrollingModule,
    TranslatePipe,
  ],
  templateUrl: './multi-rename-modal.component.html',
  styleUrls: ['./multi-rename-modal.component.scss', '../../../styles/_shared-modal.scss'],
})
export class MultiRenameModalComponent {
  protected readonly dialogRef = inject(MatDialogRef<MultiRenameModalComponent>);
  protected readonly translate = inject(TranslateService);
  protected readonly pathService = inject(PathService);
  protected readonly remoteOps = inject(RemoteFileOperationsService);
  protected readonly notifications = inject(NotificationService);
  public readonly data = inject<MultiRenameData>(MAT_DIALOG_DATA);

  readonly templateInput = viewChild<ElementRef<HTMLInputElement>>('templateInput');

  readonly mode = signal<'template' | 'replace'>('template');
  readonly isSaving = signal(false);

  readonly form = new FormGroup({
    targetScope: new FormControl<MultiRenameTargetScope>('all', { nonNullable: true }),
    caseTransform: new FormControl<MultiRenameCaseTransform>('none', { nonNullable: true }),
    preserveExtension: new FormControl<boolean>(true, { nonNullable: true }),
    prefix: new FormControl<string>('', { nonNullable: true }),
    suffix: new FormControl<string>('', { nonNullable: true }),
    template: new FormControl<string>('[Original file name]', { nonNullable: true }),
    counterStart: new FormControl<number>(1, {
      nonNullable: true,
      validators: [Validators.min(0)],
    }),
    counterStep: new FormControl<number>(1, { nonNullable: true, validators: [Validators.min(1)] }),
    counterPadding: new FormControl<number>(2, { nonNullable: true }),
    findText: new FormControl<string>('', { nonNullable: true }),
    replaceWith: new FormControl<string>('', { nonNullable: true }),
    useRegex: new FormControl<boolean>(false, { nonNullable: true }),
    caseSensitive: new FormControl<boolean>(false, { nonNullable: true }),
  });

  // Track form values as a signal
  readonly formValue = toSignal(this.form.valueChanges, { initialValue: this.form.value });

  // Validate regex syntax when in replace mode with useRegex enabled
  readonly regexError = computed<string | null>(() => {
    if (this.mode() !== 'replace') return null;
    const val = this.formValue();
    if (!val.useRegex || !val.findText) return null;
    try {
      new RegExp(val.findText, val.caseSensitive ? 'g' : 'gi');
      return null;
    } catch (e) {
      return (e as Error).message || String(e);
    }
  });

  // Error matcher for findText input when regex is invalid
  readonly regexErrorMatcher: ErrorStateMatcher = {
    isErrorState: () => !!this.regexError(),
  };

  // Compute whether to show counter options
  readonly showCounterConfig = computed(() => {
    const tpl = this.formValue().template || '';
    return tpl.includes('[Counter]');
  });

  // Compute live preview of renamed items
  readonly previewItems = computed<MultiRenamePreviewItem[]>(() => {
    const items = this.data.items;
    const currentMode = this.mode();
    const val = this.formValue();

    // Track index of matched items for sequential counter
    let matchCounter = 0;

    const results: MultiRenamePreviewItem[] = items.map(item => {
      const originalName = item.entry.Name;
      const isDir = !!item.entry.IsDir;
      const scope = val.targetScope ?? 'all';

      const isTargeted =
        scope === 'all' || (scope === 'files' && !isDir) || (scope === 'folders' && isDir);

      let newName = originalName;
      if (isTargeted) {
        newName = this.calculateNewName(item, matchCounter, currentMode, val);
        matchCounter++;
      }

      const isInvalid = !this.isValidFilename(newName);

      return {
        item,
        originalName,
        newName,
        isDir,
        hasError: isInvalid,
        isChanged: newName !== originalName,
      };
    });

    // Check for duplicates among targets
    const names = results.map(r => r.newName);
    results.forEach(r => {
      if (r.hasError) return;
      if (names.filter(n => n === r.newName).length > 1) {
        r.hasError = true;
      }
    });

    return results;
  });

  // Summary counts
  readonly totalCount = computed(() => this.previewItems().length);
  readonly changedCount = computed(() => this.previewItems().filter(p => p.isChanged).length);
  readonly unchangedCount = computed(() => this.previewItems().filter(p => !p.isChanged).length);
  readonly conflictCount = computed(() => this.previewItems().filter(p => p.hasError).length);

  // Returns true if any preview item has a validation error or invalid regex
  readonly hasErrors = computed(() => {
    if (this.regexError()) return true;
    return this.previewItems().some(p => p.hasError);
  });

  // Returns true if any new name is different from the original name
  readonly hasChanges = computed(() => {
    return this.changedCount() > 0;
  });

  setMode(newMode: 'template' | 'replace'): void {
    this.mode.set(newMode);
  }

  insertPlaceholder(placeholder: string): void {
    const templateInput = this.templateInput();
    if (!templateInput) return;
    const inputEl = templateInput.nativeElement;
    const start = inputEl.selectionStart ?? 0;
    const end = inputEl.selectionEnd ?? 0;
    const val = this.form.value.template || '';
    const newVal = val.substring(0, start) + placeholder + val.substring(end);

    this.form.patchValue({ template: newVal });

    setTimeout(() => {
      inputEl.focus();
      inputEl.selectionStart = inputEl.selectionEnd = start + placeholder.length;
    });
  }

  dismiss(result = false): void {
    this.dialogRef.close(result);
  }

  async onConfirm(): Promise<void> {
    if (this.hasErrors() || !this.hasChanges() || this.isSaving()) return;

    this.isSaving.set(true);
    const remoteName = this.pathService.normalizeExplorerRoot(this.data.remote);
    const previews = this.previewItems();

    try {
      const renameItems: RenameItem[] = previews
        .filter(p => p.isChanged)
        .map(p => {
          const parentDir = this.pathService.getParentPath(p.item.entry.Path);
          const newPath = this.pathService.joinPath(parentDir, p.newName);
          return {
            remote: remoteName,
            srcPath: p.item.entry.Path,
            dstPath: newPath,
            isDir: p.isDir,
          };
        });

      await this.remoteOps.renameBatch(renameItems, 'filemanager');
      this.notifications.showSuccess(
        this.translate.instant('nautilus.notifications.renameStarted')
      );
      this.dismiss(true);
    } catch (err) {
      console.error('Batch rename failed', err);
      this.notifications.showError(
        this.translate.instant('nautilus.errors.renameFailed', {
          name: 'selected files',
          error: (err as Error).message || String(err),
        })
      );
    } finally {
      this.isSaving.set(false);
    }
  }

  private calculateNewName(
    item: FileBrowserItem,
    index: number,
    currentMode: 'template' | 'replace',
    val: MultiRenameFormValue
  ): string {
    const filename = item.entry.Name;
    const isDir = !!item.entry.IsDir;
    const preserveExt = !isDir && (val.preserveExtension ?? true);

    const { base, ext } = preserveExt ? this.getBaseAndExt(filename) : { base: filename, ext: '' };

    let transformedBase = base;

    if (currentMode === 'template') {
      let tpl = val.template ?? '';
      if (!tpl) return filename;

      tpl = tpl.replace(/\[Original file name\]/g, base);
      tpl = tpl.replace(/\[Name\]/g, base);

      if (tpl.includes('[Extension]')) {
        const cleanExt = ext.startsWith('.') ? ext.substring(1) : ext;
        tpl = tpl.replace(/\[Extension\]/g, cleanExt);
      }

      if (tpl.includes('[Counter]')) {
        const start = val.counterStart ?? 1;
        const step = val.counterStep ?? 1;
        const pad = val.counterPadding ?? 2;
        const countVal = start + index * step;
        const formattedCounter = countVal.toString().padStart(pad, '0');
        tpl = tpl.replace(/\[Counter\]/g, formattedCounter);
      }

      if (tpl.includes('[Date]')) {
        const dateStr = new Date().toISOString().split('T')[0];
        tpl = tpl.replace(/\[Date\]/g, dateStr);
      }

      if (tpl.includes('[ModDate]')) {
        const modDate = item.entry.ModTime ? item.entry.ModTime.split('T')[0] : '';
        const fallbackDate = new Date().toISOString().split('T')[0];
        tpl = tpl.replace(/\[ModDate\]/g, modDate || fallbackDate);
      }

      transformedBase = tpl;
    } else {
      const find = val.findText || '';
      const replace = val.replaceWith || '';
      const caseSensitive = val.caseSensitive ?? false;
      const useRegex = val.useRegex ?? false;

      if (find) {
        transformedBase = this.replaceStr(base, find, replace, caseSensitive, useRegex);
      }
    }

    // Apply Prefix & Suffix
    if (val.prefix) {
      transformedBase = val.prefix + transformedBase;
    }
    if (val.suffix) {
      transformedBase = transformedBase + val.suffix;
    }

    // Apply Case Transform
    const caseType = val.caseTransform ?? 'none';
    transformedBase = this.applyCaseTransform(transformedBase, caseType);

    // If preserveExt is true and [Extension] was not in the template, re-attach extension
    if (preserveExt) {
      if (currentMode === 'template' && val.template?.includes('[Extension]')) {
        return transformedBase;
      }
      return transformedBase + ext;
    }

    return transformedBase;
  }

  private applyCaseTransform(str: string, transform: MultiRenameCaseTransform): string {
    switch (transform) {
      case 'lowercase':
        return str.toLowerCase();
      case 'uppercase':
        return str.toUpperCase();
      case 'titlecase':
        return str.replace(/\b\w/g, char => char.toUpperCase());
      default:
        return str;
    }
  }

  private getBaseAndExt(filename: string): { base: string; ext: string } {
    if (filename.startsWith('.') && filename.substring(1).indexOf('.') === -1) {
      return { base: filename, ext: '' };
    }
    const lastDot = filename.lastIndexOf('.');
    if (lastDot > 0) {
      return {
        base: filename.substring(0, lastDot),
        ext: filename.substring(lastDot),
      };
    }
    return { base: filename, ext: '' };
  }

  private isValidFilename(name: string): boolean {
    if (!name || name.trim() === '') return false;
    // Disallow control characters and cross-platform forbidden chars: < > : " / \ | ? *
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f<>:"/\\|?*]/.test(name)) return false;
    // Cannot end with space or dot (Windows file system restriction)
    if (/[. ]$/.test(name)) return false;
    // Check reserved names (CON, PRN, AUX, NUL, COM1..9, LPT1..9)
    const baseName = name.split('.')[0].toUpperCase();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(baseName)) return false;
    return true;
  }

  private replaceStr(
    str: string,
    find: string,
    replaceVal: string,
    caseSensitive: boolean,
    useRegex: boolean
  ): string {
    try {
      const pattern = useRegex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const flags = caseSensitive ? 'g' : 'gi';
      const regex = new RegExp(pattern, flags);
      return str.replace(regex, replaceVal);
    } catch {
      return str;
    }
  }
}
