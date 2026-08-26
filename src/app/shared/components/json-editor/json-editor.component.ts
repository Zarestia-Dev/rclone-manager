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
import { MatDividerModule } from '@angular/material/divider';
import { CdkMenuModule, CdkMenuTrigger } from '@angular/cdk/menu';
import { CdkOverlayAutoposDirective } from 'src/app/shared/directives/cdk-overlay-autopos.directive';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { switchMap, startWith, map } from 'rxjs';

import {
  RcConfigOption,
  RcConfigExample,
  SENSITIVE_KEYS,
  SharedProfileType,
  TranslationResult,
  ChipDef,
  LINKED_PROFILE_TYPES,
} from '@app/types';
import { RcloneOptionTranslatePipe } from '@app/pipes';
import { RcloneValueMapperService } from 'src/app/services/remote/rclone-value-mapper.service';
import {
  matchesConfigSearch,
  OPERATION_PATH_MAPPINGS,
  getTopLevelKeysForProfile,
  resolveOptionExamples,
} from 'src/app/services/remote/utils/remote-config.utils';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { PathService, PathGroup } from '../../../services/infrastructure/platform/path.service';
import { isIntType, isFloatType } from 'src/app/shared/utils';

import { AlertBannerComponent } from '../alert-banner/alert-banner.component';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  WidgetType,
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view';
import { EditorState, EditorSelection, RangeSetBuilder, Extension } from '@codemirror/state';
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

export type JsonEditorLookupTable = Signal<
  Record<string, { option: RcConfigOption; flagType: SharedProfileType }>
>;
export const JSON_EDITOR_LOOKUP_TABLE = new InjectionToken<JsonEditorLookupTable>(
  'JSON_EDITOR_LOOKUP_TABLE'
);

function toSnakeCase(str: string): string {
  return str.replace(/^--?/, '').replace(/-/g, '_');
}

const NESTED_OPTIONS_TYPES = new Set<SharedProfileType>(['vfs', 'filter', 'backend']);
const HAS_OPTIONS_GROUP_TYPES = new Set<string>([...LINKED_PROFILE_TYPES, ...NESTED_OPTIONS_TYPES]);

function isProfileType(type: string | null): boolean {
  return !!type && LINKED_PROFILE_TYPES.has(type);
}

function isNestedOptionsType(type: string | null): boolean {
  return !!type && NESTED_OPTIONS_TYPES.has(type as SharedProfileType);
}

function hasOptionsGroup(type: string | null): boolean {
  return !!type && HAS_OPTIONS_GROUP_TYPES.has(type);
}

export interface ExampleMenuContext {
  rect: DOMRect;
  keyText: string;
  examples: RcConfigExample[];
  field: RcConfigOption;
  valueRange: { from: number; to: number };
}

class ExampleButtonWidget extends WidgetType {
  constructor(
    readonly ctx: Omit<ExampleMenuContext, 'rect'>,
    readonly onOpenMenu: (ctx: ExampleMenuContext) => void
  ) {
    super();
  }

  override eq(other: ExampleButtonWidget): boolean {
    return (
      other.ctx.keyText === this.ctx.keyText &&
      other.ctx.valueRange.from === this.ctx.valueRange.from &&
      other.ctx.valueRange.to === this.ctx.valueRange.to &&
      other.ctx.examples === this.ctx.examples
    );
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-example-widget';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-example-btn';
    btn.title = this.ctx.keyText;
    btn.setAttribute('aria-label', this.ctx.keyText);
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>`;

    btn.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
    });

    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const rect = btn.getBoundingClientRect();
      this.onOpenMenu({
        rect,
        keyText: this.ctx.keyText,
        examples: this.ctx.examples,
        field: this.ctx.field,
        valueRange: this.ctx.valueRange,
      });
    });

    wrap.appendChild(btn);
    return wrap;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function buildRcloneCompletionSource(
  getFieldDefs: () => RcConfigOption[],
  getFlagType: () => SharedProfileType | null,
  getFieldKey: (f: RcConfigOption) => string = f => f.Name || f.FieldName
) {
  return (context: CompletionContext): CompletionResult | null => {
    const tree = syntaxTree(context.state);
    const nodeBefore = tree.resolveInner(context.pos, -1);
    const fieldDefs = getFieldDefs();
    const flagType = getFlagType();
    const isProfile = isProfileType(flagType);

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

      if (isProfile && flagType) {
        // Autocomplete top-level properties and option names
        const topLevelKeys = getTopLevelKeysForProfile(flagType);
        const optionKeys = fieldDefs.map(f => getFieldKey(f));
        const allKeys = Array.from(new Set([...topLevelKeys, ...optionKeys]));

        return {
          from,
          to,
          options: allKeys.map(k => ({
            label: k,
            type: 'property',
            detail: topLevelKeys.includes(k) ? 'Top-Level key' : 'Option',
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
            label: getFieldKey(f),
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
    const fieldDef = fieldDefs.find(f => getFieldKey(f) === keyText);
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
  imports: [
    MatIconModule,
    MatDividerModule,
    CdkMenuModule,
    CdkOverlayAutoposDirective,
    TranslatePipe,
    RcloneOptionTranslatePipe,
    AlertBannerComponent,
  ],
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
  readonly preferFieldName = input(false);

  readonly flagType = input<SharedProfileType | null>(null);
  readonly currentRemoteName = input<string>('');
  readonly existingRemotes = input<string[]>([]);

  private static readonly INFO_BANNERS: Readonly<Record<string, string>> = {
    vfs: 'wizards.remoteConfig.jsonEditorInfo.vfs',
    filter: 'wizards.remoteConfig.jsonEditorInfo.filter',
    backend: 'wizards.remoteConfig.jsonEditorInfo.backend',
    runtimeRemote: 'wizards.remoteConfig.jsonEditorInfo.runtimeRemote',
    sync: 'wizards.remoteConfig.jsonEditorInfo.sync',
    copy: 'wizards.remoteConfig.jsonEditorInfo.sync',
    move: 'wizards.remoteConfig.jsonEditorInfo.sync',
    bisync: 'wizards.remoteConfig.jsonEditorInfo.bisync',
    check: 'wizards.remoteConfig.jsonEditorInfo.check',
    mount: 'wizards.remoteConfig.jsonEditorInfo.mount',
    serve: 'wizards.remoteConfig.jsonEditorInfo.serve',
  };

  readonly infoBanner = computed(() => {
    const type = this.flagType();
    return type ? (JsonEditorComponent.INFO_BANNERS[type] ?? null) : null;
  });

  private readonly destroyRef = inject(DestroyRef);
  private readonly valueMapper = inject(RcloneValueMapperService);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly pathService = inject(PathService);
  private readonly sharedLookupTable = inject(JSON_EDITOR_LOOKUP_TABLE, { optional: true });
  private readonly translateService = inject(TranslateService);
  readonly currentLang = this.translateService.currentLang;

  readonly lookupTable = computed(() => this.sharedLookupTable?.() ?? {});

  /** Resolves the canonical key for a field definition. */
  readonly fieldKey = (f: RcConfigOption): string =>
    this.preferFieldName() ? f.FieldName || f.Name : f.Name || f.FieldName;

  readonly restrictMode = toSignal(
    this.appSettingsService
      .selectSetting('general.restrict')
      .pipe(map(s => (s?.value as boolean) ?? true)),
    { initialValue: true }
  );

  private readonly hostEl = inject(ElementRef<HTMLElement>);
  private readonly editorContainer = viewChild<ElementRef<HTMLElement>>('editorContainer');
  readonly menuTrigger = viewChild<CdkMenuTrigger>(CdkMenuTrigger);

  private editorView: EditorView | null = null;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isPushingToEditor = false;
  private readonly explicitKeys = signal<ReadonlySet<string>>(new Set());
  private readonly customControlKeys = signal<ReadonlySet<string>>(new Set());
  readonly parseError = signal<TranslationResult | null>(null);
  readonly parseWarning = signal<TranslationResult | null>(null);
  readonly activeExampleMenu = signal<ExampleMenuContext | null>(null);
  readonly menuAnchorPos = signal<{ x: number; y: number; width: number; height: number }>({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });

  openExampleMenu(
    rectOrCtx: DOMRect | ExampleMenuContext,
    keyText?: string,
    examples?: RcConfigExample[],
    field?: RcConfigOption,
    valueRange?: { from: number; to: number }
  ): void {
    const ctx: ExampleMenuContext =
      'rect' in rectOrCtx
        ? rectOrCtx
        : {
            rect: rectOrCtx,
            keyText: keyText ?? '',
            examples: examples ?? [],
            field: field ?? ({ Name: keyText ?? '', Help: '', Type: 'string' } as RcConfigOption),
            valueRange: valueRange ?? { from: 0, to: 0 },
          };

    const hostRect = this.hostEl.nativeElement.getBoundingClientRect();
    this.activeExampleMenu.set(ctx);
    this.menuAnchorPos.set({
      x: ctx.rect.left - hostRect.left,
      y: ctx.rect.top - hostRect.top,
      width: ctx.rect.width,
      height: ctx.rect.height,
    });
    queueMicrotask(() => {
      if (!this.menuTrigger()?.isOpen()) {
        this.menuTrigger()?.open();
      }
    });
  }

  closeExampleMenu(): void {
    if (this.menuTrigger()?.isOpen()) {
      this.menuTrigger()?.close();
    }
    this.activeExampleMenu.set(null);
  }

  selectExample(exampleValue: string): void {
    const menu = this.activeExampleMenu();
    if (!menu || !this.editorView) return;

    let replacement: string;
    const fieldType = menu.field?.Type;

    if (fieldType === 'bool') {
      replacement = String(exampleValue).toLowerCase() === 'true' ? 'true' : 'false';
    } else if (
      fieldType &&
      (isIntType(fieldType) || isFloatType(fieldType)) &&
      /^-?\d+(\.\d+)?$/.test(String(exampleValue).trim())
    ) {
      replacement = String(exampleValue).trim();
    } else {
      replacement = JSON.stringify(exampleValue);
    }

    const { from, to } = menu.valueRange;
    const currentDoc = this.editorView.state.doc;

    let insertText = replacement;
    if (from === to && from > 0 && currentDoc.sliceString(from - 1, from) === ':') {
      insertText = ' ' + replacement;
    }

    this.editorView.dispatch({
      changes: { from, to, insert: insertText },
    });
    this.editorView.focus();
    this.closeExampleMenu();
  }

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

    const isSafMount =
      type === 'mount' &&
      (value['mountType'] === 'saf' || String(value['mountPoint'] ?? '').startsWith('saf://'));
    const baseDefs = defs.filter(f => {
      const key = this.fieldKey(f);
      if (isSafMount && key === 'mountPoint') return false;
      return !excluded.has(prefix + key);
    });
    const filteredDefs = query ? baseDefs.filter(f => matchesConfigSearch(f, query)) : baseDefs;

    return filteredDefs.map(field => {
      const controlKey = prefix + this.fieldKey(field);
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
        displayKey: this.fieldKey(field),
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
    effect(onCleanup => {
      this.formValue();
      const timer = setTimeout(() => this.pushFormToEditor(), 150);
      onCleanup(() => clearTimeout(timer));
    });

    this.destroyRef.onDestroy(() => {
      this.editorView?.destroy();
    });
  }

  private initEditor(): void {
    const container = this.editorContainer();
    if (!container) return;

    const completionSource = buildRcloneCompletionSource(
      () => this.fieldDefs(),
      () => this.flagType(),
      f => this.fieldKey(f)
    );

    const rcloneLinter = linter(view => {
      const diagnostics: Diagnostic[] = [];
      const flagType = this.flagType();
      const validFieldNames = new Set(this.fieldDefs().map(f => this.fieldKey(f)));
      const currentBlock = this.keyPrefix() ? this.keyPrefix().replace('---', '') : '';
      const isProfile = isProfileType(flagType);

      const buildCliArgumentDiagnostic = (kText: string, from: number, to: number): Diagnostic => {
        const matched = this.lookupOption(kText);
        const suggestion = matched
          ? matched.option.Name || matched.option.FieldName
          : toSnakeCase(kText);
        return {
          from,
          to,
          severity: 'warning',
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
                    ? matched.option.Name || matched.option.FieldName
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

            if (isProfile) {
              const mapping = flagType ? OPERATION_PATH_MAPPINGS[flagType] : null;
              const propertyNode = node.node.parent;
              const valueNode =
                propertyNode && propertyNode.name === 'Property' ? propertyNode.lastChild : null;
              const isArrayValue = valueNode && valueNode.name === 'Array';
              const structuralKeys = new Set(
                [mapping?.sourceKey, mapping?.destKey, 'mountType', 'type'].filter(Boolean)
              );

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
              } else if (!structuralKeys.has(keyText)) {
                validateOptionKey(keyText, node);
              }
            } else {
              validateOptionKey(keyText, node);
            }
          }
        },
      });
      return diagnostics;
    });

    const exampleWidgetsExtension = this.createExampleWidgetsExtension();

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
      exampleWidgetsExtension,
      autocompletion({ override: [completionSource] }),
      EditorView.theme({}, { dark: document.documentElement.classList.contains('dark') }),
      EditorView.updateListener.of(update => {
        if (update.docChanged && this.activeExampleMenu()) {
          this.closeExampleMenu();
        }
        if (!update.docChanged || this.isPushingToEditor) return;
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

  private createExampleWidgetsExtension(): Extension {
    const buildDecos = (view: EditorView): DecorationSet => {
      const builder = new RangeSetBuilder<Decoration>();
      const fieldDefs = this.fieldDefs();
      const lookupTable = this.lookupTable();
      const tree = syntaxTree(view.state);
      const decoratedLines = new Set<number>();
      const items: { pos: number; widget: Decoration }[] = [];

      for (const { from, to } of view.visibleRanges) {
        tree.iterate({
          from,
          to,
          enter: node => {
            if (node.name === 'Property') {
              const propNode = node.node;
              const keyNode = propNode.getChild('PropertyName') ?? propNode.firstChild;
              const valueNode = propNode.lastChild;

              if (!keyNode) return;

              const rawKey = view.state.sliceDoc(keyNode.from, keyNode.to);
              const keyText = rawKey.replace(/^"|"$/g, '');

              let fieldDef = fieldDefs.find(
                f => (f.Name || f.FieldName) === keyText || f.FieldName === keyText
              );
              if (!fieldDef) {
                const cleanKey = keyText
                  .toLowerCase()
                  .replace(/^--?/, '')
                  .replace(/-/g, '')
                  .replace(/_/g, '');
                const match = lookupTable[cleanKey] || lookupTable[keyText.toLowerCase()];
                if (match) fieldDef = match.option;
              }

              const examples = resolveOptionExamples(fieldDef);
              if (!examples || examples.length === 0 || !fieldDef) return;

              const line = view.state.doc.lineAt(keyNode.from);
              if (decoratedLines.has(line.number)) return;
              decoratedLines.add(line.number);

              const hasDistinctValue = valueNode && valueNode.from > keyNode.to;
              const valueRange = {
                from: hasDistinctValue ? valueNode.from : keyNode.to,
                to: hasDistinctValue ? valueNode.to : keyNode.to,
              };

              const widget = Decoration.widget({
                widget: new ExampleButtonWidget(
                  { keyText, examples, field: fieldDef, valueRange },
                  ctx => {
                    this.openExampleMenu(ctx);
                  }
                ),
                side: 1,
              });

              const targetPos = hasDistinctValue ? valueNode.to : keyNode.to;
              items.push({ pos: targetPos, widget });
            }
          },
        });
      }

      items.sort((a, b) => a.pos - b.pos);
      for (const item of items) {
        builder.add(item.pos, item.pos, item.widget);
      }

      return builder.finish();
    };

    return ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = buildDecos(view);
        }

        update(update: ViewUpdate): void {
          if (update.docChanged || update.viewportChanged) {
            this.decorations = buildDecos(update.view);
          }
        }
      },
      {
        decorations: v => v.decorations,
      }
    );
  }

  private validateOptions(
    options: Record<string, unknown>,
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
    let cliArg: { key: string; suggestion: string } | undefined;

    const type = this.flagType();
    const isProfile = isProfileType(type);
    const structuralKeys = new Set(isProfile && type ? getTopLevelKeysForProfile(type) : []);

    for (const key of Object.keys(options)) {
      if (structuralKeys.has(key)) {
        continue;
      }

      if (key.startsWith('-')) {
        if (!cliArg) {
          const matched = this.lookupOption(key);
          const suggestion = matched
            ? matched.option.Name || matched.option.FieldName
            : toSnakeCase(key);
          cliArg = { key, suggestion };
        }
        continue;
      }

      if (!validFieldNames.has(key)) {
        const matched = this.lookupOption(key);
        if (matched) {
          if (this.isCompatible(matched.block, currentBlock)) {
            const suggestion = matched.option.Name || matched.option.FieldName;
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
      cliArg,
      suggestion: suggestions[0],
      wrongBlock: wrongBlocks[0],
      unknown,
    };
  }

  private applyValidationResult(valRes: ReturnType<typeof this.validateOptions>): boolean {
    if (valRes.cliArg) {
      this.parseWarning.set({
        key: 'shared.jsonEditor.cliArgumentWithSuggestion',
        params: valRes.cliArg,
      });
    } else if (valRes.suggestion) {
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
    incoming: Record<string, unknown>,
    excludeFilter: (key: string) => boolean = () => false
  ): void {
    const existingControls = new Set(Object.keys(group.controls));
    const validFieldNames = new Set(this.fieldDefs().map(f => this.fieldKey(f)));
    const prevCustom = new Set(this.customControlKeys());
    const nextCustom = new Set<string>();

    for (const [controlKey, val] of Object.entries(incoming)) {
      if (excludeFilter(controlKey)) continue;

      if (!existingControls.has(controlKey)) {
        group.addControl(controlKey, new FormControl(val), { emitEvent: false });
        nextCustom.add(controlKey);
      } else if (prevCustom.has(controlKey) || !validFieldNames.has(controlKey)) {
        nextCustom.add(controlKey);
      }
    }

    for (const key of Object.keys(group.controls)) {
      if (excludeFilter(key)) continue;
      if (!Object.prototype.hasOwnProperty.call(incoming, key) && !validFieldNames.has(key)) {
        group.removeControl(key, { emitEvent: false });
      }
    }

    this.customControlKeys.set(nextCustom);
  }

  private applyEditorChanges(text: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.parseError.set({ key: 'shared.jsonEditor.parseError' });
      this.formGroup().setErrors({ jsonParse: true });
      return;
    }

    const type = this.flagType();
    const isProfile = isProfileType(type);
    const validFieldNames = new Set(this.fieldDefs().map(f => this.fieldKey(f)));
    const currentBlock = this.keyPrefix() ? this.keyPrefix().replace('---', '') : '';

    if (isProfile) {
      // Validate top level keys
      const topLevelKeys = type ? new Set(getTopLevelKeysForProfile(type)) : new Set<string>();
      if (type === 'serve') {
        topLevelKeys.add('fs');
        topLevelKeys.add('type');
      }
      for (const field of this.fieldDefs()) {
        topLevelKeys.add(this.fieldKey(field));
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

      // Validate options at top level (including CLI args)
      const valRes = this.validateOptions(parsed, validFieldNames, currentBlock);
      this.applyValidationResult(valRes);

      // Check unknown top level keys (excluding CLI arguments and valid options)
      if (!valRes.cliArg && !valRes.suggestion && !valRes.wrongBlock) {
        for (const key of Object.keys(parsed)) {
          if (!topLevelKeys.has(key) && !key.startsWith('-')) {
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
      }
    } else {
      // Fallback/standard check for flat profiles
      const valRes = this.validateOptions(parsed, validFieldNames, currentBlock);
      this.applyValidationResult(valRes);
    }

    this.parseError.set(null);
    this.formGroup().setErrors(null);
    this.reconcileFormFromEditor(parsed);
  }

  private reconcileFormFromEditor(parsed: Record<string, unknown>): void {
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
            const paths = Array.isArray(srcVal) ? srcVal : [srcVal].filter(Boolean);
            if (paths.length > 0) {
              while (sourceCtrl.length < paths.length) {
                sourceCtrl.push(
                  new FormGroup({
                    type: new FormControl('local'),
                    path: new FormControl(''),
                    remote: new FormControl(''),
                  })
                );
              }
              while (sourceCtrl.length > paths.length) {
                sourceCtrl.removeAt(sourceCtrl.length - 1);
              }
              paths.forEach((p, idx) => {
                const group = sourceCtrl.at(idx) as FormGroup;
                const parsedPath = this.pathService.parseFsString(
                  p,
                  'local',
                  currentRemote,
                  existing
                );
                if (type === 'mount' || type === 'serve') {
                  parsedPath.type = 'currentRemote';
                  parsedPath.remote = '';
                }
                group.patchValue(parsedPath, { emitEvent: false });
              });
            } else {
              while (sourceCtrl.length > 1) {
                sourceCtrl.removeAt(sourceCtrl.length - 1);
              }
              if (sourceCtrl.length === 0) {
                sourceCtrl.push(
                  new FormGroup({
                    type: new FormControl('local'),
                    path: new FormControl(''),
                    remote: new FormControl(''),
                  })
                );
              } else {
                const first = sourceCtrl.at(0) as FormGroup;
                first.get('path')?.setValue('', { emitEvent: false });
              }
            }
          } else if (sourceCtrl instanceof FormGroup) {
            const parsedPath = this.pathService.parseFsString(
              String(srcVal || ''),
              'currentRemote',
              currentRemote,
              existing
            );
            if (type === 'mount' || type === 'serve') {
              parsedPath.type = 'currentRemote';
              parsedPath.remote = '';
            }
            sourceCtrl.patchValue(parsedPath, { emitEvent: false });
          }
        }

        // 2. Reconcile destination path
        if (mapping.destKey) {
          const destCtrl = fg.get('dest');
          const dstVal = rcloneParsed[mapping.destKey];

          if (destCtrl instanceof FormGroup && dstVal !== undefined) {
            const parsedPath = this.pathService.parseFsString(
              String(dstVal || ''),
              'local',
              currentRemote,
              existing
            );
            if (type === 'mount') {
              parsedPath.type = 'local';
              parsedPath.remote = '';
            }
            destCtrl.patchValue(parsedPath, { emitEvent: false });
          }
        }
      }

      // 3. Reconcile type (mountType / type)
      if (type === 'mount') {
        const typeCtrl = fg.get('options.mountType');
        if (typeCtrl && rcloneParsed['mountType'] !== undefined) {
          typeCtrl.setValue(rcloneParsed['mountType'], { emitEvent: false });
        }
      } else if (type === 'serve') {
        const typeCtrl = fg.get('options.type');
        if (typeCtrl && rcloneParsed['type'] !== undefined) {
          typeCtrl.setValue(rcloneParsed['type'], { emitEvent: false });
        }
      }

      // 4. Reconcile options
      const optionsGroup = fg.get('options') as FormGroup;
      if (optionsGroup) {
        // Gather all incoming options (flat + nested)
        const incomingOptions: Record<string, unknown> = {};

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
          // Pull flat options from top level of rcloneParsed
          const mapping = type ? OPERATION_PATH_MAPPINGS[type] : null;
          const excludeKeys = new Set(
            [mapping?.sourceKey, mapping?.destKey, 'mountType', 'type'].filter(Boolean) as string[]
          );

          for (const [k, v] of Object.entries(rcloneParsed)) {
            if (excludeKeys.has(k)) continue;

            // Backward compatibility with old remote_config.ts
            if (
              (k === '_config' || k === 'mountOpt' || k === '_filter') &&
              v &&
              typeof v === 'object' &&
              !Array.isArray(v)
            ) {
              for (const [nk, nv] of Object.entries(v)) {
                incomingOptions[nk] = nv;
              }
            } else {
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
      const raw = this.formGroup().getRawValue() as Record<string, unknown>;
      const currentRemote = this.currentRemoteName();

      if (isNestedOptionsType(type)) {
        let out: Record<string, unknown> = {};
        const optionsGroup = this.formGroup().get('options') as FormGroup;
        if (optionsGroup) {
          out = this.serializeOptions(optionsGroup.getRawValue(), '', new Set(), false);
        }
        return JSON.stringify(out, null, 2);
      }

      if (isProfileType(type)) {
        const rclone: Record<string, unknown> = {};

        const mapping = type ? OPERATION_PATH_MAPPINGS[type] : null;
        if (mapping) {
          // 1. Map source paths to srcFs / path1 / fs
          if (raw['source']) {
            const srcPaths = Array.isArray(raw['source'])
              ? (raw['source'] as unknown[])
                  .map(s => this.pathService.buildPathString(s as PathGroup, currentRemote))
                  .filter(Boolean)
              : [
                  this.pathService.buildPathString(raw['source'] as PathGroup, currentRemote),
                ].filter(Boolean);

            rclone[mapping.sourceKey] = mapping.isSourceArray
              ? srcPaths.length > 1
                ? srcPaths
                : (srcPaths[0] ?? '')
              : (srcPaths[0] ?? '');
          }

          // 2. Map destination paths to dstFs / path2 / mountPoint
          if (mapping.destKey && raw['dest']) {
            const dstPath = this.pathService.buildPathString(
              raw['dest'] as PathGroup,
              currentRemote
            );
            rclone[mapping.destKey] = dstPath;
          }
        }

        // 3. Map mountType / type
        if (type === 'mount') {
          const val = (raw['options'] as Record<string, unknown> | undefined)?.['mountType'];
          if (typeof val === 'string' && val.trim() !== '') {
            rclone['mountType'] = val;
          }
        } else if (type === 'serve') {
          const val = (raw['options'] as Record<string, unknown> | undefined)?.['type'];
          if (typeof val === 'string' && val.trim() !== '') {
            rclone['type'] = val;
          }
        }

        // 4. Map options (flat at top level)
        if (raw['options']) {
          const serialized = this.serializeOptions(
            raw['options'] as Record<string, unknown>,
            '',
            new Set(['mountType', 'type']),
            false
          );

          // All profiles output options flat at top level
          Object.assign(rclone, serialized);
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
        const field = defs.find(f => this.fieldKey(f) === displayKey);
        patch[controlKey] = field ? (field.Default ?? field.DefaultStr ?? null) : null;
      } else {
        patch[controlKey] = latestRaw[controlKey];
      }
    }
    return patch;
  }

  private serializeOptions(
    rawOptions: Record<string, unknown>,
    prefix = '',
    excluded = new Set<string>(),
    maskSensitive = false
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const defs = this.fieldDefs();
    const explicit = this.explicitKeys();

    for (const [controlKey, val] of Object.entries(rawOptions)) {
      if (prefix && !controlKey.startsWith(prefix)) continue;
      if (excluded.has(controlKey)) continue;

      const displayKey = prefix ? controlKey.slice(prefix.length) : controlKey;
      const field = defs.find(f => this.fieldKey(f) === displayKey);
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

    try {
      this.isPushingToEditor = true;
      this.editorView.dispatch({
        changes: { from: 0, to: currentText.length, insert: newText },
        selection: clampedSelection,
      });
    } finally {
      this.isPushingToEditor = false;
    }
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

    if (['sync', 'copy', 'move', 'bisync', 'check', 'backend'].includes(cb) && ob === 'main') {
      return true;
    }

    return false;
  }
}
