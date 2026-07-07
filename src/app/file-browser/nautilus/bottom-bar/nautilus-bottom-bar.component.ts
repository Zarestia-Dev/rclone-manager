import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  TemplateRef,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslatePipe } from '@ngx-translate/core';

@Component({
  selector: 'app-nautilus-bottom-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, MatButtonModule, CdkMenuModule, TranslatePipe],
  templateUrl: './nautilus-bottom-bar.component.html',
  styleUrl: './nautilus-bottom-bar.component.scss',
})
export class NautilusBottomBarComponent {
  // --- Inputs ---
  public readonly layout = input.required<'grid' | 'list'>();
  public readonly viewMenu = input.required<TemplateRef<unknown>>();
  public readonly isPickerMode = input(false);
  public readonly isConfirmDisabled = input(false);

  // --- Outputs ---
  public readonly setLayout = output<'grid' | 'list'>();
  public readonly confirmSelection = output<void>();
  public readonly toggleSidebar = output<void>();

  protected readonly oppositeLayout = computed((): 'grid' | 'list' =>
    this.layout() === 'grid' ? 'list' : 'grid'
  );
}
