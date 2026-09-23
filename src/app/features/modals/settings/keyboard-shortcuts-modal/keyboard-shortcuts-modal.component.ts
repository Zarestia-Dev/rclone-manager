import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { EscapeCloseDirective } from '../../../../shared/directives/escape-close.directive';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTableModule } from '@angular/material/table';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { SearchContainerComponent } from '../../../../shared/components/search-container/search-container.component';
import { isInputFocused, matchesCombo, parseCombos } from '../../../../shared/utils/keyboard-utils';
import {
  getShortcutsForContext,
  ShortcutContext,
} from '../../../../shared/models/shortcut-definitions';

export interface ShortcutItem {
  keys: string;
  description: string;
  category: string;
  combos: string[][];
}

@Component({
  selector: 'app-keyboard-shortcuts-modal',
  hostDirectives: [EscapeCloseDirective],
  imports: [
    MatTableModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    FormsModule,
    MatButtonModule,
    SearchContainerComponent,
    TranslatePipe,
  ],
  templateUrl: './keyboard-shortcuts-modal.component.html',
  styleUrls: ['./keyboard-shortcuts-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KeyboardShortcutsModalComponent {
  private readonly translate = inject(TranslateService);
  private readonly dialogRef = inject(MatDialogRef<KeyboardShortcutsModalComponent>);
  private readonly elementRef = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);
  private readonly data = inject(MAT_DIALOG_DATA, { optional: true }) as {
    context?: ShortcutContext;
    nautilus?: boolean;
  } | null;

  readonly searchContainer = viewChild(SearchContainerComponent);

  // Signals
  readonly searchText = signal('');
  readonly searchVisible = signal(false);
  readonly pressedShortcutKeys = signal<string | null>(null);

  private hitTimeout?: ReturnType<typeof setTimeout>;

  readonly shortcuts: ShortcutItem[];
  readonly title: string;

  readonly filteredShortcuts = computed(() => {
    const term = this.searchText().toLowerCase().trim();
    if (!term) return this.shortcuts;

    return this.shortcuts.filter(shortcut => {
      const description = this.translate.instant(shortcut.description).toLowerCase();
      return (
        description.includes(term) ||
        shortcut.keys.toLowerCase().includes(term) ||
        shortcut.combos.some(combo => combo.some(key => key.toLowerCase().includes(term)))
      );
    });
  });

  constructor() {
    let resolvedContext: ShortcutContext = 'main';
    if (this.data?.context) {
      resolvedContext = this.data.context;
    } else if (this.data?.nautilus) {
      resolvedContext = 'nautilus';
    }

    const sourceList = getShortcutsForContext(resolvedContext);
    this.shortcuts = sourceList.map(item => ({
      keys: item.keys,
      description: item.descriptionKey,
      category: item.categoryKey,
      combos: parseCombos(item.keys),
    }));

    switch (resolvedContext) {
      case 'nautilus':
        this.title = 'nautilus.shortcuts.title';
        break;
      case 'flow':
        this.title = 'flow.shortcuts.title';
        break;
      case 'main':
      default:
        this.title = 'shortcuts.title';
        break;
    }

    this.destroyRef.onDestroy(() => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', this.handleKeyDown, { capture: true });
      }
      if (this.hitTimeout) {
        clearTimeout(this.hitTimeout);
      }
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.handleKeyDown, { capture: true });
    }
  }

  readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (isInputFocused(event)) {
      return;
    }

    const matched = this.shortcuts.find(s => s.combos.some(combo => matchesCombo(combo, event)));

    if (matched) {
      if (event.key !== 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
      this.pressedShortcutKeys.set(matched.keys);

      setTimeout(() => {
        this.elementRef.nativeElement
          .querySelector('.shortcut-hit')
          ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 0);

      if (this.hitTimeout) {
        clearTimeout(this.hitTimeout);
      }
      this.hitTimeout = setTimeout(() => {
        this.pressedShortcutKeys.set(null);
      }, 850);
    }
  };

  toggleSearch(): void {
    this.searchVisible.update(v => !v);
    if (!this.searchVisible()) {
      this.clearSearch();
    }
  }

  onSearchTextChange(text: string): void {
    this.searchText.set(text);
  }

  clearSearch(): void {
    this.searchText.set('');
    this.searchContainer()?.clear();
  }

  close(): void {
    this.dialogRef.close();
  }
}
