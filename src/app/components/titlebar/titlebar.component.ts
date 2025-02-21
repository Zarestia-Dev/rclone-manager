import { Component } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { getCurrentWindow } from '@tauri-apps/api/window';

const appWindow = getCurrentWindow();

@Component({
  selector: 'app-titlebar',
  standalone: true,
  imports: [MatIconModule, MatMenuModule],
  templateUrl: './titlebar.component.html',
  styleUrl: './titlebar.component.css'
})

export class TitlebarComponent {

  closeWindow() {
    appWindow.close();
  }

  minimizeWindow() {
    appWindow.minimize();
  }

  maximizeWindow() {
    appWindow.maximize();
  }

  unmaximizeWindow() {
    appWindow.unmaximize();
  }

}
