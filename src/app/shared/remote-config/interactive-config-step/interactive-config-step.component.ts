import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
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
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LineBreaksPipe } from '@app/pipes';
import { RcConfigExample, RcConfigQuestionResponse } from '@app/types';
import { getDefaultAnswerFromQuestion } from '@app/services';

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
  private readonly translate = inject(TranslateService);

  readonly question = input<RcConfigQuestionResponse | null>(null);
  readonly canceling = input(false);
  readonly processing = input(false);

  readonly answerChange = output<string | number | boolean | null>();

  readonly answer = signal<string | boolean | number | null>(null);

  // Keep an explicit selected index so duplicate option values remain selectable.
  readonly selectedIndex = signal<number | null>(null);
  readonly selectedDisplayValue = computed(() =>
    this.getDisplayValue(this.selectedIndex(), this.question()?.Option?.Examples)
  );

  readonly isFieldRequired = computed(() => !!this.question()?.Option?.Required);

  readonly isValidAnswer = computed(() => {
    if (!this.isFieldRequired()) return true;
    const current = this.answer();
    if (current === null || current === undefined) return false;
    return typeof current !== 'string' || current.trim() !== '';
  });

  readonly inputPlaceholder = computed(() => {
    const q = this.question();
    const fallback = this.translate.instant('wizards.remoteConfig.enterValue');
    if (!q) return fallback;
    if (q.Option?.DefaultStr) {
      return `${this.translate.instant('wizards.remoteConfig.defaultPrefix')} ${q.Option.DefaultStr}`;
    }
    if (q.Option?.Default !== undefined && q.Option?.Default !== null) {
      return `${this.translate.instant('wizards.remoteConfig.defaultPrefix')} ${q.Option.Default}`;
    }
    return fallback;
  });

  constructor() {
    effect(() => {
      const q = this.question();
      const initialAnswer = q ? getDefaultAnswerFromQuestion(q) : null;
      this.answer.set(initialAnswer);

      const examples = q?.Option?.Examples;
      if (!examples?.length) {
        this.selectedIndex.set(null);
        return;
      }

      const initialIndex = examples.findIndex(ex => ex.Value === initialAnswer);
      this.selectedIndex.set(initialIndex >= 0 ? initialIndex : null);
    });
  }

  onAnswerChange(val: string | number | boolean | null): void {
    if (this.answer() === val) return;
    this.answer.set(val);
    this.answerChange.emit(val);
  }

  onSelectionChange(index: number): void {
    this.selectedIndex.set(index);
    const examples = this.question()?.Option?.Examples;
    if (examples && index >= 0 && index < examples.length) {
      const selectedValue = examples[index].Value;
      this.answer.set(selectedValue);
      this.answerChange.emit(selectedValue);
    }
  }

  private getDisplayValue(index: number | null, examples: RcConfigExample[] | undefined): string {
    if (!examples || index === null || index < 0 || index >= examples.length) return '';
    const selected = examples[index];
    return selected ? selected.Help || selected.Value : '';
  }
}
