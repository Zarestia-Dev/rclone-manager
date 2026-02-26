import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatIconModule } from '@angular/material/icon';
import { LineBreaksPipe } from '@app/pipes';
import { RcConfigExample, RcConfigQuestionResponse } from '@app/types';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-interactive-config-step',
  standalone: true,
  imports: [
    FormsModule,
    MatFormFieldModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    LineBreaksPipe,
    TranslateModule,
  ],
  templateUrl: './interactive-config-step.component.html',
  styleUrls: ['./interactive-config-step.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InteractiveConfigStepComponent {
  // Inputs as signals
  question = input<RcConfigQuestionResponse | null>(null);
  canceling = input(false);
  processing = input(false);

  // Output
  answerChange = output<string | number | boolean | null>();

  // Answer state as signal
  private _answer = signal<string | boolean | number | null>(null);

  /** Selected index for dropdown to handle duplicate values */
  selectedIndex = signal<number | null>(null);

  /** Getter for template usage */
  get answer(): string | boolean | number | null {
    return this._answer();
  }

  /** Setter for [(ngModel)] support */
  set answer(val: string | boolean | number | null) {
    if (this._answer() !== val) {
      this._answer.set(val);
      this.answerChange.emit(val);

      // Sync selectedIndex when answer changes externally or via other inputs
      const ex = this.question()?.Option?.Examples;
      if (ex && val !== null) {
        // Find first matching value if index not already set or invalid
        const currentIdx = this.selectedIndex();
        if (
          currentIdx === null ||
          currentIdx < 0 ||
          currentIdx >= ex.length ||
          ex[currentIdx].Value !== val
        ) {
          const idx = ex.findIndex(e => e.Value === val);
          this.selectedIndex.set(idx >= 0 ? idx : null);
        }
      } else {
        this.selectedIndex.set(null);
      }
    }
  }

  /** Whether the current field is required */
  isFieldRequired = computed(() => !!this.question()?.Option?.Required);

  /** Whether the current answer is valid */
  isValidAnswer = computed(() => {
    if (!this.isFieldRequired()) return true;

    const currentAnswer = this._answer();
    if (currentAnswer === null || currentAnswer === undefined) return false;

    if (typeof currentAnswer === 'string') {
      return currentAnswer.trim() !== '';
    }
    return true;
  });

  /** Placeholder for input fields */
  inputPlaceholder = computed(() => {
    const q = this.question();
    if (!q) return 'Enter a value...';
    if (q.Option?.DefaultStr) {
      return `Default: ${q.Option.DefaultStr}`;
    }
    if (q.Option?.Default !== undefined && q.Option?.Default !== null) {
      return `Default: ${q.Option.Default}`;
    }
    return 'Enter a value...';
  });

  constructor() {
    // React to question changes and set default answer
    effect(() => {
      const q = this.question();
      this._answer.set(this.defaultAnswer(q));
    });
  }

  trackByIndex = (index: number): number => index;

  private defaultAnswer(q: RcConfigQuestionResponse | null): string | boolean | number {
    const opt = q?.Option;
    if (!opt) return '';
    if (opt.Type === 'bool') {
      if (typeof opt.Value === 'boolean') return opt.Value;
      if (typeof opt.ValueStr === 'string') return opt.ValueStr.toLowerCase() === 'true';
      if (typeof opt.DefaultStr === 'string') return opt.DefaultStr.toLowerCase() === 'true';
      if (typeof opt.Default === 'boolean') return opt.Default;
      return true;
    }
    if (typeof opt.ValueStr === 'string') return opt.ValueStr;
    if (typeof opt.DefaultStr === 'string') return opt.DefaultStr;
    if (opt.Default !== undefined && opt.Default !== null) return String(opt.Default);
    if (opt.Examples && opt.Examples.length > 0) return opt.Examples[0].Value;
    return '';
  }
  getDisplayValue(index: number | null, examples: RcConfigExample[] | undefined): string {
    if (!examples || index === null || index < 0 || index >= examples.length) return '';
    const selected = examples[index];
    return selected ? selected.Help || selected.Value : '';
  }

  onSelectionChange(index: number): void {
    this.selectedIndex.set(index);
    const ex = this.question()?.Option?.Examples;
    if (ex && index >= 0 && index < ex.length) {
      this.answer = ex[index].Value;
    }
  }
}
