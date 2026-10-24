import {
  Component,
  ElementRef,
  effect,
  input,
  output,
  viewChild,
  ChangeDetectionStrategy,
  HostListener,
  inject,
} from '@angular/core';

import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { findKeyboardShortcutTarget, matchesShortcut } from '../../utils/keyboard-utils';

@Component({
  selector: 'app-search-container',
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatIconModule, TranslatePipe],
  templateUrl: './search-container.component.html',
  styleUrls: ['./search-container.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.data-search-shortcut]': 'enableShortcut() ? "" : null',
  },
})
export class SearchContainerComponent {
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);
  visible = input(false);
  placeholder = input('shared.search.placeholder');
  ariaLabel = input('shared.search.ariaLabel');
  searchText = input('');
  enableShortcut = input(true);

  searchTextChange = output<string>();
  searchToggle = output<void>();
  visibleChange = output<boolean>();

  searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');

  constructor() {
    effect(() => {
      if (this.visible()) {
        requestAnimationFrame(() => this.focus());
      }
    });
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent): void {
    if (
      this.enableShortcut() &&
      matchesShortcut('Ctrl + F', event) &&
      findKeyboardShortcutTarget(
        event,
        'app-search-container[data-search-shortcut]',
        this.elementRef.nativeElement.ownerDocument
      ) === this.elementRef.nativeElement
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
