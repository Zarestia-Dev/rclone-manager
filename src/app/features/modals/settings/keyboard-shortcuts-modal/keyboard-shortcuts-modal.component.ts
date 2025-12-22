import { Component, HostListener, ViewChild, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTableModule } from '@angular/material/table';
import { SearchContainerComponent } from '../../../../shared/components/search-container/search-container.component';

@Component({
  selector: 'app-keyboard-shortcuts-modal',
  imports: [
    MatTableModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    FormsModule,
    MatButtonModule,
    SearchContainerComponent,
  ],
  templateUrl: './keyboard-shortcuts-modal.component.html',
  styleUrls: ['./keyboard-shortcuts-modal.component.scss', '../../../../styles/_shared-modal.scss'],
})
export class KeyboardShortcutsModalComponent {
  searchText = '';
  searchVisible = false; // Controls the visibility of search field

  @ViewChild(SearchContainerComponent) searchContainer!: SearchContainerComponent;

  // Static list of shortcuts - much simpler than using a service
  shortcuts = [
    { keys: 'Ctrl + Q', description: 'Quit Application', category: 'Global' },
    { keys: 'Ctrl + ?', description: 'Show Keyboard Shortcuts', category: 'Application' },
    { keys: 'Ctrl + ,', description: 'Open Preferences', category: 'Application' },
    { keys: 'Ctrl + .', description: 'Open RClone Configuration', category: 'Application' },
    {
      keys: 'Ctrl + Shift + M',
      description: 'Force Check Mounted Remotes',
      category: 'Remote Management',
    },
    {
      keys: 'Ctrl + N',
      description: 'Create New Remote (Detailed)',
      category: 'Remote Management',
    },
    { keys: 'Ctrl + R', description: 'Create New Remote (Quick)', category: 'Remote Management' },
    { keys: 'Ctrl + I', description: 'Load Configuration', category: 'File Operations' },
    { keys: 'Ctrl + E', description: 'Export Configuration', category: 'File Operations' },
    { keys: 'Ctrl + B', description: 'Toggle File Browser', category: 'File Browser' },
    { keys: 'Escape', description: 'Close Dialog/Cancel Action', category: 'Navigation' },
  ];

  filteredShortcuts = [...this.shortcuts];

  private dialogRef = inject(MatDialogRef<KeyboardShortcutsModalComponent>);

  @HostListener('document:keydown.escape')
  close(): void {
    this.dialogRef.close();
  }

  @HostListener('document:keydown.control.f')
  onF3(): void {
    this.toggleSearch();
    if (this.searchVisible && this.searchContainer) {
      this.searchContainer.focus();
    }
  }

  toggleSearch(): void {
    this.searchVisible = !this.searchVisible;
    if (!this.searchVisible) {
      this.clearSearch();
    }
  }

  onSearchTextChange(searchText: string): void {
    this.searchText = searchText;
    this.filterShortcuts();
  }

  filterShortcuts(): void {
    const searchTerm = this.searchText.toLowerCase().trim();

    if (!searchTerm) {
      this.filteredShortcuts = [...this.shortcuts];
      return;
    }

    this.filteredShortcuts = this.shortcuts.filter(
      shortcut =>
        shortcut.description.toLowerCase().includes(searchTerm) ||
        shortcut.keys.toLowerCase().includes(searchTerm) ||
        // Also search individual key parts
        shortcut.keys.split('+').some(key => key.trim().toLowerCase().includes(searchTerm))
    );
  }

  clearSearch(): void {
    this.searchText = '';
    this.filteredShortcuts = [...this.shortcuts];
    if (this.searchContainer) {
      this.searchContainer.clear();
    }
  }
}
