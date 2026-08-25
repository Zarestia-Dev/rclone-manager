import { TestBed } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { UrlPreviewComponent } from './url-preview.component';
import { IconService } from 'src/app/services/ui/icon.service';
import { FileViewerService } from 'src/app/services/ui/file-viewer.service';

describe('UrlPreviewComponent', () => {
  let component: UrlPreviewComponent;
  let componentRef: ComponentRef<UrlPreviewComponent>;
  let fileViewerServiceMock: {
    openDirectUrl: ReturnType<typeof vi.fn>;
  };
  let iconServiceMock: {
    getFileTypeCategory: ReturnType<typeof vi.fn>;
    getIconForFileType: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    fileViewerServiceMock = {
      openDirectUrl: vi.fn().mockResolvedValue(undefined),
    };
    iconServiceMock = {
      getFileTypeCategory: vi.fn().mockReturnValue('image'),
      getIconForFileType: vi.fn().mockReturnValue('image'),
    };

    TestBed.configureTestingModule({
      imports: [UrlPreviewComponent],
      providers: [
        { provide: FileViewerService, useValue: fileViewerServiceMock },
        { provide: IconService, useValue: iconServiceMock },
        {
          provide: TranslateService,
          useValue: { instant: vi.fn((k: string) => k), get: vi.fn(() => of('')) },
        },
      ],
    });

    const fixture = TestBed.createComponent(UrlPreviewComponent);
    component = fixture.componentInstance;
    componentRef = fixture.componentRef;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should detect valid URL and extract hostname and inferred filename', () => {
    componentRef.setInput('url', 'https://example.com/downloads/wallpaper.png');
    expect(component.isValid()).toBe(true);
    expect(component.hostname()).toBe('example.com');
    expect(component.inferredFilename()).toBe('wallpaper.png');
    expect(component.effectiveFilename()).toBe('wallpaper.png');
    expect(component.extension()).toBe('png');
  });

  it('should prioritize custom filename over inferred filename', () => {
    componentRef.setInput('url', 'https://example.com/downloads/wallpaper.png');
    componentRef.setInput('customFilename', 'custom-name.jpg');
    expect(component.effectiveFilename()).toBe('custom-name.jpg');
    expect(component.extension()).toBe('jpg');
  });

  it('should generate destination preview path', () => {
    componentRef.setInput('url', 'https://example.com/downloads/wallpaper.png');
    componentRef.setInput('destinationPath', 'my-remote:pictures');
    expect(component.targetPreview()).toBe('my-remote:pictures/wallpaper.png');
  });

  it('should call fileViewerService.openDirectUrl when openInViewer is triggered for media', () => {
    componentRef.setInput('url', 'https://example.com/downloads/wallpaper.png');
    expect(component.canOpenViewer()).toBe(true);
    component.openInViewer();
    expect(fileViewerServiceMock.openDirectUrl).toHaveBeenCalledWith(
      'https://example.com/downloads/wallpaper.png',
      'wallpaper.png'
    );
  });

  it('should disable viewer button for non-media files like zip archives', () => {
    iconServiceMock.getFileTypeCategory.mockReturnValue('archive');
    componentRef.setInput('url', 'https://example.com/downloads/backup.zip');
    expect(component.isMedia()).toBe(false);
    expect(component.canOpenViewer()).toBe(false);
    component.openInViewer();
    expect(fileViewerServiceMock.openDirectUrl).not.toHaveBeenCalled();
  });
});
