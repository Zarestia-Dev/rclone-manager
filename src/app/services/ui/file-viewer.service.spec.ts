import { TestBed } from '@angular/core/testing';
import { Overlay } from '@angular/cdk/overlay';
import { EventEmitter } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Entry } from '@app/types';
import { FileViewerService } from './file-viewer.service';
import { VaultService } from '../security/vault.service';
import { PathService } from '../infrastructure/platform/path.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { BackendTranslationService } from '../i18n/backend-translation.service';
import { NotificationService } from './notification.service';
import { NavigationHistoryService } from './navigation-history.service';

const item = (path: string): Entry => ({
  ID: '',
  Name: path.split('/').pop() ?? '',
  Path: path,
  Size: 100,
  IsDir: false,
  MimeType: '',
  ModTime: '',
});

describe('FileViewerService media URLs', () => {
  const openLayer = vi.fn();
  const releaseHistory = vi.fn();
  const convertFileSrc = vi.fn();
  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });
  beforeEach(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: undefined, configurable: true });
    convertFileSrc.mockReset();
    openLayer.mockReset().mockReturnValue(releaseHistory);
    releaseHistory.mockReset();
    TestBed.configureTestingModule({
      providers: [
        FileViewerService,
        { provide: NavigationHistoryService, useValue: { openLayer } },
        { provide: Overlay, useValue: {} },
        { provide: VaultService, useValue: { isAccessible: (): boolean => true } },
        { provide: ApiClientService, useValue: { getApiBase: (): string => '/api' } },
        { provide: NotificationService, useValue: {} },
        { provide: TranslateService, useValue: {} },
        { provide: BackendTranslationService, useValue: {} },
        {
          provide: PathService,
          useValue: {
            joinPath: (base: string, path: string): string => `${base.replace(/\/$/, '')}/${path}`,
            normalizeRemoteName: (remote: string): string => remote.replace(/:$/, ''),
          },
        },
      ],
    });
  });

  interface ViewerSetup {
    service: FileViewerService;
    overlayRef: {
      attach: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
      backdropClick: () => Observable<MouseEvent>;
    };
    closeViewer: EventEmitter<void>;
    backdrop: Subject<MouseEvent>;
  }

  function setupViewer(): ViewerSetup {
    const closeViewer = new EventEmitter<void>();
    const backdrop = new Subject<MouseEvent>();
    const overlayRef = {
      attach: vi.fn().mockReturnValue({ instance: { closeViewer } }),
      dispose: vi.fn(),
      backdropClick: (): Observable<MouseEvent> => backdrop.asObservable(),
    };
    interface PositionStrategyMock {
      global: () => PositionStrategyMock;
      centerHorizontally: () => PositionStrategyMock;
      centerVertically: () => PositionStrategyMock;
    }
    const position: PositionStrategyMock = {
      global: (): PositionStrategyMock => position,
      centerHorizontally: (): PositionStrategyMock => position,
      centerVertically: (): PositionStrategyMock => position,
    };
    Object.assign(TestBed.inject(Overlay), {
      create: () => overlayRef,
      scrollStrategies: { block: vi.fn() },
      position: () => position,
    });
    return { service: TestBed.inject(FileViewerService), overlayRef, closeViewer, backdrop };
  }

  it('closes the viewer through the navigation layer used by Android Back', async () => {
    const { service, overlayRef } = setupViewer();
    await service.openDirectUrl('https://example.com/video.mp4');
    expect(openLayer).toHaveBeenCalledTimes(1);
    expect(overlayRef.attach).toHaveBeenCalledOnce();
    openLayer.mock.calls[0][0]();
    expect(overlayRef.dispose).toHaveBeenCalledTimes(1);
    expect(releaseHistory).toHaveBeenCalledTimes(1);
  });

  it('does not replace a newer viewer when an earlier URL resolves late', async () => {
    const { service, overlayRef } = setupViewer();
    let resolveOld!: (url: string) => void;
    vi.spyOn(service, 'generateUrl').mockReturnValueOnce(
      new Promise(resolve => {
        resolveOld = resolve;
      })
    );
    const first = service.open([item('old.mp3')], 0, 'drive:', false);
    await service.openDirectUrl('https://example.com/new.mp4');
    resolveOld('http://localhost/old.mp3');
    await first;
    expect(overlayRef.attach).toHaveBeenCalledTimes(1);
    expect(openLayer).toHaveBeenCalledTimes(1);
  });

  it('ignores late close events from a replaced viewer', async () => {
    const { service, overlayRef, closeViewer, backdrop } = setupViewer();
    await service.openDirectUrl('https://example.com/first.mp4');
    const replacement = {
      ...overlayRef,
      dispose: vi.fn(),
      attach: vi.fn().mockReturnValue({ instance: { closeViewer: new EventEmitter<void>() } }),
      backdropClick: (): Observable<MouseEvent> => new Subject<MouseEvent>(),
    };
    Object.assign(TestBed.inject(Overlay), { create: () => replacement });
    await service.openDirectUrl('https://example.com/second.mp4');
    closeViewer.emit();
    backdrop.next(new MouseEvent('click'));
    expect(replacement.attach).toHaveBeenCalledOnce();
    expect(replacement.dispose).not.toHaveBeenCalled();
    expect(releaseHistory).toHaveBeenCalledTimes(1);
  });

  it('ignores an empty or invalid viewer selection', async () => {
    const { service, overlayRef } = setupViewer();
    await service.open([], 0, 'drive:', false);
    await service.open([item('file.mp3')], -1, 'drive:', false);
    expect(overlayRef.attach).not.toHaveBeenCalled();
    expect(openLayer).not.toHaveBeenCalled();
  });

  it('releases history when the viewer closes through its own control', async () => {
    const { service, closeViewer, overlayRef } = setupViewer();
    await service.openDirectUrl('https://example.com/video.mp4');
    closeViewer.emit();
    expect(overlayRef.dispose).toHaveBeenCalledOnce();
    expect(releaseHistory).toHaveBeenCalledTimes(1);
  });

  it('does not attach a late viewer component after Back closes its loading overlay', async () => {
    const { service, overlayRef } = setupViewer();
    const opening = service.openDirectUrl('https://example.com/video.mp4');
    openLayer.mock.calls[0][0]();
    await opening;
    expect(overlayRef.attach).not.toHaveBeenCalled();
    expect(releaseHistory).toHaveBeenCalledTimes(1);
  });

  it('round trips special characters through HTTP query parameters exactly once', async () => {
    const service = TestBed.inject(FileViewerService);
    const path = 'müzik/a #?&+%20.mp3';
    const url = new URL(await service.generateUrl(item(path), 'remote%20:', false), 'http://host');
    expect(url.searchParams.get('path')).toBe(path);
    expect(url.searchParams.get('remote')).toBe('remote%20:');
    expect(convertFileSrc).not.toHaveBeenCalled();
    const local = new URL(await service.generateUrl(item(path), '/home/user', true), 'http://host');
    expect(local.searchParams.get('path')).toBe(`/home/user/${path}`);
  });

  it.each(['http', 'https', 'custom'])(
    'uses Tauri registered %s origin for every native resource',
    async mode => {
      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        value: { convertFileSrc },
        configurable: true,
      });
      convertFileSrc.mockImplementation((path, scheme = 'asset') =>
        mode === 'custom'
          ? `${scheme}://localhost/${path}`
          : `${mode}://${scheme}.localhost/${path}`
      );
      const service = TestBed.inject(FileViewerService);
      const file = item('müzik/a #?&+%20.mp3');
      const remote = new URL(await service.generateUrl(file, 'drive:', false));
      expect(decodeURIComponent(remote.pathname)).toBe(`/drive/${file.Path}`);
      expect(remote.protocol).toBe(mode === 'custom' ? 'rclone:' : `${mode}:`);
      const local = new URL(await service.generateUrl(file, '/home/user', true));
      expect(decodeURIComponent(local.pathname)).toBe(`/home/user/${file.Path}`);
      const coverUrl = await service.getAudioCover(file, 'drive:', false);
      expect(coverUrl).not.toBeNull();
      const cover = new URL(coverUrl ?? '');
      expect(decodeURIComponent(cover.pathname)).toBe(`/remote/drive:/${file.Path}`);
      expect(cover.protocol).toBe(mode === 'custom' ? 'audio-cover:' : `${mode}:`);
    }
  );
});
