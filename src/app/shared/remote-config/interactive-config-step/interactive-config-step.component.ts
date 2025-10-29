import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  inject,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatIconModule } from '@angular/material/icon';
import { RcConfigQuestionResponse } from '@app/services';
import { LineBreaksPipe } from '@app/pipes';

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
  ],
  templateUrl: './interactive-config-step.component.html',
  styleUrls: ['./interactive-config-step.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InteractiveConfigStepComponent implements OnChanges {
  cdRef = inject(ChangeDetectorRef);

  @Input() question: RcConfigQuestionResponse | null = null;
  @Input() canceling = false;
  @Input() processing = false;
  @Output() answerChange = new EventEmitter<string | number | boolean | null>();

  _answer: string | boolean | number | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['question']) {
      this._answer = this.defaultAnswer(this.question);
    }
  }

  get answer(): string | boolean | number | null {
    return this._answer;
  }

  set answer(val: string | boolean | number | null) {
    if (this._answer !== val) {
      this._answer = val;
      this.answerChange.emit(this._answer);
      this.cdRef.markForCheck();
    }
  }
  trackByIndex = (index: number): number => index;

  /**
   * Check if the current field is required
   */
  isFieldRequired(): boolean {
    return !!this.question?.Option?.Required;
  }

  /**
   * Check if the current answer is valid
   */
  isValidAnswer(): boolean {
    if (!this.isFieldRequired()) {
      return true; // Not required, so always valid
    }

    // For required fields, check if we have a valid answer
    if (this.answer === null || this.answer === undefined) {
      return false;
    }

    // For string answers, check if not empty
    if (typeof this.answer === 'string') {
      return this.answer.trim() !== '';
    }

    // For boolean and number answers, they're valid as long as they're not null
    return true;
  }

  /**
   * Get placeholder text for input fields
   */
  getInputPlaceholder(q: RcConfigQuestionResponse): string {
    if (q.Option?.DefaultStr) {
      return `Default: ${q.Option.DefaultStr}`;
    }
    if (q.Option?.Default !== undefined && q.Option?.Default !== null) {
      return `Default: ${q.Option.Default}`;
    }
    return 'Enter a value...';
  }

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
}
