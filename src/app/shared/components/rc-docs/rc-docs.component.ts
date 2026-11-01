import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { helpToHtml } from '../../utils/rc/rc-help.util';

/** An rclone call's help text, rendered from its markdown and folded away until asked for. */
@Component({
  selector: 'app-rc-docs',
  imports: [TranslatePipe],
  templateUrl: './rc-docs.component.html',
  styleUrl: './rc-docs.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RcDocsComponent {
  readonly help = input('');

  /** Angular sanitizes this again when it is bound with `[innerHTML]`. */
  readonly html = computed(() => helpToHtml(this.help()));
}
