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
  untracked,
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
import { MatDividerModule } from '@angular/material/divider';
import { MatExpansionModule } from '@angular/material/expansion';
import { TranslatePipe } from '@ngx-translate/core';

import {
  UserPresetTemplate,
  TemplateCategory,
  TEMPLATE_CATEGORIES,
  isTemplateCategory,
  isTemplateCategoryRecord,
} from '@app/types';
import { parseTypedValue, formatValueDisplay, deepEqual } from 'src/app/shared/utils';
import { UserTemplateService } from 'src/app/services/remote/user-template.service';
import { SearchContainerComponent } from '../../components/search-container/search-container.component';
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
import { RemotePresetsService } from 'src/app/services/remote/remote-presets';

export interface TemplateManagerModalData {
  mode: 'save' | 'manage';
  currentValues?: Partial<Record<TemplateCategory, Record<string, unknown>>>;
}

export interface SettingKeyEntry {
  id: string;
  category: TemplateCategory;
  key: string;
  value: unknown;
  displayValue: string;
  selected: boolean;
}

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
    MatDividerModule,
    MatExpansionModule,
    TranslatePipe,
    SearchContainerComponent,
  ],
  templateUrl: './template-manager-modal.component.html',
  styleUrls: ['./template-manager-modal.component.scss', '../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplateManagerModalComponent {
  private readonly fb = inject(FormBuilder);
  readonly userTemplateService = inject(UserTemplateService);
  private readonly presetsService = inject(RemotePresetsService);
  private readonly dialogRef = inject(MatDialogRef<TemplateManagerModalComponent>);
  readonly data = inject<TemplateManagerModalData>(MAT_DIALOG_DATA, { optional: true });
  private readonly destroyRef = inject(DestroyRef);

  readonly availableCategories = TEMPLATE_CATEGORIES;

  // === Top-level UI state ===
  readonly mode = signal<'save' | 'manage'>(this.data?.mode ?? 'save');
  readonly isSearchVisible = signal<boolean>(false);
  readonly keySearchQuery = signal<string>('');

  // === Save tab state ===
  readonly saveForm = this.fb.nonNullable.group({
    name: ['', [Validators.required]],
    description: [''],
  });
  readonly saveViewMode = signal<'visual' | 'json'>('visual');
  readonly saveJsonError = signal<string | null>(null);
  readonly settingEntries = signal<SettingKeyEntry[]>(
    extractEntriesFromCurrentValues(this.data?.currentValues)
  );
  readonly selectedKeysCount = computed(() => this.settingEntries().filter(e => e.selected).length);

  // === Manage tab state ===
  readonly selectedTemplateId = signal<string | null>(null);
  readonly selectedTemplate = computed<UserPresetTemplate | null>(() => {
    const id = this.selectedTemplateId();
    if (!id) return null;
    return this.userTemplateService.userTemplates().find(t => t.id === id) ?? null;
  });
  readonly draftName = signal<string>('');
  readonly draftDescription = signal<string>('');
  readonly draftValues = signal<Partial<Record<TemplateCategory, Record<string, unknown>>>>({});
  readonly manageViewMode = signal<'visual' | 'json'>('visual');
  readonly jsonEditorContent = signal<string>('');
  readonly jsonParseError = signal<string | null>(null);

  readonly isManageDirty = computed<boolean>(() => {
    const tpl = this.selectedTemplate();
    if (!tpl) return false;
    if (this.draftName().trim() !== (tpl.name || '').trim()) return true;
    if (this.draftDescription().trim() !== (tpl.description || '').trim()) return true;
    // Use order-insensitive deep equality instead of JSON.stringify which
    // would falsely report dirty on key reorder and stringifies twice per call.
    return !deepEqual(this.draftValues() ?? {}, tpl.values ?? {});
  });

  // === Add-key row drafts (shared between Save and Manage tabs) ===
  // One draft per category so input fields across both tabs read/write the
  // same in-flight text without cross-contaminating actual template state.
  private readonly draftKeyByCategory = signal<Partial<Record<TemplateCategory, string>>>({});
  private readonly draftValByCategory = signal<Partial<Record<TemplateCategory, string>>>({});

  // === CodeMirror state ===
  private readonly saveEditorContainer = viewChild<ElementRef<HTMLElement>>('saveEditorContainer');
  private readonly manageEditorContainer =
    viewChild<ElementRef<HTMLElement>>('manageEditorContainer');
  private saveEditorView: EditorView | null = null;
  private manageEditorView: EditorView | null = null;

  readonly String = String;

  constructor() {
    // CodeMirror lifecycle — single helper drives both Save and Manage tabs.
    this.setupEditorLifecycle('save');
    this.setupEditorLifecycle('manage');

    effect(() => {
      const templates = this.userTemplateService.userTemplates();
      const currentId = this.selectedTemplateId();
      if (!currentId || !templates.some(t => t.id === currentId)) {
        this.selectedTemplateId.set(templates[0]?.id ?? null);
      }
    });

    effect(() => {
      const id = this.selectedTemplateId();
      untracked(() => {
        const tpl = this.userTemplateService.userTemplates().find(t => t.id === id);
        this.draftName.set(tpl?.name ?? '');
        this.draftDescription.set(tpl?.description ?? '');
        this.draftValues.set(structuredClone(tpl?.values ?? {}));
        const jsonStr = JSON.stringify(tpl?.values ?? {}, null, 2);
        this.jsonEditorContent.set(jsonStr);
        this.jsonParseError.set(null);
        this.dispatchEditorText('manage', jsonStr);
      });
    });

    this.destroyRef.onDestroy(() => {
      this.saveEditorView?.destroy();
      this.manageEditorView?.destroy();
    });
  }

  /**
   * Wire one CodeMirror editor instance to its container + view-mode signal.
   * Replaces the previously duplicated pair of near-identical effects.
   */
  private setupEditorLifecycle(which: 'save' | 'manage'): void {
    const container = which === 'save' ? this.saveEditorContainer : this.manageEditorContainer;
    const viewMode = which === 'save' ? this.saveViewMode : this.manageViewMode;

    effect(() => {
      const el = container();
      const isJsonView = viewMode() === 'json';
      if (el && isJsonView) {
        requestAnimationFrame(() => this.initEditor(which, el.nativeElement));
      } else if (which === 'save') {
        this.saveEditorView?.destroy();
        this.saveEditorView = null;
      } else {
        this.manageEditorView?.destroy();
        this.manageEditorView = null;
      }
    });
  }

  // === Header / search ===
  toggleSearch(): void {
    this.isSearchVisible.update(v => !v);
    if (!this.isSearchVisible()) {
      this.keySearchQuery.set('');
    }
  }

  // === Save tab: entry selection ===
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

  removeSaveKey(id: string): void {
    this.settingEntries.update(entries => entries.filter(e => e.id !== id));
  }

  applyDefaultPresets(): void {
    const presets = this.presetsService.resolvePresets('');

    if (this.mode() === 'save') {
      this.settingEntries.update(entries => {
        const updated = [...entries];
        for (const [cat, kvObj] of Object.entries(presets)) {
          if (!isTemplateCategory(cat) || !kvObj) continue;
          for (const [key, val] of Object.entries(kvObj)) {
            const entryId = `${cat}:${key}`;
            const existingIdx = updated.findIndex(e => e.id === entryId);
            const newEntry: SettingKeyEntry = {
              id: entryId,
              category: cat,
              key,
              value: val,
              displayValue: formatValueDisplay(val),
              selected: true,
            };
            if (existingIdx >= 0) {
              updated[existingIdx] = newEntry;
            } else {
              updated.push(newEntry);
            }
          }
        }
        return updated;
      });

      if (this.saveViewMode() === 'json') {
        const jsonStr = JSON.stringify(this.buildSelectedJson(), null, 2);
        this.dispatchEditorText('save', jsonStr);
      }
    } else {
      const currentValues = structuredClone(this.draftValues() ?? {});
      for (const [cat, kvObj] of Object.entries(presets)) {
        if (!isTemplateCategory(cat) || !kvObj) continue;
        if (!currentValues[cat]) currentValues[cat] = {};
        for (const [key, val] of Object.entries(kvObj)) {
          (currentValues[cat] as Record<string, unknown>)[key] = val;
        }
      }
      this.draftValues.set(currentValues);

      const jsonStr = JSON.stringify(currentValues, null, 2);
      this.jsonEditorContent.set(jsonStr);
      if (this.manageViewMode() === 'json') {
        this.dispatchEditorText('manage', jsonStr);
      }
    }
  }

  // === Manage tab: draft editing ===
  updateTemplateName(name: string): void {
    this.draftName.set(name);
  }

  updateTemplateDesc(description: string): void {
    this.draftDescription.set(description);
  }

  selectTemplate(id: string): void {
    this.selectedTemplateId.set(id);
  }

  // === Shared category accessors ===
  private filterByText<T>(items: T[], query: string, extractor: (item: T) => string): T[] {
    if (!query) return items;
    const q = query.toLowerCase();
    return items.filter(item => extractor(item).toLowerCase().includes(q));
  }

  getSaveCategoryEntries(catKey: TemplateCategory): SettingKeyEntry[] {
    return this.filterByText(
      this.settingEntries().filter(e => e.category === catKey),
      this.keySearchQuery(),
      e => `${e.key} ${e.category} ${e.displayValue}`
    );
  }

  getManageCategoryEntries(catKey: TemplateCategory): [string, unknown][] {
    const obj = this.draftValues()?.[catKey];
    if (!obj) return [];
    return this.filterByText(
      Object.entries(obj),
      this.keySearchQuery(),
      ([k, v]) => `${k} ${catKey} ${String(v)}`
    );
  }

  shouldShowSaveCategory(catKey: TemplateCategory): boolean {
    return !this.keySearchQuery().trim() || this.getSaveCategoryEntries(catKey).length > 0;
  }

  shouldShowManageCategory(catKey: TemplateCategory): boolean {
    return !this.keySearchQuery().trim() || this.getManageCategoryEntries(catKey).length > 0;
  }

  readonly hasAnyMatchingSaveCategory = computed(
    () =>
      !this.keySearchQuery().trim() ||
      this.availableCategories.some(c => this.getSaveCategoryEntries(c).length > 0)
  );

  readonly hasAnyMatchingManageCategory = computed(
    () =>
      !this.keySearchQuery().trim() ||
      this.availableCategories.some(c => this.getManageCategoryEntries(c).length > 0)
  );

  getSaveCategoryTotalCount(catKey: TemplateCategory): number {
    return this.settingEntries().filter(e => e.category === catKey).length;
  }

  getSaveCategorySelectedCount(catKey: TemplateCategory): number {
    return this.settingEntries().filter(e => e.category === catKey && e.selected).length;
  }

  getManageCategoryTotalCount(catKey: TemplateCategory): number {
    const obj = this.draftValues()?.[catKey];
    return obj ? Object.keys(obj).length : 0;
  }

  isSaveCategoryExpanded(catKey: TemplateCategory): boolean {
    if (this.keySearchQuery().trim()) {
      return this.getSaveCategoryEntries(catKey).length > 0;
    }
    return this.getSaveCategoryTotalCount(catKey) > 0;
  }

  isManageCategoryExpanded(catKey: TemplateCategory): boolean {
    if (this.keySearchQuery().trim()) {
      return this.getManageCategoryEntries(catKey).length > 0;
    }
    return this.getManageCategoryTotalCount(catKey) > 0;
  }

  // === Shared add-key row drafts ===
  draftKey(cat: TemplateCategory): string {
    return this.draftKeyByCategory()[cat] ?? '';
  }

  draftVal(cat: TemplateCategory): string {
    return this.draftValByCategory()[cat] ?? '';
  }

  setDraftKey(cat: TemplateCategory, value: string): void {
    this.draftKeyByCategory.update(s => ({ ...s, [cat]: value }));
  }

  setDraftVal(cat: TemplateCategory, value: string): void {
    this.draftValByCategory.update(s => ({ ...s, [cat]: value }));
  }

  isAddKeyDisabled(cat: TemplateCategory): boolean {
    const k = this.draftKeyByCategory()[cat];
    return !k || !k.trim();
  }

  addKeyToCategory(cat: TemplateCategory): void {
    const rawKey = (this.draftKeyByCategory()[cat] ?? '').trim();
    if (!rawKey) return;

    const rawVal = (this.draftValByCategory()[cat] ?? '').trim();
    const parsedVal = parseTypedValue(rawVal);

    if (this.mode() === 'save') {
      const entryId = `${cat}:${rawKey}`;
      this.settingEntries.update(entries => {
        const idx = entries.findIndex(e => e.id === entryId);
        const newEntry: SettingKeyEntry = {
          id: entryId,
          category: cat,
          key: rawKey,
          value: parsedVal,
          displayValue: rawVal || String(parsedVal),
          selected: true,
        };
        if (idx >= 0) {
          const updated = [...entries];
          updated[idx] = newEntry;
          return updated;
        }
        return [newEntry, ...entries];
      });
    } else {
      const currentValues = structuredClone(this.draftValues() ?? {});
      if (!currentValues[cat]) currentValues[cat] = {};
      (currentValues[cat] as Record<string, unknown>)[rawKey] = parsedVal;
      this.draftValues.set(currentValues);

      const jsonStr = JSON.stringify(currentValues, null, 2);
      this.jsonEditorContent.set(jsonStr);
      this.dispatchEditorText('manage', jsonStr);
    }

    this.setDraftKey(cat, '');
    this.setDraftVal(cat, '');
  }

  removeKeyFromCategory(cat: TemplateCategory, key: string): void {
    const currentValues = structuredClone(this.draftValues() ?? {});
    const catObj = currentValues[cat];
    if (catObj) {
      delete (catObj as Record<string, unknown>)[key];
    }
    this.draftValues.set(currentValues);

    const jsonStr = JSON.stringify(currentValues, null, 2);
    this.jsonEditorContent.set(jsonStr);
    this.dispatchEditorText('manage', jsonStr);
  }

  // === View-mode toggle (shared by Save and Manage) ===
  toggleViewMode(which: 'save' | 'manage', mode: 'visual' | 'json'): void {
    const modeSignal = which === 'save' ? this.saveViewMode : this.manageViewMode;
    const errorSignal = which === 'save' ? this.saveJsonError : this.jsonParseError;

    if (mode === 'json') {
      const payload = which === 'save' ? this.buildSelectedJson() : this.draftValues();
      const jsonStr = JSON.stringify(payload, null, 2);
      errorSignal.set(null);
      modeSignal.set('json');
      if (which === 'manage') this.jsonEditorContent.set(jsonStr);
      this.dispatchEditorText(which, jsonStr);
      return;
    }

    // Switching away from JSON: try to parse it back into draft state.
    if (which === 'manage') {
      const text = this.manageEditorView?.state.doc.toString() ?? this.jsonEditorContent();
      try {
        const parsed: unknown = JSON.parse(text);
        if (isTemplateCategoryRecord(parsed)) {
          this.draftValues.set(parsed);
          this.jsonParseError.set(null);
        } else if (parsed !== null) {
          this.jsonParseError.set('Invalid template category record');
        }
      } catch (e) {
        this.jsonParseError.set((e as Error).message);
      }
    }
    modeSignal.set('visual');
  }

  // === Save handlers ===
  onSaveTemplate(): void {
    if (this.saveForm.invalid) return;
    const formVal = this.saveForm.getRawValue();
    const name = formVal.name.trim();
    if (!name) return;

    const filteredValues = buildCategoryValuesFromEntries(
      this.settingEntries().filter(e => e.selected)
    );

    const created = this.userTemplateService.saveTemplate({
      name,
      description: formVal.description.trim() || undefined,
      values: filteredValues,
    });

    this.mode.set('manage');
    this.selectedTemplateId.set(created.id);
  }

  onSaveManageTemplate(): void {
    const id = this.selectedTemplateId();
    const tpl = this.selectedTemplate();
    if (!id || !tpl) return;

    let finalValues = this.draftValues();

    if (this.manageViewMode() === 'json') {
      const text = this.manageEditorView?.state.doc.toString() ?? this.jsonEditorContent();
      try {
        const parsed: unknown = JSON.parse(text);
        if (!isTemplateCategoryRecord(parsed)) {
          throw new Error('JSON content must be a valid template category record.');
        }
        finalValues = parsed;
        this.draftValues.set(parsed);
        this.jsonParseError.set(null);
      } catch (e) {
        this.jsonParseError.set((e as Error).message);
        return;
      }
    }

    this.userTemplateService.updateTemplate({
      ...tpl,
      name: this.draftName() || tpl.name,
      description: this.draftDescription(),
      values: finalValues,
    });
  }

  createNewDraftTemplate(): void {
    this.saveForm.reset({
      name: '',
      description: '',
    });
    this.settingEntries.set([]);
    this.mode.set('save');
  }

  onDeleteUserTemplate(id: string): void {
    try {
      this.userTemplateService.deleteTemplate(id);
      // Auto-select effect handles picking the next template and syncing drafts.
    } catch (e) {
      console.warn('[TemplateManagerModal] Failed to delete template:', e);
    }
  }

  onClose(): void {
    this.dialogRef.close();
  }

  // === CodeMirror helpers ===
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

  private initEditor(which: 'save' | 'manage', container: HTMLElement): void {
    if (which === 'save') {
      if (this.saveEditorView) return;
      const initialJson = JSON.stringify(this.buildSelectedJson(), null, 2);
      this.saveEditorView = this.createCodeMirror(container, initialJson, text =>
        this.handleSaveJsonInput(text)
      );
      return;
    }

    if (this.manageEditorView) return;
    const initialJson =
      this.jsonEditorContent() || JSON.stringify(this.selectedTemplate()?.values ?? {}, null, 2);
    this.manageEditorView = this.createCodeMirror(container, initialJson, text =>
      this.handleManageJsonInput(text)
    );
  }

  private getEditorView(which: 'save' | 'manage'): EditorView | null {
    return which === 'save' ? this.saveEditorView : this.manageEditorView;
  }

  private dispatchEditorText(which: 'save' | 'manage', text: string): void {
    const view = this.getEditorView(which);
    if (!view) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }

  private handleSaveJsonInput(text: string): void {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isTemplateCategoryRecord(parsed)) {
        throw new Error('JSON content must be a valid template category record.');
      }
      this.saveJsonError.set(null);
      this.reconcileSettingEntriesFromCategoryJson(parsed);
    } catch (e) {
      this.saveJsonError.set((e as Error).message);
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

  private buildSelectedJson(): Partial<Record<TemplateCategory, Record<string, unknown>>> {
    return buildCategoryValuesFromEntries(this.settingEntries().filter(e => e.selected));
  }

  private reconcileSettingEntriesFromCategoryJson(
    parsed: Partial<Record<TemplateCategory, Record<string, unknown>>>
  ): void {
    const updatedEntries: SettingKeyEntry[] = [];
    const processedIds = new Set<string>();

    for (const [cat, kvObj] of Object.entries(parsed)) {
      if (!isTemplateCategory(cat)) continue;
      if (kvObj && typeof kvObj === 'object' && !Array.isArray(kvObj)) {
        for (const [key, val] of Object.entries(kvObj)) {
          const entryId = `${cat}:${key}`;
          processedIds.add(entryId);
          updatedEntries.push({
            id: entryId,
            category: cat,
            key,
            value: val,
            displayValue: formatValueDisplay(val),
            selected: true,
          });
        }
      }
    }

    // Retain existing unselected entries if not present in parsed JSON.
    for (const entry of this.settingEntries()) {
      if (!processedIds.has(entry.id)) {
        updatedEntries.push({ ...entry, selected: false });
      }
    }

    this.settingEntries.set(updatedEntries);
  }
}

// === Module-level pure helpers ===

function extractEntriesFromCurrentValues(
  currentValues?: Partial<Record<TemplateCategory, Record<string, unknown>>>
): SettingKeyEntry[] {
  if (!currentValues) return [];
  const entries: SettingKeyEntry[] = [];

  for (const cat of Object.keys(currentValues)) {
    if (!isTemplateCategory(cat)) continue;
    const catObj = currentValues[cat];
    if (catObj && typeof catObj === 'object') {
      for (const [key, val] of Object.entries(catObj)) {
        if (val !== undefined && val !== null && val !== '') {
          entries.push({
            id: `${cat}:${key}`,
            category: cat,
            key,
            value: val,
            displayValue: formatValueDisplay(val),
            selected: true,
          });
        }
      }
    }
  }

  return entries;
}

function buildCategoryValuesFromEntries(
  entries: readonly SettingKeyEntry[]
): Partial<Record<TemplateCategory, Record<string, unknown>>> {
  const result: Partial<Record<TemplateCategory, Record<string, unknown>>> = {};
  for (const item of entries) {
    if (!result[item.category]) result[item.category] = {};
    (result[item.category] as Record<string, unknown>)[item.key] = item.value;
  }
  return result;
}
