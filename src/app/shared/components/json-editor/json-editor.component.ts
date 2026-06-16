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
  InjectionToken,
  Signal,
} from '@angular/core';
import { FormControl, FormGroup, FormArray } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { switchMap, startWith, map } from 'rxjs';

import {
  RcConfigOption,
  SENSITIVE_KEYS,
  SharedProfileType,
  TranslationResult,
  ChipDef,
} from '@app/types';
import { RcloneOptionTranslatePipe } from '@app/pipes';
import { RcloneValueMapperService } from 'src/app/services/remote/rclone-value-mapper.service';
import {
  matchesConfigSearch,
  OPERATION_PATH_MAPPINGS,
  getTopLevelKeysForProfile,
  getControlKey,
} from 'src/app/services/remote/utils/remote-config.utils';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { staticFlagDefinitions } from '../../../services/remote/flag-definitions';
import { PathService } from '../../../services/infrastructure/platform/path.service';

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
import { linter, lintGutter, Diagnostic } from '@codemirror/lint';
import {
  autocompletion,
  CompletionContext,
  CompletionResult,
  closeBrackets,
  closeBracketsKeymap,
} from '@codemirror/autocomplete';
import { syntaxTree, bracketMatching, indentOnInput } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';

export const JSON_EDITOR_LOOKUP_TABLE = new InjectionToken<
  Signal<Record<string, { option: RcConfigOption; flagType: SharedProfileType }>>
>('JSON_EDITOR_LOOKUP_TABLE');

function toCamelCase(str: string): string {
  return str.replace(/^--?/, '').replace(/[-_]([a-z])/g, (_, char) => char.toUpperCase());
}

function toSnakeCase(str: string): string {
  return str.replace(/^--?/, '').replace(/-/g, '_');
}

const PROFILE_TYPES: SharedProfileType[] = ['sync', 'copy', 'move', 'bisync', 'mount', 'serve'];
const NESTED_OPTIONS_TYPES: SharedProfileType[] = ['vfs', 'filter', 'backend'];
const HAS_OPTIONS_GROUP_TYPES: SharedProfileType[] = [...PROFILE_TYPES, ...NESTED_OPTIONS_TYPES];

function isProfileType(type: string | null): boolean {
  return !!type && PROFILE_TYPES.includes(type as SharedProfileType);
}

function isNestedOptionsType(type: string | null): boolean {
  return !!type && NESTED_OPTIONS_TYPES.includes(type as SharedProfileType);
}

function hasOptionsGroup(type: string | null): boolean {
  return !!type && HAS_OPTIONS_GROUP_TYPES.includes(type as SharedProfileType);
}

function buildRcloneCompletionSource(
  getFieldDefs: () => RcConfigOption[],
  getFlagType: () => SharedProfileType | null
) {
  return (context: CompletionContext): CompletionResult | null => {
    const tree = syntaxTree(context.state);
    const nodeBefore = tree.resolveInner(context.pos, -1);
    const fieldDefs = getFieldDefs();
    const flagType = getFlagType();
    const isProfile = isProfileType(flagType);

    // Check if we are inside the nested options object (_config or mountOpt)
    let insideConfig = false;
    let parent = nodeBefore.parent;
    while (parent) {
      if (parent.name === 'Property') {
        const propKeyNode = parent.getChild('PropertyName') ?? parent.firstChild;
        if (propKeyNode) {
          const propKey = context.state
            .sliceDoc(propKeyNode.from, propKeyNode.to)
            .replace(/^"|"$/g, '');
          if (propKey === '_config' || propKey === 'mountOpt') {
            if (parent !== nodeBefore.parent) {
              insideConfig = true;
              break;
            }
          }
        }
      }
      parent = parent.parent;
    }

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

      const to = nodeBefore.name === 'String' ? nodeBefore.to - 1 : context.pos;

      if (isProfile && !insideConfig && flagType) {
        // Autocomplete top-level properties
        let topLevelKeys = getTopLevelKeysForProfile(flagType);
        if (flagType === 'serve') {
          topLevelKeys = ['fs', 'type', ...fieldDefs.map(f => f.Name)];
        }

        return {
          from,
          to,
          options: topLevelKeys.map(k => ({
            label: k,
            type: 'property',
            detail: 'Top-Level key',
            boost: 2,
          })),
          validFor: /^[^"]*$/,
        };
      } else {
        // Autocomplete dynamic option names
        return {
          from,
          to,
          options: fieldDefs.map(f => ({
            label: getControlKey(f, flagType || undefined),
            type: 'property',
            detail: f.Type,
            info: f.Help || undefined,
            boost: 1,
          })),
          validFor: /^[^"]*$/,
        };
      }
    }

    // Handle value completion inside config
    let cursor = nodeBefore;
    while (cursor.parent && cursor.name !== 'Property') cursor = cursor.parent;
    if (cursor.name !== 'Property') return null;

    const keyNode = cursor.getChild('PropertyName') ?? cursor.firstChild;
    if (!keyNode) return null;

    const rawKey = context.state.sliceDoc(keyNode.from, keyNode.to);
    const keyText = rawKey.replace(/^"|"$/g, '');
    const fieldDef = fieldDefs.find(f => getControlKey(f, flagType || undefined) === keyText);
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

@Component({
  selector: 'app-json-editor',
  imports: [MatIconModule, MatTooltipModule, TranslateModule, RcloneOptionTranslatePipe],
  templateUrl: './json-editor.component.html',
  styleUrl: './json-editor.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JsonEditorComponent {
  readonly formGroup = input.required<FormGroup>();
  readonly fieldDefs = input<RcConfigOption[]>([]);
  readonly provider = input<string | null>(null);
  readonly searchQuery = input('');
  readonly keyPrefix = input('');
  readonly excludeKeys = input<string[]>([]);

  readonly flagType = input<SharedProfileType | null>(null);
  readonly currentRemoteName = input<string>('');
  readonly existingRemotes = input<string[]>([]);

  readonly infoBanner = computed(() => {
    const type = this.flagType();
    if (!type) return null;
    switch (type) {
      case 'vfs':
        return 'wizards.remoteConfig.jsonEditorInfo.vfs';
      case 'filter':
        return 'wizards.remoteConfig.jsonEditorInfo.filter';
      case 'backend':
        return 'wizards.remoteConfig.jsonEditorInfo.backend';
      case 'runtimeRemote':
        return 'wizards.remoteConfig.jsonEditorInfo.runtimeRemote';
      case 'sync':
      case 'copy':
      case 'move':
        return 'wizards.remoteConfig.jsonEditorInfo.sync';
      case 'bisync':
        return 'wizards.remoteConfig.jsonEditorInfo.bisync';
      case 'mount':
        return 'wizards.remoteConfig.jsonEditorInfo.mount';
      case 'serve':
        return 'wizards.remoteConfig.jsonEditorInfo.serve';
      default:
        return null;
    }
  });

  private readonly destroyRef = inject(DestroyRef);
  private readonly hostEl = inject(ElementRef<HTMLElement>);
  private readonly valueMapper = inject(RcloneValueMapperService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly pathService = inject(PathService);
  private readonly translateService = inject(TranslateService);
  private readonly sharedLookupTable = inject(JSON_EDITOR_LOOKUP_TABLE, { optional: true });

  readonly lookupTable = computed(() => this.sharedLookupTable?.() ?? {});

  readonly restrictMode = toSignal(
    this.appSettingsService
      .selectSetting('general.restrict')
      .pipe(map(s => (s?.value as boolean) ?? true)),
    { initialValue: true }
  );

  private readonly editorContainer = viewChild<ElementRef<HTMLElement>>('editorContainer');

  private editorView: EditorView | null = null;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly explicitKeys = signal<ReadonlySet<string>>(new Set());
  private readonly customControlKeys = signal<ReadonlySet<string>>(new Set());
  readonly parseError = signal<TranslationResult | null>(null);
  readonly parseWarning = signal<TranslationResult | null>(null);

  private readonly formValue = toSignal(
    toObservable(this.formGroup).pipe(
      switchMap(fg => fg.valueChanges.pipe(startWith(fg.getRawValue())))
    ),
    { initialValue: {} as Record<string, unknown> }
  );

  private readonly excludedSet = computed(() => {
    const prefix = this.keyPrefix();
    const excluded = new Set<string>();
    for (const key of this.excludeKeys()) {
      excluded.add(key);
      if (prefix && !key.startsWith(prefix)) {
        excluded.add(prefix + key);
      }
    }
    return excluded;
  });

  readonly chips = computed<ChipDef[]>(() => {
    const type = this.flagType();
    const optionsGroup = hasOptionsGroup(type)
      ? (this.formGroup().get('options') as FormGroup)
      : this.formGroup();
    const value = optionsGroup ? (optionsGroup.getRawValue() as Record<string, unknown>) : {};
    const defs = this.fieldDefs();
    const query = this.searchQuery().trim().toLowerCase();
    const prefix = this.keyPrefix();
    const explicit = this.explicitKeys();
    const excluded = this.excludedSet();

    const baseDefs = defs.filter(f => !excluded.has(prefix + getControlKey(f, type || undefined)));
    const filteredDefs = query ? baseDefs.filter(f => matchesConfigSearch(f, query)) : baseDefs;

    return filteredDefs.map(field => {
      const controlKey = prefix + getControlKey(field, type || undefined);
      const currentValue = value[controlKey] ?? null;
      const isChanged = !this.valueMapper.isDefaultValue(currentValue, field);
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
        displayKey: getControlKey(field, type || undefined),
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
    });
  }

  private initEditor(): void {
    const container = this.editorContainer();
    if (!container) return;

    const isDark =
      this.hostEl.nativeElement.closest('[data-theme="dark"]') !== null ||
      window.matchMedia('(prefers-color-scheme: dark)').matches;

    const completionSource = buildRcloneCompletionSource(
      () => this.fieldDefs(),
      () => this.flagType()
    );

    const rcloneLinter = linter(view => {
      const diagnostics: Diagnostic[] = [];
      const flagType = this.flagType();
      const validFieldNames = new Set(
        this.fieldDefs().map(f => getControlKey(f, flagType || undefined))
      );
      const currentBlock = this.keyPrefix() ? this.keyPrefix().replace('---', '') : '';
      const isProfile = isProfileType(flagType);

      let topLevelKeys = new Set<string>();
      if (isProfile && flagType) {
        if (flagType === 'serve') {
          topLevelKeys = new Set(['fs', 'type', ...this.fieldDefs().map(f => f.Name)]);
        } else {
          topLevelKeys = new Set(getTopLevelKeysForProfile(flagType));
        }
      }

      const buildCliArgumentDiagnostic = (kText: string, from: number, to: number): Diagnostic => {
        const matched = this.lookupOption(kText);
        const suggestion = matched
          ? getControlKey(matched.option, flagType || undefined)
          : flagType === 'serve'
            ? toSnakeCase(kText)
            : toCamelCase(kText);
        return {
          from,
          to,
          severity: 'error',
          message: this.translateService.instant('shared.jsonEditor.cliArgumentWithSuggestion', {
            key: kText,
            suggestion,
          }),
          actions: [
            {
              name: this.translateService.instant('shared.jsonEditor.fixSuggestion', {
                suggestion,
              }),
              apply(v: EditorView, fPos: number, tPos: number): void {
                v.dispatch({
                  changes: { from: fPos, to: tPos, insert: JSON.stringify(suggestion) },
                });
              },
            },
          ],
        };
      };

      syntaxTree(view.state).iterate({
        enter: node => {
          if (node.name === 'PropertyName') {
            const rawKey = view.state.sliceDoc(node.from, node.to);
            const keyText = rawKey.replace(/^"|"$/g, '');

            // Check if we are inside the nested options object (_config or mountOpt)
            let insideConfig = false;
            let parent = node.node.parent;
            while (parent) {
              if (parent.name === 'Property') {
                const propKeyNode = parent.getChild('PropertyName') ?? parent.firstChild;
                if (propKeyNode) {
                  const propKey = view.state
                    .sliceDoc(propKeyNode.from, propKeyNode.to)
                    .replace(/^"|"$/g, '');
                  if (propKey === '_config' || propKey === 'mountOpt') {
                    if (parent !== node.node.parent) {
                      insideConfig = true;
                      break;
                    }
                  }
                }
              }
              parent = parent.parent;
            }

            const validateOptionKey = (kText: string, nd: { from: number; to: number }): void => {
              if (kText.startsWith('-')) {
                diagnostics.push(buildCliArgumentDiagnostic(kText, nd.from, nd.to));
              } else if (!validFieldNames.has(kText)) {
                const matched = this.lookupOption(kText);

                if (matched && !this.isCompatible(matched.block, currentBlock)) {
                  diagnostics.push({
                    from: nd.from,
                    to: nd.to,
                    severity: 'warning',
                    message: this.translateService.instant('shared.jsonEditor.wrongBlockWarning', {
                      keys: `'${kText}'`,
                      block: matched.block,
                    }),
                  });
                } else {
                  const suggestion = matched
                    ? getControlKey(matched.option, flagType || undefined)
                    : null;
                  const message = suggestion
                    ? this.translateService.instant(
                        'shared.jsonEditor.camelCaseSuggestionWarning',
                        { key: kText, suggestion }
                      )
                    : this.translateService.instant('shared.jsonEditor.unknownWarning', {
                        keys: `'${kText}'`,
                      });
                  const actions = suggestion
                    ? [
                        {
                          name: this.translateService.instant('shared.jsonEditor.fixSuggestion', {
                            suggestion,
                          }),
                          apply(v: EditorView, from: number, to: number): void {
                            v.dispatch({
                              changes: { from, to, insert: JSON.stringify(suggestion) },
                            });
                          },
                        },
                      ]
                    : undefined;

                  diagnostics.push({
                    from: nd.from,
                    to: nd.to,
                    severity: 'warning',
                    message,
                    actions,
                  });
                }
              }
            };

            if (isProfile && !insideConfig) {
              const mapping = flagType ? OPERATION_PATH_MAPPINGS[flagType] : null;
              const propertyNode = node.node.parent;
              const valueNode =
                propertyNode && propertyNode.name === 'Property' ? propertyNode.lastChild : null;
              const isArrayValue = valueNode && valueNode.name === 'Array';

              if (keyText.startsWith('-')) {
                diagnostics.push(buildCliArgumentDiagnostic(keyText, node.from, node.to));
              } else if (
                mapping &&
                isArrayValue &&
                valueNode &&
                ((keyText === mapping.sourceKey && !mapping.isSourceArray) ||
                  keyText === mapping.destKey)
              ) {
                diagnostics.push({
                  from: valueNode.from,
                  to: valueNode.to,
                  severity: 'error',
                  message: this.translateService.instant('shared.jsonEditor.invalidArrayPath', {
                    key: keyText,
                  }),
                });
              } else if (!topLevelKeys.has(keyText)) {
                diagnostics.push({
                  from: node.from,
                  to: node.to,
                  severity: 'warning',
                  message: this.translateService.instant(
                    'wizards.remoteConfig.unknownTopLevelProperty',
                    { key: keyText }
                  ),
                });
              }
            } else {
              validateOptionKey(keyText, node);
            }
          }
        },
      });
      return diagnostics;
    });

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
      rcloneLinter,
      autocompletion({ override: [completionSource] }),
      ...(isDark ? [oneDark] : []),
      EditorView.baseTheme({
        '&': {
          fontFamily: 'var(--font-mono)',
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

  private checkCliArguments(obj: Record<string, any>): { key: string; suggestion: string } | null {
    const flagType = this.flagType();
    for (const key of Object.keys(obj)) {
      if (key.startsWith('-')) {
        const matched = this.lookupOption(key);
        const suggestion = matched
          ? getControlKey(matched.option, flagType || undefined)
          : flagType === 'serve'
            ? toSnakeCase(key)
            : toCamelCase(key);
        return { key, suggestion };
      }
    }
    return null;
  }

  private validateOptions(
    options: Record<string, any>,
    validFieldNames: Set<string>,
    currentBlock: string
  ): {
    cliArg?: { key: string; suggestion: string };
    suggestion?: { key: string; suggestion: string };
    wrongBlock?: { key: string; block: string };
    unknown?: string[];
  } {
    const unknown: string[] = [];
    const wrongBlocks: { key: string; block: string }[] = [];
    const suggestions: { key: string; suggestion: string }[] = [];
    const flagType = this.flagType();

    for (const key of Object.keys(options)) {
      if (key.startsWith('-')) {
        const matched = this.lookupOption(key);
        const suggestion = matched
          ? getControlKey(matched.option, flagType || undefined)
          : flagType === 'serve'
            ? toSnakeCase(key)
            : toCamelCase(key);
        return { cliArg: { key, suggestion } };
      }

      if (!validFieldNames.has(key)) {
        const matched = this.lookupOption(key);
        if (matched) {
          if (this.isCompatible(matched.block, currentBlock)) {
            const suggestion = getControlKey(matched.option, flagType || undefined);
            suggestions.push({ key, suggestion });
          } else {
            wrongBlocks.push({ key, block: matched.block });
          }
        } else {
          unknown.push(key);
        }
      }
    }

    return {
      suggestion: suggestions[0],
      wrongBlock: wrongBlocks[0],
      unknown,
    };
  }

  private applyValidationResult(valRes: ReturnType<typeof this.validateOptions>): boolean {
    if (valRes.cliArg) {
      this.parseError.set({
        key: 'shared.jsonEditor.cliArgumentWithSuggestion',
        params: valRes.cliArg,
      });
      this.formGroup().setErrors({ cliArgument: true });
      return false;
    }

    if (valRes.suggestion) {
      this.parseWarning.set({
        key: 'shared.jsonEditor.camelCaseSuggestionWarning',
        params: valRes.suggestion,
      });
    } else if (valRes.wrongBlock) {
      this.parseWarning.set({
        key: 'shared.jsonEditor.wrongBlockWarning',
        params: { keys: `'${valRes.wrongBlock.key}'`, block: valRes.wrongBlock.block },
      });
    } else if (valRes.unknown && valRes.unknown.length > 0) {
      this.parseWarning.set({
        key: 'shared.jsonEditor.unknownWarning',
        params: { keys: valRes.unknown.map(k => `'${k}'`).join(', ') },
      });
    } else {
      this.parseWarning.set(null);
    }
    return true;
  }

  private syncFormControls(
    group: FormGroup,
    incoming: Record<string, any>,
    excludeFilter: (key: string) => boolean = () => false
  ): void {
    const existingControls = new Set(Object.keys(group.controls));
    const prevCustom = new Set(this.customControlKeys());
    const nextCustom = new Set<string>();

    for (const [controlKey, val] of Object.entries(incoming)) {
      if (excludeFilter(controlKey)) continue;

      if (!existingControls.has(controlKey)) {
        group.addControl(controlKey, new FormControl(val), { emitEvent: false });
        nextCustom.add(controlKey);
      } else if (prevCustom.has(controlKey)) {
        nextCustom.add(controlKey);
      }
    }

    for (const key of prevCustom) {
      if (!nextCustom.has(key)) {
        group.removeControl(key, { emitEvent: false });
      }
    }

    this.customControlKeys.set(nextCustom);
  }

  private applyEditorChanges(text: string): void {
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(text) as Record<string, any>;
    } catch {
      this.parseError.set({ key: 'shared.jsonEditor.parseError' });
      this.formGroup().setErrors({ jsonParse: true });
      return;
    }

    const type = this.flagType();
    const isProfile = isProfileType(type);
    const validFieldNames = new Set(this.fieldDefs().map(f => getControlKey(f, type || undefined)));
    const currentBlock = this.keyPrefix() ? this.keyPrefix().replace('---', '') : '';

    if (isProfile) {
      // Validate top level keys (excluding _config/mountOpt, srcFs/dstFs, etc.)
      const topLevelKeys =
        type === 'serve'
          ? new Set(['fs', 'type', ...this.fieldDefs().map(f => f.Name)])
          : type
            ? new Set(getTopLevelKeysForProfile(type))
            : new Set<string>();

      // Check CLI arguments at top level
      const cliCheck = this.checkCliArguments(parsed);
      if (cliCheck) {
        this.parseError.set({
          key: 'shared.jsonEditor.cliArgumentWithSuggestion',
          params: cliCheck,
        });
        this.formGroup().setErrors({ cliArgument: true });
        return;
      }

      // Check for array values where they are not supported
      const mapping = type ? OPERATION_PATH_MAPPINGS[type] : null;
      if (mapping) {
        for (const [key, val] of Object.entries(parsed)) {
          if (
            (key === mapping.sourceKey && !mapping.isSourceArray && Array.isArray(val)) ||
            (key === mapping.destKey && Array.isArray(val))
          ) {
            this.parseError.set({
              key: 'shared.jsonEditor.invalidArrayPath',
              params: { key },
            });
            this.formGroup().setErrors({ invalidArrayPath: true });
            return;
          }
        }
      }

      // Check unknown top level keys
      for (const key of Object.keys(parsed)) {
        if (!topLevelKeys.has(key)) {
          this.parseWarning.set({
            key: 'wizards.remoteConfig.unknownTopLevelProperty',
            params: { key },
          });
          this.parseError.set(null);
          this.formGroup().setErrors(null);
          this.reconcileFormFromEditor(parsed);
          return;
        }
      }

      // Validate options inside nested object (_config or mountOpt)
      const nestedKey = type === 'mount' ? 'mountOpt' : '_config';
      const nestedOptions = parsed[nestedKey] || {};
      if (typeof nestedOptions === 'object' && nestedOptions !== null) {
        const valRes = this.validateOptions(nestedOptions, validFieldNames, currentBlock);
        if (!this.applyValidationResult(valRes)) return;
      } else {
        this.parseWarning.set(null);
      }
    } else {
      // Fallback/standard check for flat profiles
      const valRes = this.validateOptions(parsed, validFieldNames, currentBlock);
      if (!this.applyValidationResult(valRes)) return;
    }

    this.parseError.set(null);
    this.formGroup().setErrors(null);
    this.reconcileFormFromEditor(parsed);
  }

  private reconcileFormFromEditor(parsed: Record<string, any>): void {
    const type = this.flagType();
    const fg = this.formGroup();
    const currentRemote = this.currentRemoteName();
    const existing = this.existingRemotes();

    if (isNestedOptionsType(type)) {
      const optionsGroup = fg.get('options') as FormGroup;
      if (optionsGroup) {
        this.explicitKeys.set(new Set(Object.keys(parsed)));

        this.syncFormControls(optionsGroup, parsed);

        const latestRaw = optionsGroup.getRawValue() as Record<string, unknown>;
        const patch = this.buildPatchFromIncoming(latestRaw, parsed);

        optionsGroup.patchValue(patch, { emitEvent: false });
      }
      return;
    }

    if (isProfileType(type)) {
      const rcloneParsed = parsed;

      const mapping = type ? OPERATION_PATH_MAPPINGS[type] : null;
      if (mapping) {
        // 1. Reconcile source path
        const sourceCtrl = fg.get('source');
        const srcVal = rcloneParsed[mapping.sourceKey];

        if (srcVal !== undefined) {
          if (sourceCtrl instanceof FormArray) {
            sourceCtrl.clear();
            const paths = Array.isArray(srcVal) ? srcVal : [srcVal].filter(Boolean);
            if (paths.length > 0) {
              for (const p of paths) {
                sourceCtrl.push(
                  new FormGroup({
                    type: new FormControl('local'),
                    path: new FormControl(''),
                    remote: new FormControl(''),
                  })
                );
                const lastGroup = sourceCtrl.at(sourceCtrl.length - 1) as FormGroup;
                const parsed = this.pathService.parseFsString(
                  p,
                  'currentRemote',
                  currentRemote,
                  existing
                );
                if (type === 'mount' || type === 'serve') {
                  parsed.type = 'currentRemote';
                  parsed.remote = '';
                }
                lastGroup.patchValue(parsed);
              }
            } else {
              sourceCtrl.push(
                new FormGroup({
                  type: new FormControl('currentRemote'),
                  path: new FormControl(''),
                  remote: new FormControl(currentRemote),
                })
              );
            }
          } else if (sourceCtrl instanceof FormGroup) {
            const parsed = this.pathService.parseFsString(
              srcVal || '',
              'currentRemote',
              currentRemote,
              existing
            );
            if (type === 'mount' || type === 'serve') {
              parsed.type = 'currentRemote';
              parsed.remote = '';
            }
            sourceCtrl.patchValue(parsed);
          }
        }

        // 2. Reconcile destination path
        if (mapping.destKey) {
          const destCtrl = fg.get('dest');
          const dstVal = rcloneParsed[mapping.destKey];

          if (destCtrl instanceof FormGroup && dstVal !== undefined) {
            const parsed = this.pathService.parseFsString(
              dstVal || '',
              'local',
              currentRemote,
              existing
            );
            if (type === 'mount') {
              parsed.type = 'local';
              parsed.remote = '';
            }
            destCtrl.patchValue(parsed);
          }
        }
      }

      // 3. Reconcile type (mountType / type)
      if (type === 'mount') {
        const typeCtrl = fg.get('options.mountType');
        if (typeCtrl && rcloneParsed['mountType'] !== undefined) {
          typeCtrl.setValue(rcloneParsed['mountType'], { emitEvent: true });
        }
      } else if (type === 'serve') {
        const typeCtrl = fg.get('options.type');
        if (typeCtrl && rcloneParsed['type'] !== undefined) {
          typeCtrl.setValue(rcloneParsed['type'], { emitEvent: true });
        }
      }

      // 4. Reconcile options
      const optionsGroup = fg.get('options') as FormGroup;
      if (optionsGroup) {
        // Gather all incoming options (flat + nested)
        const incomingOptions: Record<string, any> = {};

        if (type === 'serve') {
          // Serve is fully flat
          const serveDefs = this.fieldDefs();
          const serveDefNames = new Set(serveDefs.map(f => f.Name));
          for (const field of serveDefs) {
            const name = field.Name;
            if (rcloneParsed[name] !== undefined) {
              incomingOptions[name] = rcloneParsed[name];
            }
          }
          // Also pull custom options (any key not in serveDefs, and not type/fs)
          const mapping = OPERATION_PATH_MAPPINGS['serve'];
          const excludeKeys = new Set(
            ['type', mapping?.sourceKey, mapping?.destKey].filter(Boolean) as string[]
          );
          for (const [key, val] of Object.entries(rcloneParsed)) {
            if (!serveDefNames.has(key) && !excludeKeys.has(key)) {
              incomingOptions[key] = val;
            }
          }
        } else {
          const nestedKey = type === 'mount' ? 'mountOpt' : '_config';
          const nestedOptions = rcloneParsed[nestedKey] || {};

          const flatDefs = type ? staticFlagDefinitions[type] || [] : [];
          const flatOptionNames = new Set(flatDefs.map(f => getControlKey(f, type || undefined)));

          // Pull flat options from top-level of rcloneParsed JSON
          for (const name of flatOptionNames) {
            if (rcloneParsed[name] !== undefined) {
              incomingOptions[name] = rcloneParsed[name];
            }
          }

          // Pull nested options
          if (typeof nestedOptions === 'object' && nestedOptions !== null) {
            for (const [k, v] of Object.entries(nestedOptions)) {
              incomingOptions[k] = v;
            }
          }
        }

        this.explicitKeys.set(new Set(Object.keys(incomingOptions)));

        this.syncFormControls(optionsGroup, incomingOptions);

        const latestRaw = optionsGroup.getRawValue() as Record<string, unknown>;
        const patch = this.buildPatchFromIncoming(latestRaw, incomingOptions);

        optionsGroup.patchValue(patch, { emitEvent: false });
      }

      return;
    }

    // Fallback/standard reconcile for flat profiles
    const prefix = this.keyPrefix();
    const excluded = this.excludedSet();
    const restored = this.restorePrefix(parsed);
    this.explicitKeys.set(new Set(Object.keys(restored)));

    this.syncFormControls(fg, restored, k => excluded.has(k));

    const latestRaw = fg.getRawValue() as Record<string, unknown>;
    const patch = this.buildPatchFromIncoming(latestRaw, restored, prefix, excluded);

    fg.patchValue(patch, { emitEvent: false });
  }

  private serializeForm(): string {
    try {
      const type = this.flagType();
      const raw = this.formGroup().getRawValue() as Record<string, any>;
      const currentRemote = this.currentRemoteName();

      if (isNestedOptionsType(type)) {
        let out: Record<string, any> = {};
        const optionsGroup = this.formGroup().get('options') as FormGroup;
        if (optionsGroup) {
          out = this.serializeOptions(optionsGroup.getRawValue(), '', new Set(), false);
        }
        return JSON.stringify(out, null, 2);
      }

      if (isProfileType(type)) {
        const rclone: Record<string, any> = {};

        const mapping = type ? OPERATION_PATH_MAPPINGS[type] : null;
        if (mapping) {
          // 1. Map source paths to srcFs / path1 / fs
          if (raw['source']) {
            const srcPaths = Array.isArray(raw['source'])
              ? raw['source']
                  .map((s: any) => this.pathService.buildPathString(s, currentRemote))
                  .filter(Boolean)
              : [this.pathService.buildPathString(raw['source'], currentRemote)].filter(Boolean);

            rclone[mapping.sourceKey] = mapping.isSourceArray
              ? srcPaths.length > 1
                ? srcPaths
                : (srcPaths[0] ?? '')
              : (srcPaths[0] ?? '');
          }

          // 2. Map destination paths to dstFs / path2 / mountPoint
          if (mapping.destKey && raw['dest']) {
            const dstPath = this.pathService.buildPathString(raw['dest'], currentRemote);
            rclone[mapping.destKey] = dstPath;
          }
        }

        // 3. Map mountType / type
        if (type === 'mount') {
          const val = raw['options']?.['mountType'];
          if (val && val.trim() !== '') {
            rclone['mountType'] = val;
          }
        } else if (type === 'serve') {
          const val = raw['options']?.['type'];
          if (val && val.trim() !== '') {
            rclone['type'] = val;
          }
        }

        // 4. Map options (flat vs _config/mountOpt)
        if (raw['options']) {
          const serialized = this.serializeOptions(
            raw['options'],
            '',
            new Set(['mountType', 'type']),
            false
          );

          if (type === 'serve') {
            // Serve is fully flat, merge all options directly into rclone
            Object.assign(rclone, serialized);
          } else {
            const flatDefs = type ? staticFlagDefinitions[type] || [] : [];
            const flatOptionNames = new Set(flatDefs.map(f => getControlKey(f, type || undefined)));

            const flatOptions: Record<string, any> = {};
            const nestedOptions: Record<string, any> = {};

            for (const [displayKey, finalVal] of Object.entries(serialized)) {
              if (flatOptionNames.has(displayKey)) {
                flatOptions[displayKey] = finalVal;
              } else {
                nestedOptions[displayKey] = finalVal;
              }
            }

            // Merge flat options directly into rclone
            Object.assign(rclone, flatOptions);

            // Merge nested options under _config or mountOpt
            if (Object.keys(nestedOptions).length > 0) {
              const nestedKey = type === 'mount' ? 'mountOpt' : '_config';
              rclone[nestedKey] = nestedOptions;
            }
          }
        }

        return JSON.stringify(rclone, null, 2);
      }

      // Fallback/standard serialization for flat profiles
      const prefix = this.keyPrefix();
      const excluded = this.excludedSet();
      const out = this.serializeOptions(raw, prefix, excluded, true);

      return JSON.stringify(out, null, 2);
    } catch {
      return '{}';
    }
  }

  private buildPatchFromIncoming(
    latestRaw: Record<string, unknown>,
    incoming: Record<string, unknown>,
    prefix = '',
    excluded = new Set<string>()
  ): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    const defs = this.fieldDefs();

    for (const controlKey of Object.keys(latestRaw)) {
      if (excluded.has(controlKey)) {
        patch[controlKey] = latestRaw[controlKey];
        continue;
      }

      if (controlKey in incoming) {
        const val = incoming[controlKey];
        patch[controlKey] = val === '••••••••' ? latestRaw[controlKey] : val;
      } else if (!prefix || controlKey.startsWith(prefix)) {
        const displayKey = prefix ? controlKey.slice(prefix.length) : controlKey;
        const type = this.flagType();
        const field = defs.find(f => getControlKey(f, type || undefined) === displayKey);
        patch[controlKey] = field?.Default ?? field?.DefaultStr ?? null;
      } else {
        patch[controlKey] = latestRaw[controlKey];
      }
    }
    return patch;
  }

  private serializeOptions(
    rawOptions: Record<string, any>,
    prefix = '',
    excluded = new Set<string>(),
    maskSensitive = false
  ): Record<string, any> {
    const out: Record<string, any> = {};
    const defs = this.fieldDefs();
    const explicit = this.explicitKeys();

    for (const [controlKey, val] of Object.entries(rawOptions)) {
      if (prefix && !controlKey.startsWith(prefix)) continue;
      if (excluded.has(controlKey)) continue;

      const displayKey = prefix ? controlKey.slice(prefix.length) : controlKey;
      const type = this.flagType();
      const field = defs.find(f => getControlKey(f, type || undefined) === displayKey);
      const isExplicit = explicit.has(controlKey);

      if (field && this.valueMapper.isDefaultValue(val, field) && !isExplicit) continue;
      if (!field && (val === null || val === undefined || val === '')) continue;

      const finalVal = field?.Type === 'Tristate' ? this.valueMapper.parseTristate(val) : val;

      if (maskSensitive && this.restrictMode() && this.isSensitive(field)) {
        out[displayKey] = '••••••••';
      } else {
        out[displayKey] = finalVal;
      }
    }
    return out;
  }

  private pushFormToEditor(): void {
    if (!this.editorView) return;
    if (this.editorView.hasFocus) return;
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

  private getOptionsTarget(): FormGroup {
    const type = this.flagType();
    return hasOptionsGroup(type)
      ? (this.formGroup().get('options') as FormGroup)
      : this.formGroup();
  }

  toggleChip(chip: ChipDef): void {
    if (chip.isActive) {
      this.resetChip(chip);
      return;
    }

    this.explicitKeys.update(s => new Set([...s, chip.controlKey]));

    const targetGroup = this.getOptionsTarget();
    const ctrl = targetGroup?.get(chip.controlKey);
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

    const targetGroup = this.getOptionsTarget();
    const ctrl = targetGroup?.get(chip.controlKey);
    if (!ctrl) return;

    ctrl.setValue(chip.field.Default ?? chip.field.DefaultStr ?? null);
    ctrl.markAsDirty();
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

  private lookupOption(key: string): { option: RcConfigOption; block: string } | null {
    const cleanKey = key.toLowerCase();
    const table = this.lookupTable();

    // try exact match
    let found = table[cleanKey];
    if (found) return { option: found.option, block: found.flagType };

    // try stripping leading hyphens
    const noHyphensPrefix = cleanKey.replace(/^--?/, '');
    found = table[noHyphensPrefix];
    if (found) return { option: found.option, block: found.flagType };

    // try stripping all hyphens
    const fullyCleaned = noHyphensPrefix.replace(/-/g, '').replace(/_/g, '');
    found = table[fullyCleaned];
    if (found) return { option: found.option, block: found.flagType };

    return null;
  }

  private isCompatible(optionBlock: string, currentBlock: string): boolean {
    if (!currentBlock) {
      return optionBlock === 'runtimeRemote';
    }

    const cb = currentBlock.toLowerCase();
    const ob = optionBlock.toLowerCase();

    if (cb === ob) return true;

    if (['sync', 'copy', 'move', 'bisync', 'backend'].includes(cb) && ob === 'main') {
      return true;
    }

    return false;
  }
}
