import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { ServeCardComponent } from './serve-card.component';
import { ServeListItem, Starter } from '@app/types';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';

describe('ServeCardComponent', () => {
  let fixture: ComponentFixture<ServeCardComponent>;
  let component: ServeCardComponent;

  const base: ServeListItem = {
    id: 'http-1',
    addr: '127.0.0.1:8080',
    params: { fs: 'drive:folder', type: 'http' },
  };

  const render = (serve: ServeListItem, showRemoteName = true): HTMLElement => {
    fixture.componentRef.setInput('serve', serve);
    fixture.componentRef.setInput('showRemoteName', showRemoteName);
    fixture.detectChanges();
    return fixture.nativeElement;
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ServeCardComponent],
      providers: [
        provideTranslateService(),
        {
          provide: PathService,
          useValue: { getRemoteNameFromFs: (fs: string): string => fs.split(':')[0] },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ServeCardComponent);
    component = fixture.componentInstance;
  });

  it('shows the remote, the protocol, the URL and the filesystem', () => {
    const el = render(base);
    expect(el.querySelector('.serve-remote-name')?.textContent).toContain('drive');
    expect(el.textContent).toContain('HTTP');
    expect(el.querySelector('.serve-url')?.textContent).toContain('http://127.0.0.1:8080');
    expect(el.querySelector('.serve-fs')?.textContent).toContain('drive:folder');
  });

  it('hides the remote name when asked to', () => {
    expect(render(base, false).querySelector('.serve-remote-name')).toBeNull();
  });

  it.each<[Starter, string]>([
    [{ kind: 'profile', name: 'public' }, 'public'],
    [{ kind: 'quick_run', id: 'qr-1', name: 'Share photos' }, 'Share photos'],
    [
      { kind: 'workflow', workflowId: 'wf', workflowName: 'Nightly', nodeId: 'n', ancestors: [] },
      'Nightly',
    ],
  ])('names what started the serve: %j', (starter, name) => {
    const el = render({ ...base, starter });
    expect(el.querySelector('app-starter-pill')?.textContent).toContain(name);
  });

  describe('options', () => {
    it('counts none for a serve started with only what it serves', () => {
      const el = render(base);
      expect(component.optionsData().keys).toEqual([]);
      expect(el.querySelector('.options-value')).toBeNull();
    });

    it('counts what the serve was started with, not the filesystem or the type', () => {
      const serve: ServeListItem = {
        ...base,
        params: {
          ...base.params,
          opt: { addr: ':8080', baseurl: '/x' },
          vfsOpt: { cacheMode: 'full' },
        },
      };
      const el = render(serve);
      expect(component.optionsData().keys).toEqual(['opt', 'vfsOpt']);
      expect(el.querySelector('.options-value')?.textContent).toContain('2');
      expect(component.optionsData().tooltip).toContain('addr: :8080');
    });
  });

  describe('open link', () => {
    it('links an http serve to its URL', () => {
      const link = render(base).querySelector('a[target="_blank"]') as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe('http://127.0.0.1:8080');
      expect(link.rel).toContain('noopener');
    });

    it.each(['webdav', 'ftp', 'sftp', 's3', 'nfs'])('has no link for a %s serve', type => {
      const el = render({ ...base, params: { ...base.params, type } });
      expect(el.querySelector('a[target="_blank"]')).toBeNull();
    });

    it('does not emit a card click', () => {
      const el = render(base);
      const click = vi.fn();
      component.cardClick.subscribe(click);
      const link = el.querySelector('a[target="_blank"]') as HTMLAnchorElement;
      link.addEventListener('click', e => e.preventDefault());
      link.click();
      expect(click).not.toHaveBeenCalled();
    });
  });

  describe('keyboard and screen readers', () => {
    // The card isn't a button (it holds buttons of its own): its main action is a button beside
    // them, stretched over the card, which a real Enter or Space clicks.
    it('gives the card a main action button of its own, named after it', () => {
      const el = render(base);
      const card = el.querySelector('mat-card') as HTMLElement;
      const main = card.firstElementChild as HTMLButtonElement;
      expect(card.getAttribute('role')).toBeNull();
      expect(card.hasAttribute('tabindex')).toBe(false);
      expect(main.matches('button.card-primary-action')).toBe(true);
      expect(main.getAttribute('aria-label')).toBe('drive · HTTP');
      expect(card.querySelector('button button, [role="button"] button')).toBeNull();

      const click = vi.fn();
      component.cardClick.subscribe(click);
      main.click();
      expect(click).toHaveBeenCalledWith(base);
    });
  });

  it('stops without also emitting a card click', () => {
    const el = render(base);
    const stop = vi.fn();
    const click = vi.fn();
    component.stopServe.subscribe(stop);
    component.cardClick.subscribe(click);

    (el.querySelector('button.action-button') as HTMLButtonElement).click();

    expect(stop).toHaveBeenCalledWith(base);
    expect(click).not.toHaveBeenCalled();
  });
});
