import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient, HttpErrorResponse } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';
import { Entry } from '@app/types';

import { FileViewerModalComponent } from './file-viewer-modal.component';
import { FileViewerService } from 'src/app/services/ui/file-viewer.service';
import { DownloadService } from 'src/app/services/operations/download.service';
import { OpenerService } from 'src/app/services/infrastructure/platform/opener.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { NautilusService } from 'src/app/services/ui/nautilus.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { JobManagementService } from 'src/app/services/operations/job-management.service';
import { BinaryInspectorService } from 'src/app/services/ui/binary-inspector.service';

interface ComponentPrivateAccess {
  updateData: () => Promise<void>;
}

describe('FileViewerModalComponent', () => {
  let fixture: ComponentFixture<FileViewerModalComponent>;
  let component: FileViewerModalComponent;

  let fileViewerServiceMock: Partial<FileViewerService>;
  let downloadServiceMock: Partial<DownloadService>;
  let openerServiceMock: Partial<OpenerService>;
  let backendServiceMock: Partial<BackendService>;
  let iconServiceMock: Partial<IconService>;
  let remoteOpsMock: Partial<RemoteFileOperationsService>;
  let nautilusServiceMock: Partial<NautilusService>;
  let notificationServiceMock: Partial<NotificationService>;
  let pathServiceMock: Partial<PathService>;
  let jobManagementServiceMock: Partial<JobManagementService>;

  const mockItems: Entry[] = [
    {
      ID: '1',
      Name: 'document.txt',
      Path: 'docs/document.txt',
      IsDir: false,
      Size: 1024,
      ModTime: '2026-09-01T12:00:00Z',
      MimeType: 'text/plain',
    },
    {
      ID: '2',
      Name: 'photo.jpg',
      Path: 'photos/photo.jpg',
      IsDir: false,
      Size: 2048576,
      ModTime: '2026-09-02T15:30:00Z',
      MimeType: 'image/jpeg',
    },
    {
      ID: '3',
      Name: 'notes.md',
      Path: 'docs/notes.md',
      IsDir: false,
      Size: 512,
      ModTime: '2026-09-03T09:15:00Z',
      MimeType: 'text/markdown',
    },
  ];

  beforeEach(async () => {
    fileViewerServiceMock = {
      setActiveFileName: vi.fn(),
      resolveRelativePath: vi.fn().mockResolvedValue('http://localhost/resolved-path'),
      getAudioCover: vi.fn().mockResolvedValue(null),
    };

    downloadServiceMock = {
      download: vi.fn(),
    };

    openerServiceMock = {
      openUrl: vi.fn().mockResolvedValue(undefined),
    };

    backendServiceMock = {
      activeBackend: signal('Local'),
    };

    iconServiceMock = {
      getFileTypeCategory: vi.fn().mockImplementation((item: Entry) => {
        if (item.Name.endsWith('.jpg') || item.Name.endsWith('.svg')) return 'image';
        if (item.Name.endsWith('.md')) return 'text';
        return 'text';
      }),
      getIconForEntry: vi.fn().mockReturnValue('text-x-generic'),
    };

    remoteOpsMock = {
      getSize: vi.fn().mockResolvedValue({ count: 1, bytes: 1024 }),
      archiveList: vi.fn().mockResolvedValue({ success: true, items: [] }),
    };

    nautilusServiceMock = {
      newNautilusWindow: vi.fn(),
    };

    notificationServiceMock = {
      showError: vi.fn(),
      showSuccess: vi.fn(),
    };

    pathServiceMock = {
      normalizeRemoteForRclone: vi.fn().mockImplementation((r: string) => r),
      joinPath: vi.fn().mockImplementation((...parts: string[]) => parts.join('/')),
    };

    jobManagementServiceMock = {
      stopJobsByGroup: vi.fn().mockResolvedValue(undefined),
    };

    await TestBed.configureTestingModule({
      imports: [FileViewerModalComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: FileViewerService, useValue: fileViewerServiceMock },
        { provide: DownloadService, useValue: downloadServiceMock },
        { provide: OpenerService, useValue: openerServiceMock },
        { provide: BackendService, useValue: backendServiceMock },
        { provide: IconService, useValue: iconServiceMock },
        { provide: RemoteFileOperationsService, useValue: remoteOpsMock },
        { provide: NautilusService, useValue: nautilusServiceMock },
        { provide: NotificationService, useValue: notificationServiceMock },
        { provide: PathService, useValue: pathServiceMock },
        { provide: JobManagementService, useValue: jobManagementServiceMock },
        BinaryInspectorService,
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(FileViewerModalComponent);
    component = fixture.componentInstance;
    component.data = {
      items: [...mockItems],
      currentIndex: 0,
      url: 'http://localhost/view/document.txt',
      isLocal: true,
      remoteName: 'local',
    };
  });

  afterEach(() => {
    fixture.destroy();
  });

  describe('Component Initialization & Computed Properties', () => {
    it('should create and compute currentItem, fileName, and fileSize', () => {
      expect(component).toBeTruthy();
      expect(component.currentItem()).toEqual(mockItems[0]);
      expect(component.fileName()).toBe('document.txt');
      expect(component.fileSize()).toBe(1024);
    });

    it('should return null currentItem when items is empty', () => {
      component.data = {
        items: [],
        currentIndex: 0,
        url: '',
        isLocal: true,
        remoteName: 'local',
      };
      expect(component.currentItem()).toBeNull();
      expect(component.fileName()).toBe('');
      expect(component.fileSize()).toBeNull();
    });

    it('should correctly determine markdown files', () => {
      expect(component.isMarkdownFile()).toBe(false); // document.txt

      component.currentIndex.set(2); // notes.md
      expect(component.isMarkdownFile()).toBe(true);
    });
  });

  describe('Navigation', () => {
    it('should navigate forward with next()', async () => {
      expect(component.currentIndex()).toBe(0);
      const priv = component as unknown as ComponentPrivateAccess;
      const updateDataSpy = vi.spyOn(priv, 'updateData').mockResolvedValue(undefined);

      await component.next();
      expect(component.currentIndex()).toBe(1);
      expect(component.currentItem()).toEqual(mockItems[1]);
      expect(updateDataSpy).toHaveBeenCalled();
    });

    it('should not navigate past the last item with next()', async () => {
      component.currentIndex.set(2); // last item
      const priv = component as unknown as ComponentPrivateAccess;
      const updateDataSpy = vi.spyOn(priv, 'updateData').mockResolvedValue(undefined);

      await component.next();
      expect(component.currentIndex()).toBe(2);
      expect(updateDataSpy).not.toHaveBeenCalled();
    });

    it('should navigate backward with back()', async () => {
      component.currentIndex.set(1);
      const priv = component as unknown as ComponentPrivateAccess;
      const updateDataSpy = vi.spyOn(priv, 'updateData').mockResolvedValue(undefined);

      await component.back();
      expect(component.currentIndex()).toBe(0);
      expect(component.currentItem()).toEqual(mockItems[0]);
      expect(updateDataSpy).toHaveBeenCalled();
    });

    it('should not navigate before the first item with back()', async () => {
      component.currentIndex.set(0);
      const priv = component as unknown as ComponentPrivateAccess;
      const updateDataSpy = vi.spyOn(priv, 'updateData').mockResolvedValue(undefined);

      await component.back();
      expect(component.currentIndex()).toBe(0);
      expect(updateDataSpy).not.toHaveBeenCalled();
    });
  });

  describe('Zoom and Pan Controls', () => {
    it('should zoom in up to a maximum of 5x', () => {
      expect(component.zoomLevel()).toBe(1);
      component.zoomIn();
      expect(component.zoomLevel()).toBe(1.25);
      expect(component.zoomPercentage()).toBe('125%');

      // Attempt to zoom beyond 5
      component.zoomLevel.set(4.9);
      component.zoomIn();
      expect(component.zoomLevel()).toBe(5);
      component.zoomIn();
      expect(component.zoomLevel()).toBe(5);
    });

    it('should zoom out down to a minimum of 0.25x and reset pan when <= 1', () => {
      component.zoomLevel.set(1.25);
      component.panX.set(20);
      component.panY.set(30);

      component.zoomOut();
      expect(component.zoomLevel()).toBe(1);
      expect(component.panX()).toBe(0);
      expect(component.panY()).toBe(0);

      // Attempt to zoom out below 0.25
      component.zoomLevel.set(0.3);
      component.zoomOut();
      expect(component.zoomLevel()).toBe(0.25);
      component.zoomOut();
      expect(component.zoomLevel()).toBe(0.25);
    });

    it('should reset zoom and pan with resetZoom()', () => {
      component.zoomLevel.set(3);
      component.panX.set(50);
      component.panY.set(-20);
      component.isDragging.set(true);

      component.resetZoom();
      expect(component.zoomLevel()).toBe(1);
      expect(component.panX()).toBe(0);
      expect(component.panY()).toBe(0);
      expect(component.isDragging()).toBe(false);
      expect(component.zoomPercentage()).toBe('100%');
    });
  });

  describe('Editing Lifecycle', () => {
    it('should start and cancel editing', () => {
      component.textContent.set('Original content');
      expect(component.isEditing()).toBe(false);

      component.startEditing();
      expect(component.isEditing()).toBe(true);
      expect(component.editContent()).toBe('Original content');
      expect(component.showMarkdownPreview()).toBe(false);

      component.cancelEditing();
      expect(component.isEditing()).toBe(false);
      expect(component.editContent()).toBe('');
    });
  });

  describe('Download Action', () => {
    it('should open direct URL with OpenerService when isDirectUrl is true', async () => {
      component.data.isDirectUrl = true;
      component.data.url = 'https://example.com/download/file.zip';

      await component.download();
      expect(openerServiceMock.openUrl).toHaveBeenCalledWith(
        'https://example.com/download/file.zip'
      );
      expect(downloadServiceMock.download).not.toHaveBeenCalled();
    });

    it('should delegate to downloadService when not a direct url', async () => {
      component.data.isDirectUrl = false;

      await component.download();
      expect(downloadServiceMock.download).toHaveBeenCalledWith(
        'local',
        mockItems[0].Path,
        mockItems[0].Name,
        true,
        mockItems[0].Size
      );
      expect(component.isDownloading()).toBe(false);
    });
  });

  describe('Binary and Content Inspection State', () => {
    it('should initialize binary state signals as empty', () => {
      expect(component.detectedSignature()).toBeNull();
      expect(component.hexDumpRows()).toEqual([]);
    });

    it('should store detected signature and hex dump rows when viewing binary', () => {
      component.detectedSignature.set({
        format: 'sqlite',
        label: 'SQLite 3 Database',
        mimeType: 'application/vnd.sqlite3',
      });
      component.hexDumpRows.set([
        { offset: '00000000', hex: '53 51 4C 69 74 65 20 66', ascii: 'SQLite f' },
      ]);
      expect(component.detectedSignature()?.format).toBe('sqlite');
      expect(component.hexDumpRows().length).toBe(1);
    });
  });

  describe('Error Message Extraction', () => {
    it('should decode ArrayBuffer error responses with textual content', () => {
      const priv = component as unknown as { extractErrorMessage: (err: unknown) => string };
      const encoder = new TextEncoder();
      const buffer = encoder.encode('Permission denied: /etc/libaudit.conf').buffer;
      const httpError = new HttpErrorResponse({
        error: buffer,
        status: 403,
        statusText: 'Forbidden',
      });
      expect(priv.extractErrorMessage(httpError)).toBe('Permission denied: /etc/libaudit.conf');
    });

    it('should fall back to status and statusText if ArrayBuffer contains HTML or is empty', () => {
      const priv = component as unknown as { extractErrorMessage: (err: unknown) => string };
      const encoder = new TextEncoder();
      const buffer = encoder.encode('<html><body>403 Forbidden</body></html>').buffer;
      const httpError = new HttpErrorResponse({
        error: buffer,
        status: 403,
        statusText: 'Forbidden',
      });
      expect(priv.extractErrorMessage(httpError)).toBe('403 Forbidden');
    });

    it('should never return [object ArrayBuffer]', () => {
      const priv = component as unknown as { extractErrorMessage: (err: unknown) => string };
      const httpError = new HttpErrorResponse({
        error: new ArrayBuffer(188),
        status: 403,
        statusText: 'Forbidden',
      });
      const result = priv.extractErrorMessage(httpError);
      expect(result).not.toContain('[object ArrayBuffer]');
      expect(result).toBe('403 Forbidden');
    });
  });

  describe('SVG Image Handling', () => {
    it('should categorize and preview SVG files as standard image with currentUrl', async () => {
      const svgItem: Entry = {
        ID: 'svg1',
        Name: 'vector-graphic.svg',
        Path: 'images/vector-graphic.svg',
        IsDir: false,
        Size: 1024,
        ModTime: '2026-09-01T12:00:00Z',
        MimeType: 'image/svg+xml',
      };
      component.data = {
        items: [svgItem],
        currentIndex: 0,
        url: 'http://localhost/view/vector-graphic.svg',
        isLocal: true,
        remoteName: 'local',
        isDirectUrl: true,
      };

      await component.updateData();

      expect(component.currentFileType()).toBe('image');
      expect(component.currentUrl()).toBe('http://localhost/view/vector-graphic.svg');
      expect(component.isLoading()).toBe(true);

      component.onLoadComplete();
      expect(component.isLoading()).toBe(false);
    });
  });
});
