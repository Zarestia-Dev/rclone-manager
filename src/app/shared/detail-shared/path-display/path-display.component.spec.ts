import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PathDisplayComponent } from './path-display.component';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';

describe('PathDisplayComponent path state', () => {
  let fixture: ComponentFixture<PathDisplayComponent>;
  let component: PathDisplayComponent;
  let paths: PathService;
  const isWindows = signal(false);

  beforeEach(() => {
    isWindows.set(false);
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
    TestBed.configureTestingModule({
      imports: [PathDisplayComponent],
      providers: [{ provide: BackendService, useValue: { isWindows } }],
    }).overrideComponent(PathDisplayComponent, { set: { template: '', imports: [] } });
    paths = TestBed.inject(PathService);
    paths.setRemoteNames(['drive']);
    fixture = TestBed.createComponent(PathDisplayComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each(['', []])('handles an empty source %j', source => {
    fixture.componentRef.setInput('config', { source, destination: '' });
    expect(component.sourceIsMultiPath()).toBe(false);
    expect(component.sourcePrimaryPath()).toBe('');
    expect(component.sourcePrimaryPathIsLocal()).toBe(false);
    expect(component.sourceDisplay()).toBe('');
    expect(component.sourceTooltip()).toBe('');
    expect(component.destinationIsLocal()).toBe(false);
  });

  it('formats mixed sources and reacts when remote classification changes', () => {
    const local = '/home/user/Arşiv & photos';
    const remote = 'drive:旅行/#1';
    fixture.componentRef.setInput('config', {
      source: [remote, local],
      destination: '/backup',
    });
    expect(component.sourceIsMultiPath()).toBe(true);
    expect(component.sourcePrimaryPath()).toBe(remote);
    expect(component.sourcePrimaryPathIsLocal()).toBe(false);
    expect(component.sourcePathItems()).toEqual([
      { path: remote, displayPath: remote, isLocal: false },
      { path: local, displayPath: local, isLocal: true },
    ]);
    expect(component.sourceDisplay()).toBe(`${remote}, ${local}`);
    expect(component.sourceTooltip()).toBe(`${remote}\n${local}`);
    expect(component.destinationIsLocal()).toBe(true);

    paths.setRemoteNames([]);
    expect(component.sourcePrimaryPathIsLocal()).toBe(true);
    expect(component.sourcePathItems()[0].isLocal).toBe(true);

    fixture.componentRef.setInput('config', { source: local, destination: remote });
    paths.setRemoteNames(['drive']);
    expect(component.sourceIsMultiPath()).toBe(false);
    expect(component.sourcePrimaryPath()).toBe(local);
    expect(component.destinationIsLocal()).toBe(false);
  });

  it('renders Windows local paths with native separators while retaining operation paths', () => {
    isWindows.set(true);
    const source = 'C:/Users/hakan/Arşiv 2026';
    const remote = 'drive:photos/旅行';
    fixture.componentRef.setInput('config', {
      source: [source, remote],
      destination: 'D:/Yedek/Arşiv',
    });
    expect(component.sourceDisplay()).toBe(`C:\\Users\\hakan\\Arşiv 2026, ${remote}`);
    expect(component.sourceTooltip()).toBe(`C:\\Users\\hakan\\Arşiv 2026\n${remote}`);
    expect(component.destinationDisplay()).toBe('D:\\Yedek\\Arşiv');
    expect(component.sourcePrimaryPath()).toBe(source);
    expect(component.sourcePathItems()).toEqual([
      { path: source, displayPath: 'C:\\Users\\hakan\\Arşiv 2026', isLocal: true },
      { path: remote, displayPath: remote, isLocal: false },
    ]);
    expect(component.config().destination).toBe('D:/Yedek/Arşiv');
  });

  it.each(['drive:folder/file', 'https://example.com/path', 'saf://drive/folder', 'HTTP at :8080'])(
    'preserves non-local destinations on Windows: %s',
    destination => {
      isWindows.set(true);
      fixture.componentRef.setInput('config', { source: 'drive:folder/file', destination });
      expect(component.sourceDisplay()).toBe('drive:folder/file');
      expect(component.destinationDisplay()).toBe(destination);
    }
  );

  it('updates local path rendering when the backend OS changes', () => {
    fixture.componentRef.setInput('config', { source: 'C:/Users/hakan', destination: 'D:/backup' });
    expect(component.sourceDisplay()).toBe('C:/Users/hakan');
    isWindows.set(true);
    expect(component.sourceDisplay()).toBe('C:\\Users\\hakan');
    expect(component.destinationDisplay()).toBe('D:\\backup');
    isWindows.set(false);
    expect(component.destinationDisplay()).toBe('D:/backup');
  });
});
