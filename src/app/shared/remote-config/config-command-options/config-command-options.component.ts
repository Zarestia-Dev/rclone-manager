import { ChangeDetectionStrategy, Component, computed, model, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { TranslatePipe } from '@ngx-translate/core';
import { CommandOption, PREDEFINED_OPTIONS } from '@app/types';

@Component({
  selector: 'app-config-command-options',
  imports: [
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    TranslatePipe,
  ],
  templateUrl: './config-command-options.component.html',
  styleUrl: './config-command-options.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfigCommandOptionsComponent {
  readonly options = model.required<CommandOption[]>();
  readonly newOptionKey = signal('');
  readonly newOptionType = signal<'boolean' | 'string' | 'number' | 'array'>('boolean');
  readonly availablePredefinedOptions = computed(() => {
    const active = new Set(this.options().map(o => o.key));
    return PREDEFINED_OPTIONS.filter(p => !active.has(p.key));
  });

  readonly commandOptionsView = computed(() => {
    return this.options().map(opt => {
      const isArray = Array.isArray(opt.value);
      const typeOfVal = typeof opt.value;
      const type = isArray
        ? 'array'
        : typeOfVal === 'boolean' || typeOfVal === 'number'
          ? typeOfVal
          : 'string';

      return {
        ...opt,
        type,
        booleanValue: type === 'boolean' ? (opt.value as boolean) : false,
        stringValue: type === 'string' || type === 'number' ? String(opt.value) : '',
        arrayValue: isArray ? (opt.value as string[]) : [],
      };
    });
  });

  // ── Command option mutations ──────────────────────────────────────────────

  addPredefinedOption(predefined: CommandOption): void {
    this.options.update(opts => [...opts, { ...predefined }]);
  }

  addCustomOption(): void {
    const key = this.newOptionKey().trim();
    if (!key || this.options().some(option => option.key === key)) return;

    const type = this.newOptionType();
    const value: CommandOption['value'] =
      type === 'boolean' ? true : type === 'number' ? 0 : type === 'array' ? [] : '';

    this.options.update(opts => [...opts, { key, value }]);
    this.newOptionKey.set('');
  }

  removeOption(key: string): void {
    this.options.update(opts => opts.filter(o => o.key !== key));
  }

  updateOption(key: string, value: CommandOption['value']): void {
    this.options.update(opts => opts.map(o => (o.key === key ? { ...o, value } : o)));
  }

  updateNumberOption(key: string, rawValue: string): void {
    const num = parseFloat(rawValue);
    if (!isNaN(num)) this.updateOption(key, num);
  }

  addArrayChip(key: string, value: string, input: HTMLInputElement): void {
    const val = value.trim();
    if (!val) return;
    this.options.update(opts =>
      opts.map(o => (o.key === key ? { ...o, value: [...(o.value as string[]), val] } : o))
    );
    input.value = '';
  }

  handleArrayChipKeydown(key: string, event: KeyboardEvent | Event, input: HTMLInputElement): void {
    if (event instanceof KeyboardEvent) {
      if (event.key !== 'Enter' && event.key !== ',') return;
      event.preventDefault();
    }
    this.addArrayChip(key, input.value, input);
  }

  removeArrayChip(key: string, index: number): void {
    this.options.update(opts =>
      opts.map(o =>
        o.key === key ? { ...o, value: (o.value as string[]).filter((_, i) => i !== index) } : o
      )
    );
  }
}
