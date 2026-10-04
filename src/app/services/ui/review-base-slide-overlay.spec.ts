import { Component, Injectable, Type, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Overlay } from '@angular/cdk/overlay';
import { NEVER } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslateService } from '@ngx-translate/core';
import { VaultService } from '../security/vault.service';
import { BaseSlideOverlayService } from './base-slide-overlay.service';
import { NotificationService } from './notification.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { SseClientService } from '../infrastructure/platform/sse-client.service';
import { BackendTranslationService } from '../i18n/backend-translation.service';

@Component({ template: '' })
class OverlayContent {}

@Injectable()
class TestOverlayService extends BaseSlideOverlayService<OverlayContent> {
  load = vi.fn<() => Promise<Type<OverlayContent>>>();
  protected loadComponent(): Promise<Type<OverlayContent>> {
    return this.load();
  }
  protected getStandaloneConfig(): {
    url: string;
    label: string;
    title: string;
  } {
    return { url: '/', label: 'test', title: 'Test' };
  }
  protected detectStandaloneWindow(): boolean {
    return false;
  }
}

describe('BaseSlideOverlayService', () => {
  let service: TestOverlayService;
  const overlayRef = {
    attach: vi.fn(() => ({ location: { nativeElement: document.createElement('div') } })),
    dispose: vi.fn(),
    backdropClick: vi.fn(() => NEVER),
  };

  const create = vi.fn(() => overlayRef);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    create.mockReset().mockReturnValue(overlayRef);
    const position = { top: vi.fn(), left: vi.fn(), bottom: vi.fn() };
    position.top.mockReturnValue(position);
    position.left.mockReturnValue(position);
    position.bottom.mockReturnValue(position);
    TestBed.configureTestingModule({
      providers: [
        TestOverlayService,
        { provide: VaultService, useValue: { isAccessible: signal(true) } },
        {
          provide: Overlay,
          useValue: {
            create,
            position: vi.fn(() => ({ global: vi.fn(() => position) })),
            scrollStrategies: { block: vi.fn() },
          },
        },
        ...[
          ApiClientService,
          SseClientService,
          NotificationService,
          TranslateService,
          BackendTranslationService,
        ].map(provide => ({ provide, useValue: {} })),
      ],
    });
    service = TestBed.inject(TestOverlayService);
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('does not attach or register history after closing during lazy loading', async () => {
    let resolve!: (component: Type<OverlayContent>) => void;
    service.load.mockReturnValue(
      new Promise(done => {
        resolve = done;
      })
    );
    const opening = service.openOverlay();
    service.closeOverlay();
    resolve(OverlayContent);
    await opening;
    vi.runAllTimers();
    expect(service.isOpen()).toBe(false);
    expect(overlayRef.attach).not.toHaveBeenCalled();
    expect(overlayRef.dispose).toHaveBeenCalledOnce();
  });

  it('cleans up a failed import and allows another attempt', async () => {
    service.load.mockRejectedValueOnce(new Error('load failed')).mockResolvedValue(OverlayContent);
    await expect(service.openOverlay()).rejects.toThrow('load failed');
    expect(service.isOpen()).toBe(false);
    await service.openOverlay();
    expect(service.isOpen()).toBe(true);
    expect(overlayRef.attach).toHaveBeenCalledOnce();
    service.closeOverlay();
  });

  it('ignores a duplicate open while loading', async () => {
    service.load.mockResolvedValue(OverlayContent);
    await Promise.all([service.openOverlay(), service.openOverlay()]);
    expect(service.load).toHaveBeenCalledOnce();
    service.closeOverlay();
  });
  it('reopens an overlay closed while its lazy import is pending', async () => {
    let resolve!: (component: Type<OverlayContent>) => void;
    service.load.mockReturnValue(
      new Promise(done => {
        resolve = done;
      })
    );
    const reopened = {
      ...overlayRef,
      attach: vi.fn(() => ({ location: { nativeElement: document.createElement('div') } })),
      dispose: vi.fn(),
    };
    create.mockReturnValueOnce(overlayRef).mockReturnValueOnce(reopened);
    const first = service.openOverlay();
    service.closeOverlay();
    const second = service.openOverlay();
    resolve(OverlayContent);
    await Promise.all([first, second]);
    vi.runAllTimers();
    expect(service.isOpen()).toBe(true);
    expect(overlayRef.attach).not.toHaveBeenCalled();
    expect(overlayRef.dispose).toHaveBeenCalledOnce();
    expect(reopened.attach).toHaveBeenCalledOnce();
    expect(reopened.dispose).not.toHaveBeenCalled();
    service.closeOverlay();
  });

  it('does not close a reopened overlay when the cancelled import fails', async () => {
    let reject!: (error: Error) => void;
    service.load
      .mockReturnValueOnce(
        new Promise((_, fail) => {
          reject = fail;
        })
      )
      .mockResolvedValue(OverlayContent);
    const reopened = {
      ...overlayRef,
      attach: vi.fn(() => ({ location: { nativeElement: document.createElement('div') } })),
      dispose: vi.fn(),
    };
    create.mockReturnValueOnce(overlayRef).mockReturnValueOnce(reopened);
    const first = service.openOverlay();
    const failed = expect(first).rejects.toThrow('cancelled import failed');
    service.closeOverlay();
    await service.openOverlay();
    reject(new Error('cancelled import failed'));
    await failed;
    vi.runAllTimers();
    expect(service.isOpen()).toBe(true);
    expect(reopened.attach).toHaveBeenCalledOnce();
    expect(reopened.dispose).not.toHaveBeenCalled();
    service.closeOverlay();
  });
});
