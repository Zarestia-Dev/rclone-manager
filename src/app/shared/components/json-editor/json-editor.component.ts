import {
  Component,
  ChangeDetectionStrategy,
  input,
  computed,
  signal,
  inject,
  DestroyRef,
  ElementRef,
  viewChild,
  afterNextRender,
  effect,
} from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { switchMap, startWith, map } from 'rxjs';

import { RcConfigOption, SENSITIVE_KEYS } from '@app/types';
import { RcloneValueMapperService, matchesConfigSearch, AppSettingsService } from '@app/services';

import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
} from '@codemirror/view';
import { EditorState, EditorSelection } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { linter, lintGutter } from '@codemirror/lint';
import {
  autocompletion,
  CompletionContext,
  CompletionResult,
  closeBrackets,
  closeBracketsKeymap,
} from '@codemirror/autocomplete';
import { syntaxTree, bracketMatching, indentOnInput } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';

// ============================================================================
// TYPES
// ============================================================================

interface ChipDef {
  controlKey: string;
  displayKey: string;
  label: string;
  currentValue: unknown;
  displayValue: string;
  fullValue: string;
  isChanged: boolean;
  isActive: boolean;
  field: RcConfigOption;
}

// ============================================================================
// HELPERS
// ============================================================================

function isDefaultValue(
  value: unknown,
  field: RcConfigOption,
  mapper?: RcloneValueMapperService
): boolean {
  if (value === null || value === undefined) return true;

  if (field.Type === 'Tristate' && mapper) {
    const valBool = mapper.parseTristate(value);
    const defBool = mapper.parseTristate(field.Default);
    if (valBool === defBool) return true;
    const defStrBool = mapper.parseTristate(field.DefaultStr);
    if (valBool === defStrBool) return true;
    if (valBool === null && (defBool === null || defStrBool === null)) return true;
    return false;
  }

  if (Array.isArray(value)) {
    const arrDef = field.Default;
    if (Array.isArray(arrDef)) return value.length === 0 && arrDef.length === 0;
    return value.length === 0;
  }

  const strVal = String(value);
  if (strVal === String(field.Default)) return true;
  if (strVal === String(field.DefaultStr)) return true;
  if (strVal === '') return true;

  return false;
}

function buildRcloneCompletionSource(getFieldDefs: () => RcConfigOption[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const tree = syntaxTree(context.state);
    const nodeBefore = tree.resolveInner(context.pos, -1);
    const fieldDefs = getFieldDefs();

    // ── KEY position ──────────────────────────────────────────────────────────
    const isPropertyName =
      nodeBefore.name === 'PropertyName' ||
      (nodeBefore.name === 'String' &&
        nodeBefore.parent?.name === 'Property' &&
        nodeBefore.prevSibling === null);

    if (isPropertyName) {
      const word = context.matchBefore(/"[^"]*/) ?? context.matchBefore(/\w*/);
      if (!word && !context.explicit) return null;

      const from = word
        ? nodeBefore.name === 'String'
          ? nodeBefore.from + 1
          : word.from
        : context.pos;

      return {
        from,
        to: nodeBefore.name === 'String' ? nodeBefore.to - 1 : context.pos,
        options: fieldDefs.map(f => ({
          label: f.FieldName || f.Name,
          type: 'property',
          detail: f.Type,
          info: f.Help || undefined,
          boost: 1,
        })),
        validFor: /^[^"]*$/,
      };
    }

    // ── VALUE position ────────────────────────────────────────────────────────
    let cursor = nodeBefore;
    while (cursor.parent && cursor.name !== 'Property') cursor = cursor.parent;

    if (cursor.name !== 'Property') return null;

    const keyNode = cursor.getChild('PropertyName') ?? cursor.firstChild;
    if (!keyNode) return null;

    const rawKey = context.state.sliceDoc(keyNode.from, keyNode.to);
    const keyText = rawKey.replace(/^"|"$/g, '');
    const fieldDef = fieldDefs.find(f => f.FieldName === keyText || f.Name === keyText);

    if (!fieldDef?.Examples?.length) return null;

    const word = context.matchBefore(/"[^"]*/) ?? context.matchBefore(/\w*/);
    const from = word
      ? nodeBefore.name === 'String'
        ? nodeBefore.from + 1
        : word.from
      : context.pos;

    return {
      from,
      options: fieldDef.Examples.map(ex => ({
        label: String(ex.Value ?? ''),
        detail: ex.Help && ex.Help !== ex.Value ? ex.Help : undefined,
        type: 'value',
      })),
      validFor: /^[^"]*$/,
    };
  };
}

// ============================================================================
// COMPONENT
// ============================================================================

@Component({
  selector: 'app-json-editor',
  imports: [MatIconModule, MatTooltipModule, TranslateModule],
  templateUrl: './json-editor.component.html',
  styleUrl: './json-editor.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JsonEditorComponent {
  // ── Inputs ──────────────────────────────────────────────────────────────────
  readonly formGroup = input.required<FormGroup>();
  readonly fieldDefs = input<RcConfigOption[]>([]);
  readonly searchQuery = input('');
  readonly keyPrefix = input('');
  readonly excludeKeys = input<string[]>([]);

  // ── DI ──────────────────────────────────────────────────────────────────────
  private readonly destroyRef = inject(DestroyRef);
  private readonly hostEl = inject(ElementRef<HTMLElement>);
  private readonly valueMapper = inject(RcloneValueMapperService);
  private readonly appSettingsService = inject(AppSettingsService);

  readonly restrictMode = toSignal(
    this.appSettingsService
      .selectSetting('general.restrict')
      .pipe(map(s => (s?.value as boolean) ?? true)),
    { initialValue: true }
  );

  // ── View refs ────────────────────────────────────────────────────────────────
  private readonly editorContainer = viewChild<ElementRef<HTMLElement>>('editorContainer');

  // ── Internal state ───────────────────────────────────────────────────────────
  private editorView: EditorView | null = null;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly explicitKeys = signal<ReadonlySet<string>>(new Set());

  private readonly customControlKeys = signal<ReadonlySet<string>>(new Set());
  readonly parseError = signal<string | null>(null);

  // ── Reactive form value ──────────────────────────────────────────────────────
  private readonly formValue = toSignal(
    toObservable(this.formGroup).pipe(
      switchMap(fg => fg.valueChanges.pipe(startWith(fg.getRawValue())))
    ),
    { initialValue: {} as Record<string, unknown> }
  );

  // ── Chips ────────────────────────────────────────────────────────────────────
  readonly chips = computed<ChipDef[]>(() => {
    const value = this.formValue() as Record<string, unknown>;
    const defs = this.fieldDefs();
    const query = this.searchQuery().trim().toLowerCase();
    const prefix = this.keyPrefix();
    const explicit = this.explicitKeys();

    const excluded = this.buildExcludedSet();
    const baseDefs = defs.filter(f => !excluded.has(prefix + f.Name));
    const filteredDefs = query ? baseDefs.filter(f => matchesConfigSearch(f, query)) : baseDefs;

    return filteredDefs.map(field => {
      const controlKey = prefix + field.Name;
      const currentValue = value[controlKey] ?? null;
      const isChanged = !isDefaultValue(currentValue, field, this.valueMapper);
      const isActive = isChanged || explicit.has(controlKey);

      let displayVal = currentValue;
      if (field.Type === 'Tristate') displayVal = this.valueMapper.parseTristate(currentValue);

      const isSensitive = this.isSensitive(field);
      const mask = this.restrictMode() && isSensitive;

      const rawDisplay = mask
        ? '••••••••'
        : Array.isArray(displayVal)
          ? (displayVal as unknown[]).join(', ')
          : displayVal !== null && displayVal !== undefined
            ? String(displayVal)
            : String(field.DefaultStr ?? field.Default ?? '');

      const displayValue = rawDisplay.length > 20 ? rawDisplay.slice(0, 18) + '…' : rawDisplay;

      return {
        controlKey,
        displayKey: field.FieldName || field.Name,
        label: field.Name,
        currentValue,
        displayValue,
        fullValue: rawDisplay,
        isChanged,
        isActive,
        field,
      };
    });
  });

  constructor() {
    afterNextRender(() => this.initEditor());
    effect(() => {
      this.formValue();
      this.pushFormToEditor();
    });

    this.destroyRef.onDestroy(() => {
      this.editorView?.destroy();
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
    });
  }

  // ============================================================================
  // EDITOR INITIALISATION
  // ============================================================================

  private initEditor(): void {
    const container = this.editorContainer();
    if (!container) return;

    const isDark =
      this.hostEl.nativeElement.closest('[data-theme="dark"]') !== null ||
      window.matchMedia('(prefers-color-scheme: dark)').matches;

    const completionSource = buildRcloneCompletionSource(() => this.fieldDefs());

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
      autocompletion({ override: [completionSource] }),
      ...(isDark ? [oneDark] : []),
      EditorView.baseTheme({
        '&': {
          fontFamily: 'var(--font-mono, "JetBrains Mono", "Fira Code", monospace)',
          fontSize: '13px',
          borderRadius: 'var(--radius-md, 6px)',
          height: '100%',
        },
        '.cm-scroller': { overflow: 'auto' },
        '.cm-content': { padding: '8px 0' },
      }),
      EditorView.updateListener.of(update => {
        if (!update.docChanged) return;
        const text = update.state.doc.toString();
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => this.applyEditorChanges(text), 150);
      }),
    ];

    this.editorView = new EditorView({
      state: EditorState.create({ doc: this.serializeForm(), extensions }),
      parent: container.nativeElement,
    });
  }

  // ============================================================================
  // EDITOR → FORM SYNC
  // ============================================================================

  private applyEditorChanges(text: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.parseError.set('shared.jsonEditor.parseError');
      return;
    }

    this.parseError.set(null);
    this.reconcileFormFromEditor(parsed);
  }

  private reconcileFormFromEditor(parsed: Record<string, unknown>): void {
    const prefix = this.keyPrefix();
    const fg = this.formGroup();
    const defs = this.fieldDefs();
    const excluded = this.buildExcludedSet();
    const restored = this.restorePrefix(parsed);
    this.explicitKeys.set(new Set(Object.keys(restored)));

    // ── Dynamic control management ────────────────────────────────────────────
    const existingControls = new Set(Object.keys(fg.getRawValue()));
    const prevCustom = new Set(this.customControlKeys());
    const nextCustom = new Set<string>();

    for (const [controlKey, val] of Object.entries(restored)) {
      if (excluded.has(controlKey)) continue;

      if (!existingControls.has(controlKey)) {
        fg.addControl(controlKey, new FormControl(val), { emitEvent: false });
        nextCustom.add(controlKey);
      } else if (prevCustom.has(controlKey)) {
        nextCustom.add(controlKey);
      }
    }

    for (const key of prevCustom) {
      if (!nextCustom.has(key)) {
        fg.removeControl(key, { emitEvent: false });
      }
    }

    this.customControlKeys.set(nextCustom);

    // ── Build patch ───────────────────────────────────────────────────────────
    const latestRaw = fg.getRawValue() as Record<string, unknown>;
    const patch: Record<string, unknown> = {};

    for (const controlKey of Object.keys(latestRaw)) {
      if (excluded.has(controlKey)) {
        patch[controlKey] = latestRaw[controlKey];
        continue;
      }

      if (controlKey in restored) {
        const incoming = restored[controlKey];
        patch[controlKey] = incoming === '••••••••' ? latestRaw[controlKey] : incoming;
      } else if (!prefix || controlKey.startsWith(prefix)) {
        const displayKey = prefix ? controlKey.slice(prefix.length) : controlKey;
        const field = defs.find(f => f.Name === displayKey || f.FieldName === displayKey);
        patch[controlKey] = field?.Default ?? field?.DefaultStr ?? null;
      } else {
        patch[controlKey] = latestRaw[controlKey];
      }
    }

    fg.patchValue(patch, { emitEvent: false });
  }

  // ============================================================================
  // FORM → EDITOR SYNC
  // ============================================================================

  private serializeForm(): string {
    try {
      const raw = this.formGroup().getRawValue() as Record<string, unknown>;
      const defs = this.fieldDefs();
      const prefix = this.keyPrefix();
      const explicit = this.explicitKeys();
      const excluded = this.buildExcludedSet();
      const out: Record<string, unknown> = {};

      for (const [controlKey, val] of Object.entries(raw)) {
        if (prefix && !controlKey.startsWith(prefix)) continue;
        if (excluded.has(controlKey)) continue;

        const displayKey = prefix ? controlKey.slice(prefix.length) : controlKey;
        const field = defs.find(f => f.Name === displayKey || f.FieldName === displayKey);
        const isExplicit = explicit.has(controlKey);

        if (field && isDefaultValue(val, field, this.valueMapper) && !isExplicit) continue;
        if (!field && (val === null || val === undefined || val === '') && !isExplicit) continue;

        out[displayKey] = field?.Type === 'Tristate' ? this.valueMapper.parseTristate(val) : val;

        if (this.restrictMode() && this.isSensitive(field)) {
          out[displayKey] = '••••••••';
        }
      }

      return JSON.stringify(out, null, 2);
    } catch {
      return '{}';
    }
  }

  private pushFormToEditor(): void {
    if (!this.editorView) return;
    const newText = this.serializeForm();
    const currentText = this.editorView.state.doc.toString();
    if (newText === currentText) return;

    const { selection } = this.editorView.state;
    const maxPos = newText.length;
    const clampedSelection = EditorSelection.create(
      selection.ranges.map(r =>
        EditorSelection.range(Math.min(r.anchor, maxPos), Math.min(r.head, maxPos))
      ),
      selection.mainIndex
    );

    this.editorView.dispatch({
      changes: { from: 0, to: currentText.length, insert: newText },
      selection: clampedSelection,
    });
  }

  // ============================================================================
  // CHIP ACTIONS
  // ============================================================================

  toggleChip(chip: ChipDef): void {
    if (chip.isActive) {
      this.resetChip(chip);
      return;
    }

    this.explicitKeys.update(s => new Set([...s, chip.controlKey]));

    const ctrl = this.formGroup().get(chip.controlKey);
    if (ctrl) {
      let defaultVal: unknown = chip.field.Default ?? chip.field.DefaultStr;
      if (defaultVal === undefined || defaultVal === null) {
        if (chip.field.Type === 'bool') defaultVal = false;
        else if (chip.field.Type === 'int') defaultVal = 0;
        else defaultVal = '';
      }
      ctrl.setValue(defaultVal);
      ctrl.markAsDirty();
    }
  }

  resetChip(chip: ChipDef): void {
    if (!chip.isActive) return;

    this.explicitKeys.update(s => {
      const next = new Set(s);
      next.delete(chip.controlKey);
      return next;
    });

    const ctrl = this.formGroup().get(chip.controlKey);
    if (!ctrl) return;

    ctrl.setValue(chip.field.Default ?? chip.field.DefaultStr ?? null);
    ctrl.markAsDirty();
  }

  // ============================================================================
  // PRIVATE HELPERS
  // ============================================================================

  private buildExcludedSet(): Set<string> {
    const prefix = this.keyPrefix();
    const excluded = new Set<string>();
    for (const key of this.excludeKeys()) {
      excluded.add(key);
      if (prefix && !key.startsWith(prefix)) {
        excluded.add(prefix + key);
      }
    }
    return excluded;
  }

  private restorePrefix(parsed: Record<string, unknown>): Record<string, unknown> {
    const prefix = this.keyPrefix();
    if (!prefix) return { ...parsed };
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [prefix + k, v]));
  }

  private isSensitive(field?: RcConfigOption): boolean {
    if (!field) return false;
    if (field.IsPassword || field.Sensitive) return true;
    return SENSITIVE_KEYS.some(key => field.Name.toLowerCase().includes(key.toLowerCase()));
  }
}
