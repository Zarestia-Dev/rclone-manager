import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { EditorView, Panel, showPanel } from '@codemirror/view';
import { closeSearchPanel } from '@codemirror/search';

const showGoToLine = StateEffect.define<boolean>();

export const goToLineState = StateField.define<boolean>({
  create: () => false,
  update(value, transaction): boolean {
    for (const effect of transaction.effects) {
      if (effect.is(showGoToLine)) value = effect.value;
    }
    return value;
  },
  provide: field => showPanel.from(field, open => (open ? createGoToLinePanel : null)),
});

export function goToLineOpen(state: EditorState): boolean {
  return state.field(goToLineState, false) ?? false;
}

export function closeGoToLine(view: EditorView): boolean {
  if (!goToLineOpen(view.state)) return false;
  view.dispatch({ effects: showGoToLine.of(false) });
  return true;
}

export function toggleGoToLine(view: EditorView): boolean {
  const open = !goToLineOpen(view.state);
  if (open) closeSearchPanel(view);
  view.dispatch({ effects: showGoToLine.of(open) });
  return true;
}

function createGoToLinePanel(view: EditorView): Panel {
  const doc = view.dom.ownerDocument;
  const dom = doc.createElement('form');
  dom.className = 'cm-goto-line';
  const label = doc.createElement('label');
  const caption = doc.createElement('span');
  const input = doc.createElement('input');
  input.type = 'number';
  input.name = 'line';
  input.className = 'cm-textfield';
  input.min = '1';
  input.step = '1';
  input.required = true;
  input.inputMode = 'numeric';
  input.value = String(view.state.doc.lineAt(view.state.selection.main.head).number);
  const submit = doc.createElement('button');
  submit.type = 'submit';
  submit.className = 'app-pill interactive';
  label.append(caption, input);
  dom.append(label, submit);
  const refresh = (): void => {
    caption.textContent = view.state.phrase('Go to line');
    submit.textContent = view.state.phrase('go');
    input.max = String(view.state.doc.lines);
  };
  refresh();
  dom.addEventListener('submit', event => {
    event.preventDefault();
    event.stopPropagation();
    const line = Number(input.value);
    if (!Number.isInteger(line) || line < 1 || line > view.state.doc.lines) {
      input.setAttribute('aria-invalid', 'true');
      input.reportValidity();
      return;
    }
    const position = view.state.doc.line(line).from;
    view.dispatch({
      selection: { anchor: position },
      effects: [showGoToLine.of(false), EditorView.scrollIntoView(position)],
    });
    view.focus();
  });
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
  dom.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeGoToLine(view);
      view.focus();
    }
  });
  return {
    dom,
    top: true,
    mount(): void {
      input.focus();
      input.select();
    },
    update: refresh,
  };
}
