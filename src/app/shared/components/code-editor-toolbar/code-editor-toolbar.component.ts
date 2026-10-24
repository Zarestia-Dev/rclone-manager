import { ChangeDetectionStrategy, Component, effect, input, signal } from '@angular/core';
import { CdkMenuModule } from '@angular/cdk/menu';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { TranslatePipe } from '@ngx-translate/core';
import { Compartment, Extension, StateEffect } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { closeSearchPanel, openSearchPanel, searchPanelOpen } from '@codemirror/search';
import { closeGoToLine, goToLineOpen, toggleGoToLine } from './code-editor.goto';
import {
  PersistentMenuCheckboxDirective,
  PersistentMenuItemDirective,
} from '../../directives/persistent-menu-item.directive';

@Component({
  selector: 'app-code-editor-toolbar',
  imports: [
    CdkMenuModule,
    MatButtonModule,
    MatIconModule,
    MatSlideToggleModule,
    TranslatePipe,
    PersistentMenuItemDirective,
    PersistentMenuCheckboxDirective,
  ],
  templateUrl: './code-editor-toolbar.component.html',
  styleUrl: './code-editor-toolbar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CodeEditorToolbarComponent {
  readonly editor = input<EditorView | null>(null);
  readonly language = input('');
  readonly readOnly = signal(true);
  readonly searching = signal(false);
  readonly goingToLine = signal(false);
  readonly canUndo = signal(false);
  readonly canRedo = signal(false);
  readonly wrap = signal(false);
  readonly lineNumbers = signal(true);
  readonly line = signal(1);
  readonly column = signal(1);
  readonly fontSize = signal(0);
  readonly fontSizes = [
    'var(--font-size-md)',
    'var(--font-size-base)',
    'var(--font-size-xl)',
    'var(--font-size-2xl)',
  ];
  private readonly wrapping = new Compartment();
  private readonly typography = new Compartment();
  private readonly gutters = new Compartment();

  constructor() {
    effect(onCleanup => {
      const view = this.editor();
      if (!view) return;
      const touch =
        globalThis.matchMedia?.('(max-width: 40rem), (pointer: coarse)').matches ?? false;
      this.wrap.set(touch);
      this.fontSize.set(touch ? 1 : 0);
      this.lineNumbers.set(true);
      const sync = (): void => {
        const state = view.state;
        this.readOnly.set(state.readOnly);
        this.searching.set(searchPanelOpen(state));
        this.goingToLine.set(goToLineOpen(state));
        this.canUndo.set(undoDepth(state) > 0);
        this.canRedo.set(redoDepth(state) > 0);
        const cursor = state.selection.main.head;
        const line = state.doc.lineAt(cursor);
        this.line.set(line.number);
        this.column.set(cursor - line.from + 1);
      };
      let attached = true;
      const observer = new Compartment();
      view.dispatch({
        effects: StateEffect.appendConfig.of([
          this.wrapping.of(touch ? EditorView.lineWrapping : []),
          this.typography.of(this.fontTheme(touch ? 1 : 0)),
          this.gutters.of([]),
          observer.of(
            ViewPlugin.define(() => ({
              update: sync,
              destroy(): void {
                attached = false;
              },
            }))
          ),
        ]),
      });
      sync();
      onCleanup(() => {
        if (attached) {
          view.dispatch({
            effects: [
              observer.reconfigure([]),
              this.wrapping.reconfigure([]),
              this.typography.reconfigure([]),
              this.gutters.reconfigure([]),
            ],
          });
        }
      });
    });
  }

  find(): void {
    const view = this.editor();
    if (!view) return;
    if (searchPanelOpen(view.state)) closeSearchPanel(view);
    else {
      closeGoToLine(view);
      openSearchPanel(view);
    }
  }

  goToLine(): void {
    const view = this.editor();
    if (view) toggleGoToLine(view);
  }

  toggleWrap(): void {
    const view = this.editor();
    if (!view) return;
    this.wrap.update(value => !value);
    view.dispatch({
      effects: this.wrapping.reconfigure(this.wrap() ? EditorView.lineWrapping : []),
    });
  }

  resizeFont(delta: number): void {
    const view = this.editor();
    if (!view) return;
    this.fontSize.update(value => Math.max(0, Math.min(this.fontSizes.length - 1, value + delta)));
    view.dispatch({ effects: this.typography.reconfigure(this.fontTheme()) });
  }

  toggleLineNumbers(): void {
    const view = this.editor();
    if (!view) return;
    this.lineNumbers.update(value => !value);
    view.dispatch({
      effects: this.gutters.reconfigure(
        EditorView.editorAttributes.of({
          class: this.lineNumbers() ? '' : 'cm-hide-line-numbers',
        })
      ),
    });
  }

  history(direction: 'undo' | 'redo'): void {
    const view = this.editor();
    if (!view || view.state.readOnly) return;
    (direction === 'undo' ? undo : redo)(view);
    view.focus();
  }

  private fontTheme(size = this.fontSize()): Extension {
    return EditorView.theme({ '.cm-scroller': { fontSize: this.fontSizes[size] } });
  }
}
