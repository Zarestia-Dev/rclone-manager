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
import { MatCheckboxModule } from '@angular/material/checkbox';
import { TranslatePipe } from '@ngx-translate/core';

import { SharedProfileType, EditTarget } from '@app/types';
import {
  CliFlagMapperService,
  ImportResult,
} from 'src/app/services/remote/cli-flag-mapper.service';

type ProfileMode = 'new' | 'override' | 'patch';

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
    MatCheckboxModule,
    TranslatePipe,
  ],
  templateUrl: './cli-import.component.html',
  styleUrl: './cli-import.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CliImportComponent {
  private readonly mapper = inject(CliFlagMapperService);

  // Inputs & Outputs
  readonly visible = input(false);
  readonly remoteType = input('');
  readonly activeStep = input<EditTarget>(null);
  readonly existingProfiles = input<Record<SharedProfileType, string[]>>(
    {} as Record<SharedProfileType, string[]>
  );

  readonly apply = output<{
    result: ImportResult;
    profileName: string;
    mode: ProfileMode;
    importSourcePath: boolean;
    importDestPath: boolean;
  }>();

  // State Signals
  readonly cliInput = signal('');
  readonly importResult = signal<ImportResult | null>(null);
  readonly profileMode = signal<ProfileMode>('new');
  readonly newProfileName = signal('');
  readonly validationError = signal<string | null>(null);
  readonly importSourcePath = signal(true);
  readonly importDestPath = signal(true);

  // Derivations
  readonly detectedVerbProfiles = computed(() => {
    const verb = (this.importResult()?.verb ?? 'sync') as SharedProfileType;
    return this.existingProfiles()[verb] ?? [];
  });

  readonly selectedOverrideProfile = computed(() => this.detectedVerbProfiles()[0] ?? '');

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

    switch (this.profileMode()) {
      case 'patch':
        return !this.activeStep() || this.activeStep() === 'remote';
      case 'new':
        return !this.newProfileName().trim();
      case 'override':
        return !this.selectedOverrideProfile();
    }
  });

  async previewImport(): Promise<void> {
    const text = this.cliInput().trim();
    if (!text) {
      this.clearInput();
      return;
    }

    try {
      const result = await this.mapper.importCliCommand(text, this.remoteType());
      if (!result.verb && result.classified.length === 0) {
        this.setError('wizards.cliImport.invalidCommand');
        return;
      }

      this.validationError.set(null);
      this.importResult.set(result);
      this.profileMode.set(result.verb ? 'new' : 'patch');
      this.importSourcePath.set(true);
      this.importDestPath.set(true);
    } catch (error) {
      console.error('Failed to parse CLI import command:', error);
      this.setError('wizards.cliImport.invalidCommand');
    }
  }

  clearInput(): void {
    this.cliInput.set('');
    this.importResult.set(null);
    this.validationError.set(null);
    this.importSourcePath.set(true);
    this.importDestPath.set(true);
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
      importSourcePath: this.importSourcePath(),
      importDestPath: this.importDestPath(),
    });
  }

  private setError(msg: string): void {
    this.validationError.set(msg);
    this.importResult.set(null);
  }
}
