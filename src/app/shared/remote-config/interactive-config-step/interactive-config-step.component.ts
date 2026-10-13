import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LineBreaksPipe } from '@app/pipes';
import { RcConfigExample, RcConfigQuestionResponse } from '@app/types';
import { getDefaultAnswerFromQuestion } from 'src/app/services/remote/utils/remote-config.utils';
import { AlertBannerComponent } from 'src/app/shared/components/alert-banner/alert-banner.component';

@Component({
  selector: 'app-interactive-config-step',
  imports: [
    FormsModule,
    MatFormFieldModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    LineBreaksPipe,
    TranslatePipe,
    AlertBannerComponent,
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

  readonly showPassword = signal(false);

  readonly answer = linkedSignal(() => {
    const q = this.question();
    return q ? getDefaultAnswerFromQuestion(q) : null;
  });

  readonly hasError = computed(() => !!this.question()?.Error);

  readonly errorMessage = computed(() => this.question()?.Error || '');

  readonly hasExamples = computed(() => !!this.question()?.Option?.Examples?.length);

  readonly allowsCustomValue = computed(
    () => this.hasExamples() && !this.question()?.Option?.Exclusive
  );

  readonly selectedIndex = computed<number | null>(() => {
    const q = this.question();
    if (!q) return null;
    const examples = q.Option?.Examples;
    if (!examples?.length) return null;
    const current = this.answer();
    if (current === null || current === undefined) return null;

    // 1. Direct value match
    let idx = examples.findIndex(ex => ex.Value === current);
    if (idx >= 0) return idx;

    // 2. Loose stringified match
    idx = examples.findIndex(ex => String(ex.Value) === String(current));
    if (idx >= 0) return idx;

    // 3. 1-based numeric index fallback
    const num = parseInt(String(current), 10);
    if (!isNaN(num) && num >= 1 && num <= examples.length) {
      return num - 1;
    }

    return null;
  });

  readonly selectedDisplayValue = computed(() =>
    this.getDisplayValue(this.selectedIndex(), this.question()?.Option?.Examples)
  );

  readonly isFieldRequired = computed(() => !!this.question()?.Option?.Required);

  readonly isPassword = computed(
    () => !!this.question()?.Option?.IsPassword || this.question()?.Option?.Type === 'password'
  );

  readonly isValidAnswer = computed(() => {
    if (this.hasError()) return false;
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

  togglePasswordVisibility(): void {
    this.showPassword.update(v => !v);
  }

  onAnswerChange(val: string | number | boolean | null): void {
    if (this.answer() === val) return;
    this.answer.set(val);
    this.answerChange.emit(val);
  }

  onSelectionChange(index: number): void {
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
