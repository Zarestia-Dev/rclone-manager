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

import { SharedProfileType, EditTarget } from '@app/types';
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
  readonly remoteType = input('');
  readonly activeStep = input<EditTarget>(null);
  readonly existingProfiles = input<Record<SharedProfileType, string[]>>(
    {} as Record<SharedProfileType, string[]>
  );

  readonly apply = output<{
    result: ImportResult;
    profileName: string;
    mode: 'new' | 'override' | 'patch';
  }>();

  readonly cliInput = signal('');
  readonly importResult = signal<ImportResult | null>(null);
  readonly profileMode = signal<'new' | 'override' | 'patch'>('new');
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
    if (this.profileMode() === 'patch') {
      const step = this.activeStep();
      return !step || step === 'remote';
    }
    return this.profileMode() === 'new'
      ? !this.newProfileName().trim()
      : !this.selectedOverrideProfile();
  });

  async previewImport(): Promise<void> {
    const text = this.cliInput().trim();
    if (!text) {
      this.importResult.set(null);
      this.validationError.set(null);
      return;
    }

    try {
      const result = await this.mapper.importCliCommand(text, this.remoteType());
      if (!result.verb && result.classified.length === 0) {
        this.validationError.set('wizards.cliImport.invalidCommand');
        this.importResult.set(null);
        return;
      }

      this.validationError.set(null);
      this.importResult.set(result);
      if (!result.verb) {
        this.profileMode.set('patch');
      } else {
        this.profileMode.set('new');
      }
    } catch (error) {
      console.error('Failed to parse CLI import command:', error);
      this.validationError.set('wizards.cliImport.invalidCommand');
      this.importResult.set(null);
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

    const mode = this.profileMode();
    const profileName =
      mode === 'new'
        ? this.newProfileName().trim()
        : mode === 'override'
          ? this.selectedOverrideProfile()
          : '';

    this.apply.emit({
      result,
      profileName,
      mode,
    });
  }
}
