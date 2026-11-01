import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  output,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { RcDocsComponent } from '../../../../../shared/components/rc-docs/rc-docs.component';
import { TranslatePipe } from '@ngx-translate/core';
import { RcCommandInfo } from '@app/types';
import {
  formatCommandLine,
  isDangerousCommand,
} from '../../../../../shared/utils/rc/rc-console.util';
import { extractExamples, parseRcParams } from '../../../../../shared/utils/rc/rc-help.util';
import { annotateParams } from '../../../../../shared/utils/rc/rc-schema.util';

@Component({
  selector: 'app-rc-help',
  imports: [MatIconModule, TranslatePipe, RcDocsComponent],
  templateUrl: './rc-help.component.html',
  styleUrl: './rc-help.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RcHelpComponent {
  readonly command = input.required<RcCommandInfo>();

  /** Put this line in the input. */
  readonly insert = output<string>();
  /** Run this line right away. */
  readonly run = output<string>();
  readonly closed = output<void>();

  readonly params = computed(() =>
    annotateParams(this.command().Path, parseRcParams(this.command().Help))
  );
  /** Required parameters that have no value yet. */
  readonly missingRequired = computed(
    () => this.params().filter(p => p.required && !(this.values()[p.name] ?? '').trim()).length
  );
  readonly examples = computed(() => extractExamples(this.command().Help));
  readonly dangerous = computed(() => isDangerousCommand(this.command().Path));

  /** What the user typed into the parameter fields; starts empty for each command. */
  readonly values = linkedSignal<RcCommandInfo, Record<string, string>>({
    source: this.command,
    computation: () => ({}),
  });
  readonly built = computed(() => {
    const filled = Object.entries(this.values()).filter(([, value]) => value.trim() !== '');
    return formatCommandLine(this.command().Path, Object.fromEntries(filled));
  });

  setValue(name: string, value: string): void {
    this.values.update(values => ({ ...values, [name]: value }));
  }
}
