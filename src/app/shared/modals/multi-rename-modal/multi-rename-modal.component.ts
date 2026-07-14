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
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { FileBrowserItem, ExplorerRoot } from '@app/types';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { NotificationService } from 'src/app/services/ui/notification.service';

export interface MultiRenameData {
  items: FileBrowserItem[];
  remote: ExplorerRoot;
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
    template: new FormControl('[Original file name]', { nonNullable: true }),
    counterStart: new FormControl(1, { nonNullable: true, validators: [Validators.min(0)] }),
    counterStep: new FormControl(1, { nonNullable: true, validators: [Validators.min(1)] }),
    counterPadding: new FormControl(2, { nonNullable: true }),
    findText: new FormControl('', { nonNullable: true }),
    replaceWith: new FormControl('', { nonNullable: true }),
    caseSensitive: new FormControl(false, { nonNullable: true }),
  });

  // Track form values as a signal
  readonly formValue = toSignal(this.form.valueChanges, { initialValue: this.form.value });

  // Compute whether to show counter options
  readonly showCounterConfig = computed(() => {
    const tpl = this.formValue().template || '';
    return tpl.includes('[Counter]');
  });

  // Compute live preview of renamed items
  readonly previewItems = computed(() => {
    const items = this.data.items;
    const currentMode = this.mode();
    const val = this.formValue();

    const results = items.map((item, index) => {
      const originalName = item.entry.Name;
      const newName = this.calculateNewName(item, index, currentMode, val);
      return {
        item,
        originalName,
        newName,
        hasError: !newName || newName.trim() === '',
      };
    });

    // Check for duplicates
    const names = results.map(r => r.newName);
    results.forEach(r => {
      if (!r.newName || r.newName.trim() === '') {
        r.hasError = true;
      } else if (names.filter(n => n === r.newName).length > 1) {
        r.hasError = true;
      }
    });

    return results;
  });

  // Returns true if any preview item has a validation error
  readonly hasErrors = computed(() => {
    return this.previewItems().some(p => p.hasError);
  });

  // Returns true if any new name is different from the original name
  readonly hasChanges = computed(() => {
    return this.previewItems().some(p => p.newName !== p.originalName);
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

    // Defer resetting the cursor selection
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
    const remoteName = this.pathService.normalizeRemoteForRclone(this.data.remote.name);
    const previews = this.previewItems();

    try {
      // Execute all rename operations
      const promises = previews
        .filter(p => p.newName !== p.originalName)
        .map(p => {
          const parentDir = this.pathService.getParentPath(p.item.entry.Path);
          const newPath = this.pathService.joinPath(parentDir, p.newName);
          return this.remoteOps.rename(
            remoteName,
            p.item.entry.Path,
            newPath,
            !!p.item.entry.IsDir,
            'filemanager'
          );
        });

      await Promise.all(promises);
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
    val: any
  ): string {
    const filename = item.entry.Name;
    const { base, ext } = this.getBaseAndExt(filename);

    if (currentMode === 'template') {
      let tpl = val.template || '';
      if (!tpl) return filename;

      // Replace placeholders
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
        const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        tpl = tpl.replace(/\[Date\]/g, dateStr);
      }

      // If [Extension] placeholder is not explicitly typed, preserve original file extension
      if (!val.template?.includes('[Extension]')) {
        return tpl + ext;
      }
      return tpl;
    } else {
      // Find & Replace mode
      const find = val.findText || '';
      const replace = val.replaceWith || '';
      const caseSensitive = val.caseSensitive ?? false;

      if (!find) return filename;

      const newBase = this.replaceStr(base, find, replace, caseSensitive);
      return newBase + ext;
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

  private replaceStr(
    str: string,
    find: string,
    replaceVal: string,
    caseSensitive: boolean
  ): string {
    try {
      const escapedFind = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const flags = caseSensitive ? 'g' : 'gi';
      const regex = new RegExp(escapedFind, flags);
      return str.replace(regex, replaceVal);
    } catch {
      return str;
    }
  }
}
