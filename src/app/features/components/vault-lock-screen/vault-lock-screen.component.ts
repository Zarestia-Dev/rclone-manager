import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  NgZone,
  signal,
} from '@angular/core';
import { A11yModule } from '@angular/cdk/a11y';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { VaultService } from '../../../services/security/vault.service';

import {
  createVaultWaveCells,
  getVaultPointerPosition,
  VaultWaveCell,
  VAULT_WAVE_DURATION_MS,
} from './vault-hud-effects';

import { WindowControlsComponent } from '../../../shared/components/window-controls/window-controls.component';
import { AppLifecycleService } from '../../../services/infrastructure/system/app-lifecycle.service';
import {
  isHeadlessMode,
  isMobile,
} from '../../../services/infrastructure/platform/api-client.service';

import { BackendTranslationService } from '../../../services/i18n/backend-translation.service';

@Component({
  selector: 'app-vault-lock-screen',
  imports: [
    A11yModule,
    WindowControlsComponent,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    TranslatePipe,
  ],
  templateUrl: './vault-lock-screen.component.html',
  styleUrl: './vault-lock-screen.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VaultLockScreenComponent {
  readonly appLifecycle = inject(AppLifecycleService);
  readonly isDesktop = !isHeadlessMode() && !isMobile();

  private readonly vaultService = inject(VaultService);
  private readonly translate = inject(TranslateService);
  private readonly backendTranslation = inject(BackendTranslationService);
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly zone = inject(NgZone);

  readonly passwordControl = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required],
  });

  readonly lockForm = new FormGroup({
    password: this.passwordControl,
  });

  readonly showPassword = signal(false);
  readonly isSubmitting = this.vaultService.isBusy;
  readonly errorMessage = signal<string | null>(null);

  readonly effectsPaused = signal(false);
  readonly waveDuration = VAULT_WAVE_DURATION_MS;
  readonly waveCells = signal<VaultWaveCell[]>([]);
  readonly waveScale = signal({ x: 0.75, y: 0.75 });
  private readonly destroyRef = inject(DestroyRef);
  private readonly waveSeed = Math.random() * 10000;
  private motionQuery: MediaQueryList | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private waveLayout = '';
  private pointerFrame: number | null = null;
  private pointerPosition: { x: number; y: number } | null = null;

  constructor() {
    afterNextRender(() => {
      const background = this.hostEl.nativeElement.querySelector<HTMLElement>('.hud-background');
      if (!background) return;
      const host = this.hostEl.nativeElement;
      const onPointerMove = (event: PointerEvent): void => this.onPointerMove(event);
      const onPointerLeave = (): void => this.onPointerLeave();
      this.zone.runOutsideAngular(() => {
        host.addEventListener('pointermove', onPointerMove, { passive: true });
        host.addEventListener('pointerleave', onPointerLeave);
        host.addEventListener('pointercancel', onPointerLeave);
      });
      this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      const refresh = (): void => {
        this.onPointerLeave();
        this.updateWaveCells(background);
      };
      const onVisibilityChange = (): void => {
        this.effectsPaused.set(document.hidden);
        if (document.hidden) this.onPointerLeave();
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
      onVisibilityChange();
      this.motionQuery.addEventListener('change', refresh);
      this.resizeObserver = new ResizeObserver(() => this.updateWaveCells(background));
      this.resizeObserver.observe(background);
      refresh();
      this.destroyRef.onDestroy(() => {
        host.removeEventListener('pointermove', onPointerMove);
        host.removeEventListener('pointerleave', onPointerLeave);
        host.removeEventListener('pointercancel', onPointerLeave);
        this.motionQuery?.removeEventListener('change', refresh);
        document.removeEventListener('visibilitychange', onVisibilityChange);
      });
    });
    this.destroyRef.onDestroy(() => {
      this.resizeObserver?.disconnect();
      this.onPointerLeave();
    });
  }

  private updateWaveCells(background: HTMLElement): void {
    if (this.motionQuery?.matches) {
      this.waveLayout = '';
      this.waveCells.set([]);
      return;
    }
    const grid = background.querySelector<HTMLElement>('.hex-grid');
    if (!grid) return;
    const style = getComputedStyle(grid);
    const [tileWidth, tileHeight] = (style.maskSize || style.getPropertyValue('-webkit-mask-size'))
      .trim()
      .split(/\s+/)
      .map(parseFloat);
    if (![tileWidth, tileHeight].every(size => Number.isFinite(size) && size > 0)) {
      this.waveLayout = '';
      this.waveCells.set([]);
      return;
    }
    const layout = `${background.clientWidth}:${background.clientHeight}:${tileWidth}:${tileHeight}`;
    if (layout === this.waveLayout) return;
    this.waveLayout = layout;
    this.waveScale.set({ x: tileWidth / 56, y: tileHeight / 96.99 });
    this.waveCells.set(
      createVaultWaveCells(
        background.clientWidth,
        background.clientHeight,
        tileWidth,
        tileHeight,
        this.waveSeed
      )
    );
  }

  onPointerMove(event: PointerEvent): void {
    if (event.pointerType !== 'mouse' || this.motionQuery?.matches || this.effectsPaused()) return;
    this.pointerPosition = { x: event.clientX, y: event.clientY };
    if (this.pointerFrame !== null) return;
    this.pointerFrame = requestAnimationFrame(() => {
      this.pointerFrame = null;
      if (!this.pointerPosition) return;
      const el = this.hostEl.nativeElement;
      const rect = el.getBoundingClientRect();
      const x = this.pointerPosition.x - rect.left;
      const y = this.pointerPosition.y - rect.top;
      const position = getVaultPointerPosition(x, y, rect.width, rect.height);
      if (!position) return;
      const background = el.querySelector<HTMLElement>('.hud-background');
      if (background) {
        background.style.transform = `rotateX(${-position.y * 2}deg) rotateY(${position.x * 3}deg) translateZ(calc(var(--space-2xl) * -1)) scale(1.12)`;
      }
      const panel = el.querySelector<HTMLElement>('.hud-panel-plane');
      if (panel) {
        panel.style.transform = `rotateX(${-position.y * 4}deg) rotateY(${position.x * 5}deg) translate3d(calc(${position.x} * var(--space-xs)), calc(${position.y} * var(--space-xxs)), 0)`;
      }
    });
  }

  onPointerLeave(): void {
    if (this.pointerFrame !== null) cancelAnimationFrame(this.pointerFrame);
    this.pointerFrame = null;
    this.pointerPosition = null;
    const el = this.hostEl.nativeElement;
    el.querySelector<HTMLElement>('.hud-panel-plane')?.style.removeProperty('transform');
    el.querySelector<HTMLElement>('.hud-background')?.style.removeProperty('transform');
  }

  async confirmExit(): Promise<void> {
    if (!this.isDesktop) return;
    this.errorMessage.set(null);
    try {
      await this.appLifecycle.confirmLockedExit();
    } catch (error) {
      this.errorMessage.set(this.backendTranslation.translateBackendMessage(error));
    }
  }

  togglePasswordVisibility(): void {
    this.showPassword.update(show => !show);
  }

  async submitUnlock(event?: Event): Promise<void> {
    event?.preventDefault();

    if (this.appLifecycle.lockedExitRequested() || this.appLifecycle.isQuitting()) return;

    if (this.passwordControl.invalid || this.isSubmitting()) {
      this.passwordControl.markAsTouched();
      return;
    }

    this.errorMessage.set(null);
    try {
      await this.vaultService.unlockVault(this.passwordControl.value);
    } catch (err) {
      const translated = this.backendTranslation.translateBackendMessage(err);
      this.errorMessage.set(translated || this.translate.instant('vault.errors.unlockFailed'));
    }
  }
}
