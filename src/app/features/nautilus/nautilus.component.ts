import { Component, EventEmitter, inject, Output, OnInit, OnDestroy } from '@angular/core';
import { BehaviorSubject, combineLatest, Subject } from 'rxjs';
import { take } from 'rxjs/operators';
import { map } from 'rxjs/operators';
import { CommonModule } from '@angular/common';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatButtonModule } from '@angular/material/button';
import { MatGridListModule } from '@angular/material/grid-list';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { AnimationsService } from '../../shared/services/animations.service';
import { UiStateService, WindowService, RemoteManagementService } from '@app/services';
import { Remote } from '@app/types';
import { IconService } from '../../shared/services/icon.service';

@Component({
  selector: 'app-nautilus',
  standalone: true,
  imports: [
    CommonModule,
    MatListModule,
    MatIconModule,
    MatToolbarModule,
    MatSidenavModule,
    MatButtonModule,
    MatGridListModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatMenuModule,
  ],
  templateUrl: './nautilus.component.html',
  styleUrl: './nautilus.component.scss',
  animations: [AnimationsService.slideOverlay()],
})
export class NautilusComponent implements OnInit, OnDestroy {
  uiStateService = inject(UiStateService);
  windowService = inject(WindowService);
  private remoteManagement = inject(RemoteManagementService);
  public remotes$ = this.remoteManagement.remotes$;
  private remoteConfigs$ = new BehaviorSubject<Record<string, unknown>>({});
  public remotesWithMeta$ = combineLatest([this.remotes$, this.remoteConfigs$]).pipe(
    map(([names, configs]) =>
      (names || []).map((name: string) => ({
        name,
        type: ((): string | undefined => {
          const cfg = configs?.[name] as Record<string, unknown> | undefined;
          return (
            (cfg && (cfg['type'] as string | undefined)) ||
            (cfg && (cfg['Type'] as string | undefined)) ||
            undefined
          );
        })(),
      }))
    )
  );
  readonly iconService = inject(IconService);
  readonly selectedRemote$ = this.uiStateService.selectedRemote$;
  private destroy$ = new Subject<void>();
  windowButtons = true;

  @Output() closeOverlay = new EventEmitter<void>();
  constructor() {
    if (this.uiStateService.platform === 'macos' || this.uiStateService.platform === 'web') {
      this.windowButtons = false;
    }
  }
  onClose(): void {
    this.closeOverlay.emit();
  }

  // A back button for standalone web mode
  goBack(): void {
    this.closeOverlay.emit();
  }

  async minimizeWindow(): Promise<void> {
    await this.windowService.minimize();
  }

  async maximizeWindow(): Promise<void> {
    await this.windowService.maximize();
  }

  async closeWindow(): Promise<void> {
    await this.windowService.close();
  }

  // TrackBy helpers
  trackByIndex(index: number): number {
    return index;
  }

  trackByRemote(_: number, item: { name: string; type?: string }): string {
    return item?.name || String(_);
  }

  selectRemote(remote: { name: string; type?: string }): void {
    const selected: Remote = {
      remoteSpecs: { name: remote.name, type: remote.type || '' },
    } as Remote;
    this.uiStateService.setSelectedRemote(selected);
  }

  async ngOnInit(): Promise<void> {
    // Load remotes on component init. This will call into the Tauri backend
    // — if this is running in tests, a mock service should be provided to
    // avoid invoking native commands.
    try {
      await this.remoteManagement.getRemotes();
      // Try to load remote configuration metadata (type, etc) so we can show icons
      try {
        const configs = await this.remoteManagement.getAllRemoteConfigs();
        this.remoteConfigs$.next(configs || {});
      } catch (err) {
        // Keep going without remote type metadata
        console.warn('Failed to load remote configs for Nautilus icons', err);
      }

      // Ensure a default selected remote if the UI has none and there are remotes available
      this.remotesWithMeta$.pipe(take(1)).subscribe(remotes => {
        // If a selection hasn't been made in the UI, default to first remote
        this.uiStateService.selectedRemote$.pipe(take(1)).subscribe(currentSelected => {
          if (!currentSelected && remotes && remotes.length > 0) {
            const first = remotes[0];
            // Create minimal Remote object (other fields are optional)
            const minimal: Remote = {
              remoteSpecs: { name: first.name, type: first.type || '' },
            } as Remote;
            try {
              this.uiStateService.setSelectedRemote(minimal);
            } catch (err) {
              // If setting selection causes issues, we silently fail as Nautilus should not crash
              console.warn('Failed to set selected remote from Nautilus', err);
            }
          }
        });
      });
    } catch (error) {
      // On failure, there is nothing we can do in the UI here. Logging kept
      // to a minimum; the service will already log any CLI errors.
      // Keep component resilient to service failures.
      console.warn('Failed to fetch remotes', error);
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
