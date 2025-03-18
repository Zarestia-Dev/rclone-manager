import { Directive, HostListener } from '@angular/core';

@Directive({
  selector: '[appRightClick]',
  standalone: true,
})
export class RightClickDirective {
  @HostListener('contextmenu', ['$event'])
  onRightClick(event: MouseEvent) {
    event.preventDefault(); // Disable default browser right-click menu

    const menu = document.getElementById('custom-menu');
    if (menu) {
      menu.style.display = 'block';
      menu.style.left = `${event.pageX}px`;
      menu.style.top = `${event.pageY}px`;
    }
  }
}
