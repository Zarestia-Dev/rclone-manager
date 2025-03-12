import { CommonModule } from '@angular/common';
import { Component, HostListener } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { MatTableModule } from '@angular/material/table';

@Component({
  selector: 'app-keyboard-shortcuts-modal',
  standalone: true,
  imports: [CommonModule, MatTableModule],
  templateUrl: './keyboard-shortcuts-modal.component.html',
  styleUrl: './keyboard-shortcuts-modal.component.scss'
})
export class KeyboardShortcutsModalComponent {
  shortcuts = [
    { keys: 'Ctrl + N', description: 'New Remote' },
    { keys: 'Ctrl + M', description: 'Manage Mounts' },
    { keys: 'Ctrl + P', description: 'Preferences' },
    { keys: 'Esc', description: 'Close Modal' },
    { keys: 'Ctrl + S', description: 'Save Config' },
    { keys: 'Ctrl + Q', description: 'Quit Application' },
    { keys: 'Ctrl + R', description: 'Refresh' },
    { keys: 'Ctrl + T', description: 'Open Terminal' }
  ];
  

  constructor(private dialogRef: MatDialogRef<KeyboardShortcutsModalComponent>) {}

  @HostListener('document:keydown.escape', ['$event'])
  onEscKeyPress(event: KeyboardEvent) {
    this.dialogRef.close();
  }

  close() {
    this.dialogRef.close();
  }
}
