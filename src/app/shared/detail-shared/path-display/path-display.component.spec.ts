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

  beforeEach(() => {
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
      providers: [{ provide: BackendService, useValue: { isWindows: signal(false) } }],
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
      { path: remote, isLocal: false },
      { path: local, isLocal: true },
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
});
