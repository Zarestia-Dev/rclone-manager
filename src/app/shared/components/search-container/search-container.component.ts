import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  viewChild,
  ChangeDetectionStrategy,
  HostListener,
} from '@angular/core';

import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';

@Component({
  selector: 'app-search-container',
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatIconModule, TranslatePipe],
  template: `
    <div class="search-container" [class.visible]="visible()">
      <mat-form-field subscriptSizing="dynamic">
        <mat-icon matPrefix svgIcon="search"></mat-icon>
        <input
          #searchInput
          matInput
          [ngModel]="searchText()"
          (ngModelChange)="searchTextChange.emit($event)"
          [placeholder]="placeholder() | translate"
          [attr.aria-label]="ariaLabel() | translate"
        />
      </mat-form-field>
    </div>
  `,
  styleUrls: ['./search-container.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchContainerComponent {
  visible = input(false);
  placeholder = input('shared.search.placeholder');
  ariaLabel = input('shared.search.ariaLabel');
  searchText = input('');
  enableShortcut = input(true);

  searchTextChange = output<string>();
  searchToggle = output<void>();
  visibleChange = output<boolean>();

  searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');

  private readonly injector = inject(Injector);

  constructor() {
    effect(() => {
      if (this.visible()) {
        afterNextRender(() => this.focus(), { injector: this.injector });
      }
    });
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent): void {
    if (
      this.enableShortcut() &&
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'f'
    ) {
      event.preventDefault();
      this.searchToggle.emit();
      this.visibleChange.emit(!this.visible());
    }
  }

  focus(): void {
    this.searchInput()?.nativeElement?.focus();
  }

  clear(): void {
    this.searchTextChange.emit('');
  }
}
