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
import { AlertBannerComponent } from 'src/app/shared/components/alert-banner/alert-banner.component';

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
    AlertBannerComponent,
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
  readonly selectedFlags = signal<Set<string>>(new Set());
  readonly selectedOverrideProfile = signal('');

  // Derivations
  readonly effectiveProfileType = computed<SharedProfileType | null>(() => {
    const result = this.importResult();
    if (result?.verb) return result.verb as SharedProfileType;
    const step = this.activeStep();
    if (step && step !== 'remote') return step;
    return null;
  });

  readonly detectedVerbProfiles = computed(() => {
    const type = this.effectiveProfileType();
    if (!type) return [];
    return this.existingProfiles()[type] ?? [];
  });

  readonly canPatch = computed(() => {
    const step = this.activeStep();
    return !!step && step !== 'remote';
  });

  readonly canCreateNew = computed(() => !!this.effectiveProfileType());

  readonly canOverride = computed(
    () => this.canCreateNew() && this.detectedVerbProfiles().length > 0
  );

  readonly mappedFlags = computed(
    () => this.importResult()?.classified.filter(f => f.status === 'mapped') ?? []
  );

  readonly unknownFlags = computed(
    () => this.importResult()?.classified.filter(f => f.status === 'unknown') ?? []
  );

  readonly macroFlags = computed(() => {
    const res = this.importResult();
    if (!res) return [];

    const type = this.effectiveProfileType();
    const isMount = type === 'mount';
    const isServe = type === 'serve';
    const items: { source: string; value: string }[] = [];

    if (res.sourcePath && this.mapper.hasMacro(res.sourcePath)) {
      items.push({
        source: isMount || isServe ? 'wizards.cliImport.remote' : 'wizards.cliImport.source',
        value: res.sourcePath,
      });
    }
    if (res.destPath && this.mapper.hasMacro(res.destPath)) {
      items.push({
        source: isMount ? 'wizards.cliImport.mountPoint' : 'wizards.cliImport.destination',
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
    const result = this.importResult();
    if (!result) return true;

    const hasFlags = this.selectedFlags().size > 0;
    const hasPaths =
      (result.sourcePath && this.importSourcePath()) || (result.destPath && this.importDestPath());
    if (!hasFlags && !hasPaths) return true;

    switch (this.profileMode()) {
      case 'patch':
        return !this.canPatch();
      case 'new':
        return !this.canCreateNew() || !this.newProfileName().trim();
      case 'override':
        return !this.canOverride() || !this.selectedOverrideProfile();
    }
  });

  // Selection Helpers

  toggleFlag(key: string): void {
    const current = new Set(this.selectedFlags());
    if (current.has(key)) {
      current.delete(key);
    } else {
      current.add(key);
    }
    this.selectedFlags.set(current);
  }

  isFlagSelected(key: string): boolean {
    return this.selectedFlags().has(key);
  }

  selectAllFlags(): void {
    const mapped = this.mappedFlags().map(f => f.flag.key);
    this.selectedFlags.set(new Set(mapped));
  }

  deselectAllFlags(): void {
    this.selectedFlags.set(new Set());
  }

  // Actions

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
      const mapped = result.classified.filter(f => f.status === 'mapped').map(f => f.flag.key);
      this.selectedFlags.set(new Set(mapped));
      this.importSourcePath.set(true);
      this.importDestPath.set(true);
      this.profileMode.set(this.canCreateNew() ? 'new' : 'patch');
      this.selectedOverrideProfile.set(this.detectedVerbProfiles()[0] ?? '');
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
    this.selectedFlags.set(new Set());
    this.selectedOverrideProfile.set('');
  }

  onApply(): void {
    const result = this.importResult();
    if (!result) return;

    const selectedKeys = this.selectedFlags();
    const filteredClassified = result.classified.filter(cls => {
      if (cls.status === 'mapped') {
        return selectedKeys.has(cls.flag.key);
      }
      return true;
    });

    const filteredResult: ImportResult = {
      ...result,
      classified: filteredClassified,
    };

    const mode = this.profileMode();
    const profileName =
      mode === 'new'
        ? this.newProfileName().trim()
        : mode === 'override'
          ? this.selectedOverrideProfile()
          : '';

    this.apply.emit({
      result: filteredResult,
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
