import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  computed,
  viewChild,
  ElementRef,
  effect,
  DestroyRef,
  afterNextRender,
  Injector,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators, FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatListModule } from '@angular/material/list';
import { MatTabsModule } from '@angular/material/tabs';
import { TranslatePipe } from '@ngx-translate/core';

import { UserPresetTemplate, TemplateCategory } from '@app/types';
import { UserTemplateService } from 'src/app/services/remote/user-template.service';
import { SearchContainerComponent } from '../../components/search-container/search-container.component';
import { AlertBannerComponent } from '../../components/alert-banner/alert-banner.component';
import { EscapeCloseDirective } from '../../directives/escape-close.directive';

import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import {
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { linter, lintGutter } from '@codemirror/lint';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';

export interface TemplateManagerModalData {
  mode: 'save' | 'manage';
  currentValues?: Partial<Record<TemplateCategory, Record<string, unknown>>>;
  remoteType?: string;
}

export interface SettingKeyEntry {
  id: string; // e.g. "vfs:cache_mode"
  category: TemplateCategory;
  key: string;
  value: unknown;
  displayValue: string;
  selected: boolean;
}

function parseTypedValue(val: string): unknown {
  const trimmed = val.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  try {
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      return JSON.parse(trimmed);
    }
  } catch {
    // fallback to plain string
  }
  return trimmed;
}

const CATEGORY_LIST: TemplateCategory[] = [
  'vfs',
  'mount',
  'backend',
  'filter',
  'sync',
  'copy',
  'remote',
  'operation',
];

@Component({
  selector: 'app-template-manager-modal',
  hostDirectives: [EscapeCloseDirective],
  imports: [
    ReactiveFormsModule,
    FormsModule,
    MatDialogModule,
    MatIconModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatCheckboxModule,
    MatListModule,
    MatTabsModule,
    TranslatePipe,
    SearchContainerComponent,
    AlertBannerComponent,
  ],
  templateUrl: './template-manager-modal.component.html',
  styleUrls: ['./template-manager-modal.component.scss', '../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplateManagerModalComponent {
  private readonly fb = inject(FormBuilder);
  readonly userTemplateService = inject(UserTemplateService);
  private readonly dialogRef = inject(MatDialogRef<TemplateManagerModalComponent>);
  readonly data = inject<TemplateManagerModalData>(MAT_DIALOG_DATA, { optional: true });
  private readonly destroyRef = inject(DestroyRef);

  readonly mode = signal<'save' | 'manage'>(this.data?.mode ?? 'save');
  readonly isSearchVisible = signal<boolean>(false);

  toggleSearch(): void {
    this.isSearchVisible.update(v => !v);
    if (!this.isSearchVisible()) {
      this.keySearchQuery.set('');
    }
  }
  readonly Object = Object;
  readonly String = String;
  readonly availableCategories = CATEGORY_LIST;

  // --- Save Form State ---
  readonly saveForm = this.fb.group({
    name: ['', [Validators.required, Validators.maxLength(50)]],
    description: ['', [Validators.maxLength(200)]],
    remoteType: [this.data?.remoteType ?? ''],
  });

  readonly keySearchQuery = signal<string>('');
  readonly saveViewMode = signal<'visual' | 'json'>('visual');
  readonly saveJsonError = signal<string | null>(null);

  // Extract non-empty setting keys from currentValues
  readonly settingEntries = signal<SettingKeyEntry[]>(
    this.extractEntriesFromCurrentValues(this.data?.currentValues)
  );

  // Manual key addition in Save mode
  readonly showAddKeyForm = signal<boolean>(false);
  readonly newKeyCategory = signal<TemplateCategory>('vfs');
  readonly newKeyName = signal<string>('');
  readonly newKeyValue = signal<string>('');

  // Manual key editing in Save mode
  readonly editingEntryId = signal<string | null>(null);
  readonly editingValueText = signal<string>('');

  readonly filteredEntries = computed(() => {
    const query = this.keySearchQuery().trim().toLowerCase();
    const entries = this.settingEntries();
    if (!query) return entries;
    return entries.filter(
      e =>
        e.key.toLowerCase().includes(query) ||
        e.category.toLowerCase().includes(query) ||
        e.displayValue.toLowerCase().includes(query)
    );
  });

  readonly selectedKeysCount = computed(() => this.settingEntries().filter(e => e.selected).length);

  // --- Manage Templates State ---
  readonly selectedTemplateId = signal<string | null>(
    this.userTemplateService.userTemplates()[0]?.id ?? null
  );

  readonly selectedTemplate = computed<UserPresetTemplate | null>(() => {
    const id = this.selectedTemplateId();
    if (!id) return null;
    return this.userTemplateService.userTemplates().find(t => t.id === id) ?? null;
  });

  readonly manageViewMode = signal<'visual' | 'json'>('visual');
  readonly jsonEditorContent = signal<string>('');
  readonly jsonParseError = signal<string | null>(null);

  // Visual mode key addition in Manage mode
  readonly addingCatKey = signal<TemplateCategory | null>(null);
  readonly catKeyInput = signal<string>('');
  readonly catValInput = signal<string>('');

  // CodeMirror References & Instances
  private readonly saveEditorContainer = viewChild<ElementRef<HTMLElement>>('saveEditorContainer');
  private readonly manageEditorContainer =
    viewChild<ElementRef<HTMLElement>>('manageEditorContainer');

  private saveEditorView: EditorView | null = null;
  private manageEditorView: EditorView | null = null;

  private readonly injector = inject(Injector);

  constructor() {
    // Synchronize initial JSON editor content when a template is selected
    const initialTpl = this.selectedTemplate();
    if (initialTpl) {
      this.jsonEditorContent.set(JSON.stringify(initialTpl.values || {}, null, 2));
    }

    // Effect for Save Tab CodeMirror instance
    effect(() => {
      const container = this.saveEditorContainer();
      const isJsonView = this.saveViewMode() === 'json';
      if (container && isJsonView) {
        afterNextRender(() => this.initSaveCodeMirror(container.nativeElement), {
          injector: this.injector,
        });
      } else {
        this.saveEditorView?.destroy();
        this.saveEditorView = null;
      }
    });

    // Effect for Manage Tab CodeMirror instance
    effect(() => {
      const container = this.manageEditorContainer();
      const isJsonView = this.manageViewMode() === 'json';
      if (container && isJsonView) {
        afterNextRender(() => this.initManageCodeMirror(container.nativeElement), {
          injector: this.injector,
        });
      } else {
        this.manageEditorView?.destroy();
        this.manageEditorView = null;
      }
    });

    this.destroyRef.onDestroy(() => {
      this.saveEditorView?.destroy();
      this.manageEditorView?.destroy();
    });
  }

  private createCodeMirror(
    container: HTMLElement,
    initialContent: string,
    onContentChange: (val: string) => void
  ): EditorView {
    const extensions = [
      history(),
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...closeBracketsKeymap, indentWithTab]),
      json(),
      lintGutter(),
      linter(jsonParseLinter()),
      EditorView.theme({}, { dark: document.documentElement.classList.contains('dark') }),
      EditorView.updateListener.of(update => {
        if (!update.docChanged) return;
        onContentChange(update.state.doc.toString());
      }),
    ];

    return new EditorView({
      state: EditorState.create({ doc: initialContent, extensions }),
      parent: container,
    });
  }

  private initSaveCodeMirror(container: HTMLElement): void {
    if (this.saveEditorView) return;
    const initialJson = JSON.stringify(this.buildSelectedJson(), null, 2);
    this.saveEditorView = this.createCodeMirror(container, initialJson, text => {
      this.handleSaveJsonInput(text);
    });
  }

  private initManageCodeMirror(container: HTMLElement): void {
    if (this.manageEditorView) return;
    const initialJson =
      this.jsonEditorContent() || JSON.stringify(this.selectedTemplate()?.values || {}, null, 2);
    this.manageEditorView = this.createCodeMirror(container, initialJson, text => {
      this.handleManageJsonInput(text);
    });
  }

  private buildSelectedJson(): Partial<Record<TemplateCategory, Record<string, unknown>>> {
    const selected = this.settingEntries().filter(e => e.selected);
    const result: Partial<Record<TemplateCategory, Record<string, unknown>>> = {};

    for (const item of selected) {
      if (!result[item.category]) {
        result[item.category] = {};
      }
      (result[item.category] as Record<string, unknown>)[item.key] = item.value;
    }
    return result;
  }

  toggleSaveViewMode(mode: 'visual' | 'json'): void {
    if (mode === 'json') {
      const jsonStr = JSON.stringify(this.buildSelectedJson(), null, 2);
      this.saveJsonError.set(null);
      this.saveViewMode.set('json');
      if (this.saveEditorView) {
        this.saveEditorView.dispatch({
          changes: { from: 0, to: this.saveEditorView.state.doc.length, insert: jsonStr },
        });
      }
    } else {
      this.saveViewMode.set('visual');
    }
  }

  private handleSaveJsonInput(text: string): void {
    try {
      const parsed = JSON.parse(text) as Record<string, Record<string, unknown>>;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('JSON content must be an object.');
      }
      this.saveJsonError.set(null);
      this.reconcileSettingEntriesFromCategoryJson(parsed);
    } catch (e) {
      this.saveJsonError.set((e as Error).message);
    }
  }

  private reconcileSettingEntriesFromCategoryJson(
    parsed: Record<string, Record<string, unknown>>
  ): void {
    const updatedEntries: SettingKeyEntry[] = [];
    const processedIds = new Set<string>();

    for (const [cat, kvObj] of Object.entries(parsed)) {
      if (kvObj && typeof kvObj === 'object' && !Array.isArray(kvObj)) {
        const category = cat as TemplateCategory;
        for (const [key, val] of Object.entries(kvObj)) {
          const entryId = `${category}:${key}`;
          processedIds.add(entryId);
          updatedEntries.push({
            id: entryId,
            category,
            key,
            value: val,
            displayValue: this.formatValueDisplay(val),
            selected: true,
          });
        }
      }
    }

    // Retain existing unselected entries if not in parsed JSON
    for (const entry of this.settingEntries()) {
      if (!processedIds.has(entry.id)) {
        updatedEntries.push({ ...entry, selected: false });
      }
    }

    this.settingEntries.set(updatedEntries);
  }

  private extractEntriesFromCurrentValues(
    currentValues?: Partial<Record<TemplateCategory, Record<string, unknown>>>
  ): SettingKeyEntry[] {
    if (!currentValues) return [];
    const entries: SettingKeyEntry[] = [];

    const categories = Object.keys(currentValues) as TemplateCategory[];
    for (const cat of categories) {
      const catObj = currentValues[cat];
      if (catObj && typeof catObj === 'object') {
        for (const [key, val] of Object.entries(catObj)) {
          if (val !== undefined && val !== null && val !== '') {
            entries.push({
              id: `${cat}:${key}`,
              category: cat,
              key,
              value: val,
              displayValue: this.formatValueDisplay(val),
              selected: true,
            });
          }
        }
      }
    }

    return entries;
  }

  private formatValueDisplay(val: unknown): string {
    if (typeof val === 'boolean') return val ? 'true' : 'false';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  }

  toggleEntry(id: string): void {
    this.settingEntries.update(entries =>
      entries.map(e => (e.id === id ? { ...e, selected: !e.selected } : e))
    );
  }

  selectAllKeys(): void {
    this.settingEntries.update(entries => entries.map(e => ({ ...e, selected: true })));
  }

  deselectAllKeys(): void {
    this.settingEntries.update(entries => entries.map(e => ({ ...e, selected: false })));
  }

  addCustomSettingKey(): void {
    const key = this.newKeyName().trim();
    if (!key) return;

    const cat = this.newKeyCategory();
    const rawValStr = this.newKeyValue().trim();
    const parsedVal = parseTypedValue(rawValStr);
    const entryId = `${cat}:${key}`;

    this.settingEntries.update(entries => {
      const existingIdx = entries.findIndex(e => e.id === entryId);
      const newEntry: SettingKeyEntry = {
        id: entryId,
        category: cat,
        key,
        value: parsedVal,
        displayValue: rawValStr || String(parsedVal),
        selected: true,
      };

      if (existingIdx >= 0) {
        const updated = [...entries];
        updated[existingIdx] = newEntry;
        return updated;
      }
      return [newEntry, ...entries];
    });

    this.newKeyName.set('');
    this.newKeyValue.set('');
    this.showAddKeyForm.set(false);
  }

  startEditEntry(entry: SettingKeyEntry, event: Event): void {
    event.stopPropagation();
    this.editingEntryId.set(entry.id);
    this.editingValueText.set(entry.displayValue);
  }

  saveEditEntry(id: string, event: Event): void {
    event.stopPropagation();
    const newStr = this.editingValueText().trim();
    const parsedVal = parseTypedValue(newStr);

    this.settingEntries.update(entries =>
      entries.map(e =>
        e.id === id
          ? {
              ...e,
              value: parsedVal,
              displayValue: newStr || String(parsedVal),
            }
          : e
      )
    );

    this.editingEntryId.set(null);
  }

  cancelEditEntry(event: Event): void {
    event.stopPropagation();
    this.editingEntryId.set(null);
  }

  onSaveTemplate(): void {
    if (this.saveForm.invalid) return;
    const formVal = this.saveForm.value;
    const selected = this.settingEntries().filter(e => e.selected);

    const filteredValues: Partial<Record<TemplateCategory, Record<string, unknown>>> = {};

    for (const item of selected) {
      if (!filteredValues[item.category]) {
        filteredValues[item.category] = {};
      }
      (filteredValues[item.category] as Record<string, unknown>)[item.key] = item.value;
    }

    const created = this.userTemplateService.saveTemplate({
      name: formVal.name?.trim() || 'Untitled Template',
      description: formVal.description?.trim(),
      remoteType: formVal.remoteType || undefined,
      values: filteredValues,
    });

    this.dialogRef.close({ action: 'saved', template: created });
  }

  // --- Manage Templates Handlers ---
  createNewDraftTemplate(): void {
    this.saveForm.reset({
      name: '',
      description: '',
      remoteType: this.data?.remoteType ?? '',
    });
    this.settingEntries.set([]);
    this.mode.set('save');
  }

  selectTemplate(id: string): void {
    this.selectedTemplateId.set(id);
    const tpl = this.userTemplateService.userTemplates().find(t => t.id === id);
    if (tpl) {
      const jsonStr = JSON.stringify(tpl.values || {}, null, 2);
      this.jsonEditorContent.set(jsonStr);
      this.jsonParseError.set(null);

      if (this.manageEditorView) {
        this.manageEditorView.dispatch({
          changes: { from: 0, to: this.manageEditorView.state.doc.length, insert: jsonStr },
        });
      }
    }
  }

  toggleViewMode(mode: 'visual' | 'json'): void {
    this.manageViewMode.set(mode);
    if (mode === 'json' && this.selectedTemplate()) {
      const jsonStr = JSON.stringify(this.selectedTemplate()?.values || {}, null, 2);
      this.jsonEditorContent.set(jsonStr);
      this.jsonParseError.set(null);
      if (this.manageEditorView) {
        this.manageEditorView.dispatch({
          changes: { from: 0, to: this.manageEditorView.state.doc.length, insert: jsonStr },
        });
      }
    }
  }

  private handleManageJsonInput(text: string): void {
    this.jsonEditorContent.set(text);
    try {
      JSON.parse(text);
      this.jsonParseError.set(null);
    } catch (e) {
      this.jsonParseError.set((e as Error).message);
    }
  }

  onSaveTemplateEdits(): void {
    const tpl = this.selectedTemplate();
    if (!tpl) return;

    try {
      const text = this.manageEditorView?.state.doc.toString() || this.jsonEditorContent();
      const parsedValues = JSON.parse(text);
      if (
        typeof parsedValues !== 'object' ||
        parsedValues === null ||
        Array.isArray(parsedValues)
      ) {
        throw new Error('JSON content must be an object.');
      }

      this.userTemplateService.updateTemplate({
        ...tpl,
        values: parsedValues,
      });

      this.jsonParseError.set(null);
    } catch (e) {
      this.jsonParseError.set((e as Error).message);
    }
  }

  addKeyToCategory(cat: TemplateCategory): void {
    const key = this.catKeyInput().trim();
    if (!key) return;

    const tpl = this.selectedTemplate();
    if (!tpl) return;

    const rawVal = this.catValInput().trim();
    const parsedVal = parseTypedValue(rawVal);

    const currentValues = JSON.parse(JSON.stringify(tpl.values || {})) as Partial<
      Record<TemplateCategory, Record<string, unknown>>
    >;
    if (!currentValues[cat]) {
      currentValues[cat] = {};
    }
    (currentValues[cat] as Record<string, unknown>)[key] = parsedVal;

    this.userTemplateService.updateTemplate({
      ...tpl,
      values: currentValues,
    });

    this.catKeyInput.set('');
    this.catValInput.set('');
    this.addingCatKey.set(null);

    const jsonStr = JSON.stringify(currentValues, null, 2);
    this.jsonEditorContent.set(jsonStr);
    if (this.manageEditorView) {
      this.manageEditorView.dispatch({
        changes: { from: 0, to: this.manageEditorView.state.doc.length, insert: jsonStr },
      });
    }
  }

  removeKeyFromCategory(cat: TemplateCategory, key: string): void {
    const tpl = this.selectedTemplate();
    if (!tpl) return;

    const currentValues = JSON.parse(JSON.stringify(tpl.values || {})) as Partial<
      Record<TemplateCategory, Record<string, unknown>>
    >;
    if (currentValues[cat]) {
      delete (currentValues[cat] as Record<string, unknown>)[key];
    }

    this.userTemplateService.updateTemplate({
      ...tpl,
      values: currentValues,
    });

    const jsonStr = JSON.stringify(currentValues, null, 2);
    this.jsonEditorContent.set(jsonStr);
    if (this.manageEditorView) {
      this.manageEditorView.dispatch({
        changes: { from: 0, to: this.manageEditorView.state.doc.length, insert: jsonStr },
      });
    }
  }

  onDeleteUserTemplate(id: string): void {
    this.userTemplateService.deleteTemplate(id);
    const remaining = this.userTemplateService.userTemplates();
    if (remaining.length > 0) {
      this.selectTemplate(remaining[0].id);
    } else {
      this.selectedTemplateId.set(null);
    }
  }

  onClose(): void {
    this.dialogRef.close();
  }
}
