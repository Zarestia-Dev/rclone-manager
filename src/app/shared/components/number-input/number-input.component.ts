import {
  Component,
  ChangeDetectionStrategy,
  forwardRef,
  input,
  signal,
  OnDestroy,
} from '@angular/core';
import {
  ControlValueAccessor,
  NG_VALUE_ACCESSOR,
  FormControl,
  ReactiveFormsModule,
} from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { TranslatePipe } from '@ngx-translate/core';

@Component({
  selector: 'app-number-input',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatIconModule,
    MatInputModule,
    MatFormFieldModule,
    TranslatePipe,
  ],
  templateUrl: './number-input.component.html',
  styleUrl: './number-input.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => NumberInputComponent),
      multi: true,
    },
  ],
})
export class NumberInputComponent implements ControlValueAccessor, OnDestroy {
  readonly placeholder = input<string>('');
  readonly step = input<number | 'any'>(1);
  readonly min = input<number | undefined>(undefined);
  readonly max = input<number | undefined>(undefined);
  readonly isFloat = input<boolean>(false);
  readonly isSensitive = input<boolean>(false);
  readonly ariaLabel = input<string>('');
  readonly allowNegative = input<boolean>(true);

  readonly innerControl = new FormControl<string | number | null>(null);

  // Hold Timer (stepper long-press)
  private holdInterval: ReturnType<typeof setInterval> | null = null;
  private holdTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly HOLD_DELAY = 400;
  private readonly HOLD_INTERVAL = 80;

  private onChange: (value: number | null) => void = () => {
    /* empty */
  };
  private onTouched: () => void = () => {
    /* empty */
  };

  readonly disabled = signal(false);

  constructor() {
    this.innerControl.valueChanges.pipe(takeUntilDestroyed()).subscribe(val => {
      if (val === null || val === undefined || val === '') {
        this.onChange(null);
        return;
      }
      const numVal = this.isFloat() ? parseFloat(String(val)) : parseInt(String(val), 10);
      this.onChange(isNaN(numVal) ? null : numVal);
    });
  }

  ngOnDestroy(): void {
    if (this.holdTimeout) clearTimeout(this.holdTimeout);
    if (this.holdInterval) clearInterval(this.holdInterval);
  }

  writeValue(value: unknown): void {
    if (value === null || value === undefined || value === '') {
      this.innerControl.setValue(null, { emitEvent: false });
      return;
    }
    const parsed = this.isFloat() ? parseFloat(String(value)) : parseInt(String(value), 10);
    this.innerControl.setValue(isNaN(parsed) ? null : parsed, { emitEvent: false });
  }

  registerOnChange(fn: (value: number | null) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
    if (isDisabled) {
      this.innerControl.disable({ emitEvent: false });
    } else {
      this.innerControl.enable({ emitEvent: false });
    }
  }

  onBlur(): void {
    const val = this.innerControl.value;
    if (val !== null && val !== undefined && val !== '') {
      // Validate boundaries on blur
      const current = this.isFloat() ? parseFloat(String(val)) : parseInt(String(val), 10);
      if (!isNaN(current)) {
        let bounded = current;
        const minVal = this.min();
        const maxVal = this.max();
        if (minVal !== undefined && bounded < minVal) {
          bounded = minVal;
        }
        if (maxVal !== undefined && bounded > maxVal) {
          bounded = maxVal;
        }
        if (bounded !== current) {
          this.innerControl.setValue(bounded);
        }
      }
    }
    this.onTouched();
  }

  startHold(action: 'increment' | 'decrement'): void {
    if (this.disabled()) return;
    this.stopHold();
    const dir = action === 'increment' ? 1 : -1;
    this.stepChange(dir);
    this.holdTimeout = setTimeout(() => {
      this.holdInterval = setInterval(() => this.stepChange(dir), this.HOLD_INTERVAL);
    }, this.HOLD_DELAY);
  }

  stopHold(): void {
    if (this.holdTimeout) clearTimeout(this.holdTimeout);
    if (this.holdInterval) clearInterval(this.holdInterval);
    this.holdTimeout = this.holdInterval = null;
    this.onBlur();
  }

  private stepChange(direction: 1 | -1): void {
    if (this.disabled()) return;
    const current = this.innerControl.value;
    const num = current !== null && !isNaN(Number(current)) ? Number(current) : 0;
    const stepVal = this.step();
    const parsedStep = stepVal === 'any' ? 1.0 : stepVal;
    const next = num + parsedStep * direction;

    // Apply min/max boundary constraints during active stepping
    const minVal = this.min();
    const maxVal = this.max();
    if (minVal !== undefined && next < minVal) {
      this.innerControl.setValue(minVal);
      return;
    }
    if (maxVal !== undefined && next > maxVal) {
      this.innerControl.setValue(maxVal);
      return;
    }

    const isFloatVal = this.isFloat();
    this.innerControl.setValue(isFloatVal ? parseFloat(next.toPrecision(15)) : next);
  }

  onNumberInput(event: KeyboardEvent): void {
    const navigationKeys = [
      'Backspace',
      'Delete',
      'Tab',
      'Escape',
      'Enter',
      'Home',
      'End',
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
    ];
    if (navigationKeys.includes(event.key) || event.ctrlKey || event.metaKey) return;

    if (event.key === '-' && this.allowNegative()) {
      const inputEl = event.target as HTMLInputElement;
      if (inputEl.selectionStart === 0 && !inputEl.value.includes('-')) return;
    }

    if (this.isFloat() && (event.key === '.' || event.key === ',')) {
      const inputEl = event.target as HTMLInputElement;
      if (!inputEl.value.includes('.') && !inputEl.value.includes(',')) return;
    }

    if (!/^\d$/.test(event.key)) {
      event.preventDefault();
    }
  }

  preventClipboardOnSensitive(event: ClipboardEvent): void {
    if (this.isSensitive()) {
      event.preventDefault();
    }
  }
}
