import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
  output,
  signal,
  computed,
  linkedSignal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatRadioModule } from '@angular/material/radio';
import { TranslateModule } from '@ngx-translate/core';

import { RcConfigOption, SharedProfileType } from '@app/types';
import { CliFlagMapperService, ImportResult } from '@app/services';

@Component({
  selector: 'app-cli-import',
  imports: [
    FormsModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatRadioModule,
    TranslateModule,
  ],
  templateUrl: './cli-import.component.html',
  styleUrl: './cli-import.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CliImportComponent {
  private readonly mapper = inject(CliFlagMapperService);

  readonly visible = input(false);
  readonly flagFields = input.required<Record<SharedProfileType, RcConfigOption[]>>();
  readonly remoteType = input('');
  readonly existingProfiles = input<Record<SharedProfileType, string[]>>(
    {} as Record<SharedProfileType, string[]>
  );

  readonly apply = output<{ result: ImportResult; profileName: string; isNew: boolean }>();

  readonly cliInput = signal('');
  readonly importResult = signal<ImportResult | null>(null);
  readonly profileMode = signal<'new' | 'override'>('new');
  readonly newProfileName = signal('');
  readonly validationError = signal<string | null>(null);

  readonly detectedVerbProfiles = computed(() => {
    const verb = (this.importResult()?.verb ?? 'sync') as SharedProfileType;
    return this.existingProfiles()[verb] ?? [];
  });

  readonly selectedOverrideProfile = linkedSignal(() => this.detectedVerbProfiles()[0] ?? '');

  readonly mappedFlags = computed(
    () => this.importResult()?.classified.filter(f => f.status === 'mapped') ?? []
  );

  readonly unknownFlags = computed(
    () => this.importResult()?.classified.filter(f => f.status === 'unknown') ?? []
  );

  readonly macroFlags = computed(() => {
    const res = this.importResult();
    if (!res) return [];

    const verb = res.verb ?? 'sync';
    const items: { source: string; value: string }[] = [];

    if (res.sourcePath && this.mapper.hasMacro(res.sourcePath)) {
      items.push({
        source: verb === 'mount' || verb === 'serve' ? 'Remote' : 'Source Path',
        value: res.sourcePath,
      });
    }
    if (res.destPath && this.mapper.hasMacro(res.destPath)) {
      items.push({
        source: verb === 'mount' ? 'Mount Point' : 'Destination Path',
        value: res.destPath,
      });
    }

    for (const f of res.classified) {
      if (f.flag.hasMacro) {
        items.push({ source: `--${f.flag.key}`, value: String(f.flag.value) });
      }
    }

    return items;
  });

  readonly isApplyDisabled = computed(() => {
    if (!this.importResult()) return true;
    return this.profileMode() === 'new'
      ? !this.newProfileName().trim()
      : !this.selectedOverrideProfile();
  });

  private readonly lookupTable = computed(() =>
    this.mapper.buildLookupTable(this.flagFields(), this.remoteType())
  );

  private readonly booleanFlags = computed(() => {
    const bools = new Set<string>();

    for (const fields of Object.values(this.flagFields())) {
      for (const f of fields) {
        if (f.Type !== 'bool' && f.Type !== 'Tristate') continue;

        const names = [f.Name, f.FieldName].filter(Boolean) as string[];
        for (const name of names) {
          const lower = name.toLowerCase();
          bools.add(lower);
          bools.add(lower.replace(/_/g, '-'));
        }
      }
    }
    return bools;
  });

  previewImport(): void {
    const text = this.cliInput().trim();
    if (!text) {
      this.importResult.set(null);
      this.validationError.set(null);
      return;
    }

    const parsed = this.mapper.parse(text, this.booleanFlags());
    if (!parsed.verb && parsed.flags.length === 0) {
      this.validationError.set('wizards.cliImport.invalidCommand');
      this.importResult.set(null);
      return;
    }

    this.validationError.set(null);
    this.importResult.set(this.mapper.classify(parsed, this.lookupTable()));
  }

  clearInput(): void {
    this.cliInput.set('');
    this.importResult.set(null);
    this.validationError.set(null);
  }

  onApply(): void {
    const result = this.importResult();
    if (!result) return;

    const isNew = this.profileMode() === 'new';
    this.apply.emit({
      result,
      profileName: isNew ? this.newProfileName().trim() : this.selectedOverrideProfile(),
      isNew,
    });
  }
}
