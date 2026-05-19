import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
  output,
  signal,
  computed,
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
  standalone: true,
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
  private readonly mapperService = inject(CliFlagMapperService);

  readonly visible = input(false);
  readonly flagFields = input.required<Record<SharedProfileType, RcConfigOption[]>>();
  readonly remoteType = input<string>('');
  readonly existingProfiles = input<Record<SharedProfileType, string[]>>({} as any);

  readonly apply = output<{ result: ImportResult; profileName: string; isNew: boolean }>();

  readonly cliInput = signal('');
  readonly importResult = signal<ImportResult | null>(null);
  readonly profileMode = signal<'new' | 'override'>('new');
  readonly newProfileName = signal('');
  readonly selectedOverrideProfile = signal('default');

  readonly detectedVerbProfiles = computed(() => {
    const verb = (this.detectedVerb() || 'sync') as SharedProfileType;
    return this.existingProfiles()[verb] ?? [];
  });

  private readonly lookupTable = computed(() =>
    this.mapperService.buildLookupTable(this.flagFields(), this.remoteType())
  );

  private readonly booleanFlags = computed(() => {
    const bools = new Set<string>();
    Object.values(this.flagFields()).forEach(fields => {
      fields.forEach(f => {
        if (f.Type === 'bool' || f.Type === 'Tristate') {
          if (f.Name) bools.add(f.Name);
          if (f.FieldName) bools.add(f.FieldName);
        }
      });
    });
    return bools;
  });

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
    const sourceLabel = verb === 'mount' || verb === 'serve' ? 'Remote' : 'Source Path';
    const destLabel = verb === 'mount' ? 'Mount Point' : 'Destination Path';
    const items: { source: string; value: string }[] = [];

    if (res.sourcePath && this.mapperService.hasMacro(res.sourcePath)) {
      items.push({ source: sourceLabel, value: res.sourcePath });
    }
    if (res.destPath && this.mapperService.hasMacro(res.destPath)) {
      items.push({ source: destLabel, value: res.destPath });
    }
    res.classified.forEach(f => {
      if (f.flag.hasMacro) {
        items.push({ source: `--${f.flag.key}`, value: String(f.flag.value) });
      }
    });
    return items;
  });

  readonly detectedVerb = computed(() => this.importResult()?.verb ?? '');
  readonly detectedServeSubtype = computed(() => this.importResult()?.serveSubtype ?? '');
  readonly detectedSource = computed(() => this.importResult()?.sourcePath ?? '');
  readonly detectedDest = computed(() => this.importResult()?.destPath ?? '');

  readonly validationError = signal<string | null>(null);

  readonly isApplyDisabled = computed(() => {
    if (!this.importResult()) return true;
    return this.profileMode() === 'new'
      ? !this.newProfileName().trim()
      : !this.selectedOverrideProfile();
  });

  previewImport(): void {
    const text = this.cliInput().trim();
    if (!text) {
      this.importResult.set(null);
      this.validationError.set(null);
      return;
    }
    const parsed = this.mapperService.parse(text, this.booleanFlags());
    if (!parsed.verb && parsed.flags.length === 0) {
      this.validationError.set('wizards.cliImport.invalidCommand');
      this.importResult.set(null);
      return;
    }

    this.validationError.set(null);
    this.importResult.set(this.mapperService.classify(parsed, this.lookupTable()));

    const profiles = this.detectedVerbProfiles();
    if (profiles.length > 0 && !profiles.includes(this.selectedOverrideProfile())) {
      this.selectedOverrideProfile.set(profiles[0]);
    }
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
