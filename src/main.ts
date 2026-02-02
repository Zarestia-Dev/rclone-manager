import { provideZoneChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

// Custom context menu implementation
let contextMenu: HTMLElement | null = null;

function createContextMenu(x: number, y: number): void {
  // Remove existing menu if any
  if (contextMenu) {
    contextMenu.remove();
  }

  // Create menu container with Material styling
  contextMenu = document.createElement('div');
  contextMenu.className = 'material-context-menu';
  contextMenu.style.cssText = `
    position: fixed;
    left: ${x}px;
    top: ${y}px;
    z-index: 99999;
  `;

  // Menu items
  const menuItems = [
    { label: 'Refresh UI', action: refreshUI },
    { label: 'Clear Cache', action: clearCache },
  ];

  menuItems.forEach(item => {
    const menuItem = document.createElement('button');
    menuItem.className = 'menu-item';
    menuItem.innerHTML = `<span>${item.label}</span>`;

    menuItem.addEventListener('click', () => {
      item.action();
      contextMenu?.remove();
      contextMenu = null;
    });

    contextMenu!.appendChild(menuItem);
  });

  document.body.appendChild(contextMenu);

  // Adjust position if menu goes off-screen
  const rect = contextMenu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    contextMenu.style.left = `${x - rect.width}px`;
  }
  if (rect.bottom > window.innerHeight) {
    contextMenu.style.top = `${y - rect.height}px`;
  }
}

function refreshUI(): void {
  sessionStorage.clear();
  window.location.reload();
}

function clearCache(): void {
  const feedback = document.createElement('div');
  feedback.textContent = 'Cache Cleared';
  feedback.style.cssText = `
    position: fixed;
    bottom: var(--space-md);
    right: var(--space-md);
    background: var(--primary-color);
    color: white;
    padding: 16px 32px;
    border-radius: var(--radius-md);
    font-size: var(--font-size-md);
    font-weight: 600;
    z-index: 99999;
    box-shadow: var(--box-shadow);
    animation: fadeIn 0.2s ease-out;
    pointer-events: none;
  `;
  document.body.appendChild(feedback);

  sessionStorage.clear();
  localStorage.clear();

  setTimeout(() => {
    feedback.style.animation = 'fadeOut 0.2s ease-out forwards';
    setTimeout(() => {
      feedback.remove();
    }, 300);
  }, 1500);
}

// Handle right-click
document.addEventListener('contextmenu', event => {
  event.preventDefault();
  createContextMenu(event.clientX, event.clientY);
});

// Close menu on click outside
document.addEventListener('click', () => {
  if (contextMenu) {
    contextMenu.remove();
    contextMenu = null;
  }
});

// Close menu on escape
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && contextMenu) {
    contextMenu.remove();
    contextMenu = null;
  }
});

bootstrapApplication(AppComponent, {
  ...appConfig,
  providers: [provideZoneChangeDetection(), ...appConfig.providers],
}).catch(err => console.error(err));
