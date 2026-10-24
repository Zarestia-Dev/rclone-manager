import { EditorState } from '@codemirror/state';
import { EditorView, Panel, runScopeHandlers, ViewUpdate } from '@codemirror/view';
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import { TranslateService } from '@ngx-translate/core';

const MATCH_LIMIT = 1000;

/** Bound counting work on large files; searching itself still covers the full document. */
export function searchMatches(state: EditorState): {
  matches: { from: number; to: number }[];
  truncated: boolean;
} {
  const query = getSearchQuery(state);
  const matches: { from: number; to: number }[] = [];
  if (!query.valid) return { matches, truncated: false };
  const cursor = query.getCursor(state.doc);
  for (let match = cursor.next(); !match.done; match = cursor.next()) {
    if (matches.length === MATCH_LIMIT) return { matches, truncated: true };
    matches.push({ from: match.value.from, to: match.value.to });
  }
  return { matches, truncated: false };
}

/** Custom presentation backed entirely by CodeMirror's search state and commands. */
export function createSearchPanel(view: EditorView, translate: TranslateService): Panel {
  const doc = view.dom.ownerDocument;
  const dom = doc.createElement('form');
  dom.className = 'cm-search';
  dom.setAttribute('role', 'search');
  const labels: (() => void)[] = [];
  const t = (key: string, params?: Record<string, unknown>): string =>
    translate.instant(`shared.codeEditor.${key}`, params);

  const label = (el: HTMLElement, key: string, text = true): void => {
    labels.push(() => {
      el.setAttribute('aria-label', t(key));
      el.title = t(key);
      if (text) el.textContent = t(key);
    });
  };
  const row = (parent: HTMLElement): HTMLDivElement => {
    const el = doc.createElement('div');
    el.className = 'cm-search-row';
    parent.append(el);
    return el;
  };
  const button = (
    parent: HTMLElement,
    key: string,
    run: () => void,
    glyph?: string
  ): HTMLButtonElement => {
    const el = doc.createElement('button');
    el.type = 'button';
    el.name = key;
    el.className = glyph ? 'action-button' : 'app-pill interactive';
    if (glyph) el.textContent = glyph;
    label(el, key, !glyph);
    el.addEventListener('click', run);
    parent.append(el);
    return el;
  };
  const field = (parent: HTMLElement, key: string): HTMLInputElement => {
    const input = doc.createElement('input');
    input.type = key === 'find' ? 'search' : 'text';
    input.name = key;
    input.className = 'cm-textfield';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    label(input, key, false);
    labels.push(() => (input.placeholder = t(key)));
    parent.append(input);
    return input;
  };

  const main = row(dom);
  const input = field(main, 'find');
  input.setAttribute('main-field', 'true');
  const status = doc.createElement('span');
  status.className = 'cm-search-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  main.append(status);
  const previous = button(main, 'previous', () => findPrevious(view), '↑');
  const next = button(main, 'next', () => findNext(view), '↓');

  const optionRow = row(dom);
  const toggles = (['caseSensitive', 'wholeWord', 'regexp'] as const).map(key => {
    const el = button(optionRow, key, () => {
      const current = getSearchQuery(view.state);
      view.dispatch({
        effects: setSearchQuery.of(new SearchQuery({ ...current, [key]: !current[key] })),
      });
    });
    return { key, el };
  });

  const replacement = doc.createElement('details');
  const replaceSummary = doc.createElement('summary');
  label(replaceSummary, 'replace');
  replacement.append(replaceSummary);
  const replaceRow = row(replacement);
  const replaceInput = field(replaceRow, 'replace');
  const replace = button(replaceRow, 'replace', () => replaceNext(view));
  const all = button(replaceRow, 'replaceAll', () => replaceAll(view));
  dom.append(replacement);

  let result = searchMatches(view.state);
  const refresh = (): void => {
    const query = getSearchQuery(view.state);
    if (input.value !== query.search) input.value = query.search;
    if (replaceInput.value !== query.replace) replaceInput.value = query.replace;
    const invalid = !!query.search && !query.valid;
    input.setAttribute('aria-invalid', String(invalid));
    const selection = view.state.selection.main;
    const current = result.matches.findIndex(
      m => m.from === selection.from && m.to === selection.to
    );
    const total = `${result.matches.length}${result.truncated ? '+' : ''}`;
    status.textContent = invalid
      ? t('invalidRegexp')
      : !query.search
        ? ''
        : !result.matches.length
          ? t('noResults')
          : current < 0
            ? t('matches', { total })
            : t('matchPosition', { current: current + 1, total });
    const disabled = !query.valid || result.matches.length === 0;
    previous.disabled = next.disabled = disabled;
    replacement.hidden = view.state.readOnly;
    replace.disabled = all.disabled = view.state.readOnly || disabled;
    for (const { key, el } of toggles) {
      el.setAttribute('aria-pressed', String(query[key]));
      el.classList.toggle('is-selected', query[key]);
      el.classList.toggle('p-accent', query[key]);
    }
  };
  const commit = (): void => {
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          ...getSearchQuery(view.state),
          search: input.value,
          replace: replaceInput.value,
        })
      ),
    });
  };
  input.addEventListener('input', commit);
  replaceInput.addEventListener('input', commit);
  dom.addEventListener('submit', event => {
    event.preventDefault();
    event.stopPropagation();
  });
  dom.addEventListener('keydown', event => {
    // Keep input navigation and Escape away from modal/file navigation handlers.
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSearchPanel(view);
    } else if (event.key === 'Enter' && (event.target === input || event.target === replaceInput)) {
      event.preventDefault();
      if (event.target === replaceInput) replaceNext(view);
      else if (event.shiftKey) findPrevious(view);
      else findNext(view);
    } else if (runScopeHandlers(view, event, 'search-panel')) {
      event.preventDefault();
    }
  });
  const relabel = (): void => {
    labels.forEach(update => update());
    dom.setAttribute('aria-label', t('find'));
    refresh();
  };
  const subscription = translate.onLangChange.subscribe(relabel);
  relabel();

  return {
    dom,
    top: true,
    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        !getSearchQuery(update.startState).eq(getSearchQuery(update.state))
      ) {
        result = searchMatches(update.state);
      }
      refresh();
    },
    destroy(): void {
      subscription.unsubscribe();
    },
  };
}
