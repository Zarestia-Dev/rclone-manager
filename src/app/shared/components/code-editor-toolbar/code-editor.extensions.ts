import { Compartment, EditorState, Extension, Prec } from '@codemirror/state';
import { EditorView, keymap, ViewPlugin } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { TranslateService } from '@ngx-translate/core';
import {
  closeSearchPanel,
  openSearchPanel,
  search,
  searchKeymap,
  searchPanelOpen,
} from '@codemirror/search';
import { createSearchPanel } from './code-editor.search';
import { closeGoToLine, goToLineOpen, goToLineState, toggleGoToLine } from './code-editor.goto';

// Mix with the theme's foreground so the same semantic colors stay readable
// on both light and dark surfaces, including when the app theme changes.
const ink = (color: string, amount = 50): string =>
  `color-mix(in srgb, var(${color}) ${amount}%, var(--window-fg-color))`;

export const codeHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: ink('--purple'), fontWeight: '600' },
  { tag: [tags.string, tags.inserted], color: ink('--primary-color') },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: ink('--orange') },
  { tag: [tags.propertyName, tags.attributeName], color: ink('--accent-color') },
  { tag: [tags.typeName, tags.className, tags.namespace], color: ink('--purple') },
  { tag: tags.function(tags.variableName), color: ink('--yellow', 40), fontWeight: '600' },
  { tag: [tags.regexp, tags.escape, tags.special(tags.string)], color: ink('--orange') },
  {
    tag: [tags.comment, tags.meta],
    color: 'color-mix(in srgb, var(--dim-color) 60%, var(--window-fg-color))',
  },
  { tag: [tags.operator, tags.punctuation], color: 'var(--window-fg-color)' },
  { tag: tags.heading, color: ink('--accent-color'), fontWeight: '600' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: ink('--accent-color'), textDecoration: 'underline' },
  { tag: [tags.invalid, tags.deleted], textDecoration: 'underline wavy var(--warn-color)' },
]);

/** Shared appearance, localized search, and keyboard behavior for every editor. */
export function codeEditorExtensions(translate: TranslateService): Extension {
  const appearance = new Compartment();
  const phrases = new Compartment();
  const theme = (): Extension =>
    EditorView.theme({}, { dark: document.documentElement.classList.contains('dark') });
  const localized = (): Extension => [
    EditorState.phrases.of({
      'Go to line': translate.instant('shared.codeEditor.goToLine'),
      go: translate.instant('shared.codeEditor.go'),
    }),
    EditorView.contentAttributes.of({
      'aria-label': translate.instant('shared.codeEditor.content'),
      tabindex: '0',
      spellcheck: 'false',
      autocapitalize: 'off',
      autocorrect: 'off',
    }),
  ];

  return [
    syntaxHighlighting(codeHighlightStyle),
    appearance.of(theme()),
    phrases.of(localized()),
    search({ top: true, literal: true, createPanel: view => createSearchPanel(view, translate) }),
    goToLineState,
    Prec.highest(
      keymap.of([
        { key: 'Mod-Alt-g', run: toggleGoToLine, scope: 'editor search-panel' },
        {
          key: 'Mod-f',
          scope: 'editor search-panel',
          run: (view): boolean => {
            closeGoToLine(view);
            return openSearchPanel(view);
          },
        },
      ])
    ),
    keymap.of(searchKeymap),
    Prec.highest(
      EditorView.domEventHandlers({
        keydown(event, view) {
          if (event.key !== 'Escape' || (!searchPanelOpen(view.state) && !goToLineOpen(view.state)))
            return false;
          event.preventDefault();
          event.stopPropagation();
          closeSearchPanel(view);
          closeGoToLine(view);
          return true;
        },
      })
    ),
    ViewPlugin.define(view => {
      const observer = new MutationObserver(() => {
        view.dispatch({ effects: appearance.reconfigure(theme()) });
      });
      observer.observe(view.dom.ownerDocument.documentElement, {
        attributes: true,
        attributeFilter: ['class'],
      });
      const subscription = translate.onLangChange.subscribe(() => {
        view.dispatch({ effects: phrases.reconfigure(localized()) });
      });
      return {
        destroy(): void {
          observer.disconnect();
          subscription.unsubscribe();
        },
      };
    }),
  ];
}
