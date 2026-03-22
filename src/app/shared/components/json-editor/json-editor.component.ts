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
import { FormGroup } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { switchMap, startWith } from 'rxjs';

import { RcConfigOption } from '@app/types';
import { RcloneValueMapperService } from '@app/services';

import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
} from '@codemirror/view';
import { EditorState } from '@codemirror/state';
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
  /** The internal form control key (may include prefix, e.g. mount---attr_timeout) */
  controlKey: string;
  /** Display name shown on the chip (e.g. attr_timeout) */
  displayKey: string;
  /** Human-readable label from field.Name */
  label: string;
  /** Current form value */
  currentValue: unknown;
  /** Truncated display version of currentValue */
  displayValue: string;
  /** Full string for tooltip */
  fullValue: string;
  /** Whether the value genuinely differs from the field default */
  isChanged: boolean;
  /** Whether this field has been overridden from its default OR explicitly added */
  isActive: boolean;
  /** The backing field definition */
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

  // Clean Tristate matching
  if (field.Type === 'Tristate' && mapper) {
    const valBool = mapper.parseTristate(value);
    const defBool = mapper.parseTristate(field.Default);
    if (valBool === defBool) return true;

    // Fallback to string representations
    const defStrBool = mapper.parseTristate(field.DefaultStr);
    if (valBool === defStrBool) return true;

    // Explicit toggle check: 'unset' string or null matches a null/unset default
    if (valBool === null && (defBool === null || defStrBool === null)) return true;

    return false;
  }

  // Array defaults: empty array = default for list types
  if (Array.isArray(value)) {
    const arrDef = field.Default;
    if (Array.isArray(arrDef)) return value.length === 0 && arrDef.length === 0;
    return value.length === 0;
  }

  const strVal = String(value);
  if (strVal === String(field.Default)) return true;
  if (strVal === String(field.DefaultStr)) return true;

  // Treat empty string as default too
  if (strVal === '') return true;

  return false;
}

function buildRcloneCompletionSource(getFieldDefs: () => RcConfigOption[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const tree = syntaxTree(context.state);
    const nodeBefore = tree.resolveInner(context.pos, -1);
    const fieldDefs = getFieldDefs();

    // --- KEY POSITION ---
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

    // --- VALUE POSITION ---
    let cursor = nodeBefore;
    while (cursor.parent && cursor.name !== 'Property') {
      cursor = cursor.parent;
    }

    if (cursor.name === 'Property') {
      const keyNode = cursor.getChild('PropertyName') ?? cursor.firstChild;
      if (!keyNode) return null;

      const rawKey = context.state.sliceDoc(keyNode.from, keyNode.to);
      const keyText = rawKey.replace(/^"|"$/g, '');

      // Match on FieldName OR Name — covers both serve (Name) and flagged (FieldName) types
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
    }

    return null;
  };
}

// ============================================================================
// COMPONENT
// ============================================================================

@Component({
  selector: 'app-json-editor',
  standalone: true,
  imports: [MatIconModule, MatTooltipModule, TranslateModule],
  templateUrl: './json-editor.component.html',
  styleUrl: './json-editor.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JsonEditorComponent {
  // ---- Inputs ----
  readonly formGroup = input.required<FormGroup>();
  readonly fieldDefs = input<RcConfigOption[]>([]);
  readonly keyPrefix = input('');

  // ---- DI ----
  private readonly destroyRef = inject(DestroyRef);
  private readonly hostEl = inject(ElementRef<HTMLElement>);
  private readonly valueMapper = inject(RcloneValueMapperService);

  // ---- View refs ----
  private readonly editorContainer = viewChild<ElementRef<HTMLElement>>('editorContainer');

  // ---- Internal state ----
  private editorView: EditorView | null = null;
  private isEditorDriving = false;
  private readonly explicitKeys = signal<ReadonlySet<string>>(new Set());

  readonly parseError = signal<string | null>(null);

  // ---- Reactive form value ----
  private readonly formValue = toSignal(
    toObservable(this.formGroup).pipe(
      switchMap(fg => fg.valueChanges.pipe(startWith(fg.getRawValue())))
    ),
    { initialValue: {} as Record<string, unknown> }
  );

  readonly chips = computed<ChipDef[]>(() => {
    const value = this.formValue() as Record<string, unknown>;
    const defs = this.fieldDefs();
    const prefix = this.keyPrefix();
    const explicit = this.explicitKeys();

    return defs.map(field => {
      const controlKey = prefix + field.Name;
      const currentValue = value[controlKey] ?? null;
      const isChanged = !isDefaultValue(currentValue, field, this.valueMapper);
      const isActive = isChanged || explicit.has(controlKey);

      // Unwrap tristate for chip display
      let displayVal = currentValue;
      if (field.Type === 'Tristate') displayVal = this.valueMapper.parseTristate(currentValue);

      const rawDisplay = Array.isArray(displayVal)
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
    afterNextRender(() => {
      this.initEditor();
    });

    effect(() => {
      this.formValue();
      if (!this.isEditorDriving) this.pushFormToEditor();
    });

    this.destroyRef.onDestroy(() => this.editorView?.destroy());
  }

  // ============================================================================
  // EDITOR INITIALISATION
  // ============================================================================
  private initEditor(): void {
    const container = this.editorContainer();
    if (!container) return;

    const initialJson = this.serializeForm();
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
    const isDark =
      this.hostEl.nativeElement.closest('[data-theme="dark"]') !== null || prefersDark.matches;

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

        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          this.parseError.set(null);
          this.isEditorDriving = true;

          const prefix = this.keyPrefix();
          const newExplicit = new Set<string>();
          for (const key of Object.keys(parsed)) {
            newExplicit.add(prefix + key);
          }
          this.explicitKeys.set(newExplicit);

          // Restore prefix before patching form, and reset missing keys
          const restored = this.restorePrefix(parsed);
          const raw = this.formGroup().getRawValue() as Record<string, unknown>;
          for (const key of Object.keys(raw)) {
            if (!(key in restored)) {
              const displayKey = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
              const field = this.fieldDefs().find(
                f => f.Name === displayKey || f.FieldName === displayKey
              );
              restored[key] = field?.Default ?? field?.DefaultStr ?? null;
            }
          }

          this.formGroup().patchValue(restored, { emitEvent: true });
          this.isEditorDriving = false;
        } catch {
          this.parseError.set('Invalid JSON');
        }
      }),
    ];

    this.editorView = new EditorView({
      state: EditorState.create({ doc: initialJson, extensions }),
      parent: container.nativeElement,
    });
  }

  // ============================================================================
  // SYNC HELPERS
  // ============================================================================

  private serializeForm(): string {
    try {
      const raw = this.formGroup().getRawValue() as Record<string, unknown>;
      const defs = this.fieldDefs();
      const prefix = this.keyPrefix();
      const explicit = this.explicitKeys();

      const cleaned: Record<string, unknown> = {};

      for (const [controlKey, val] of Object.entries(raw)) {
        // Strip prefix to get the display key shown in the JSON editor
        const displayKey =
          prefix && controlKey.startsWith(prefix) ? controlKey.slice(prefix.length) : controlKey;

        // Find matching field def to check defaults
        const field = defs.find(f => f.Name === displayKey || f.FieldName === displayKey);
        const isExplicit = explicit.has(controlKey);

        // Skip if at default — don't pollute the JSON with unchanged values unless explicitly added
        if (field && isDefaultValue(val, field, this.valueMapper) && !isExplicit) continue;
        if (!field && (val === null || val === undefined || val === '') && !isExplicit) continue;

        if (field && field.Type === 'Tristate') {
          cleaned[displayKey] = this.valueMapper.parseTristate(val);
        } else {
          cleaned[displayKey] = val;
        }
      }

      return JSON.stringify(cleaned, null, 2);
    } catch {
      return '{}';
    }
  }

  private restorePrefix(parsed: Record<string, unknown>): Record<string, unknown> {
    const prefix = this.keyPrefix();
    if (!prefix) return parsed;

    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [prefix + k, v]));
  }

  private pushFormToEditor(): void {
    if (!this.editorView) return;
    const newText = this.serializeForm();
    const currentText = this.editorView.state.doc.toString();
    if (newText === currentText) return;

    this.editorView.dispatch({
      changes: { from: 0, to: currentText.length, insert: newText },
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

    this.explicitKeys.update(s => {
      const newSet = new Set(s);
      newSet.add(chip.controlKey);
      return newSet;
    });

    const ctrl = this.formGroup().get(chip.controlKey);
    if (ctrl) {
      let defaultVal = chip.field.Default ?? chip.field.DefaultStr;
      if (defaultVal === undefined || defaultVal === null) {
        if (chip.field.Type === 'bool') defaultVal = false;
        else if (chip.field.Type === 'int') defaultVal = 0;
        else defaultVal = '';
      }
      ctrl.setValue(defaultVal);
      ctrl.markAsDirty();
    }

    this.pushFormToEditor();
  }

  resetChip(chip: ChipDef): void {
    if (!chip.isActive) return;

    this.explicitKeys.update(s => {
      const newSet = new Set(s);
      newSet.delete(chip.controlKey);
      return newSet;
    });

    const ctrl = this.formGroup().get(chip.controlKey);
    if (!ctrl) return;

    const defaultVal = chip.field.Default ?? chip.field.DefaultStr ?? null;
    ctrl.setValue(defaultVal);
    ctrl.markAsDirty();
    this.pushFormToEditor();
  }
}
