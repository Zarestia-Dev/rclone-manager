import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { CopyToClipboardDirective } from '../../directives/copy-to-clipboard.directive';
import {
  JsonSegment,
  countLines,
  firstLines,
  formatCell,
  highlightJson,
  maskSecrets,
  toTable,
} from '../../utils/rc/rc-output.util';

type OutputView = 'pretty' | 'raw' | 'table';

/** Lines shown before the rest of a long output is folded away. */
const COLLAPSED_LINES = 16;
/** Rows of a table shown before the rest is folded away. */
const COLLAPSED_ROWS = 10;
/** Characters rendered at most; the copy button still gets all of it. */
const MAX_DISPLAY_CHARS = 100_000;
/** Above this much text the colouring is skipped, to keep the page light. */
const MAX_HIGHLIGHT_CHARS = 20_000;

@Component({
  selector: 'app-rc-output',
  imports: [MatIconModule, TranslatePipe, CopyToClipboardDirective],
  templateUrl: './rc-output.component.html',
  styleUrl: './rc-output.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RcOutputComponent {
  readonly body = input.required<unknown>();
  readonly failed = input(false);
  readonly mask = input(true);

  readonly view = signal<OutputView>('pretty');
  readonly expanded = signal(false);

  private readonly shownBody = computed(() =>
    this.mask() ? maskSecrets(this.body()) : this.body()
  );
  private readonly isText = computed(() => typeof this.shownBody() === 'string');

  private readonly prettyText = computed(() => {
    const body = this.shownBody();
    return typeof body === 'string' ? body : (JSON.stringify(body, null, 2) ?? '');
  });
  private readonly rawText = computed(() => {
    const body = this.shownBody();
    return typeof body === 'string' ? body : (JSON.stringify(body) ?? '');
  });

  readonly table = computed(() => toTable(this.shownBody()));
  /** Everything the view shows, in full. This is what the copy button copies. */
  readonly text = computed(() => (this.view() === 'raw' ? this.rawText() : this.prettyText()));
  readonly lineCount = computed(() => countLines(this.text()));

  private readonly clamped = computed(() => this.lineCount() > COLLAPSED_LINES);
  readonly hiddenLines = computed(() => this.lineCount() - COLLAPSED_LINES);
  readonly cutByLimit = computed(() => this.text().length > MAX_DISPLAY_CHARS);

  private readonly visibleText = computed(() => {
    let text = this.text();
    if (this.clamped() && !this.expanded()) {
      text = firstLines(text, COLLAPSED_LINES);
    }
    return text.length > MAX_DISPLAY_CHARS ? text.slice(0, MAX_DISPLAY_CHARS) : text;
  });

  /** The visible text in runs to colour; a single plain run when colouring does not apply. */
  readonly segments = computed<JsonSegment[]>(() => {
    const text = this.visibleText();
    const colour = this.view() === 'pretty' && !this.isText() && text.length <= MAX_HIGHLIGHT_CHARS;
    return colour ? highlightJson(text) : [{ text, kind: 'plain' }];
  });

  readonly tableRows = computed(() => {
    const rows = this.table()?.rows ?? [];
    return this.expanded() ? rows : rows.slice(0, COLLAPSED_ROWS);
  });
  readonly hiddenRows = computed(() => (this.table()?.rows.length ?? 0) - COLLAPSED_ROWS);

  readonly showTable = computed(() => this.view() === 'table' && this.table() !== null);
  readonly canFold = computed(() =>
    this.showTable() ? this.hiddenRows() > 0 : this.clamped() && !this.cutByLimit()
  );

  setView(view: OutputView): void {
    this.view.set(view);
    this.expanded.set(false);
  }

  toggleExpanded(): void {
    this.expanded.update(open => !open);
  }

  readonly cell = formatCell;
}
