import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';

@Component({
  selector: 'app-workspace-shell',
  templateUrl: './workspace-shell.component.html',
  styleUrl: './workspace-shell.component.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'workspace-shell' },
})
export class WorkspaceShellComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly navigation = viewChild.required<ElementRef<HTMLElement>>('navigation');

  constructor() {
    afterNextRender(() => {
      const navigation = this.navigation().nativeElement;
      const updateClearance = (): void => {
        this.host.nativeElement.style.setProperty(
          '--workspace-navigation-clearance',
          `${navigation.getBoundingClientRect().height}px`
        );
      };
      const observer = new ResizeObserver(updateClearance);
      observer.observe(navigation);
      updateClearance();
      this.destroyRef.onDestroy(() => observer.disconnect());
    });
  }
}
