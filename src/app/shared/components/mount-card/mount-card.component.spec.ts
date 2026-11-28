import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { MountCardComponent } from './mount-card.component';
import { MountedRemote, Starter } from '@app/types';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';

describe('MountCardComponent', () => {
  let fixture: ComponentFixture<MountCardComponent>;
  let component: MountCardComponent;

  const base: MountedRemote = { fs: 'drive:folder', mount_point: '/mnt/drive' };

  const render = (mount: MountedRemote): HTMLElement => {
    fixture.componentRef.setInput('mount', mount);
    fixture.detectChanges();
    return fixture.nativeElement;
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MountCardComponent],
      providers: [
        provideTranslateService(),
        {
          provide: PathService,
          useValue: { getRemoteNameFromFs: (fs: string): string => fs.split(':')[0] },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(MountCardComponent);
    component = fixture.componentInstance;
  });

  it('shows the remote, the mount point and the filesystem', () => {
    const el = render(base);
    expect(el.querySelector('.mount-remote-name')?.textContent).toContain('drive');
    expect(el.querySelector('.mount-point')?.textContent).toContain('/mnt/drive');
    expect(el.querySelector('.mount-fs')?.textContent).toContain('drive:folder');
  });

  it.each<[Starter, string]>([
    [{ kind: 'profile', name: 'work' }, 'work'],
    [{ kind: 'quick_run', id: 'qr-1', name: 'Nightly backup' }, 'Nightly backup'],
    [
      { kind: 'workflow', workflowId: 'wf', workflowName: 'Sync all', nodeId: 'n', ancestors: [] },
      'Sync all',
    ],
  ])('names what started the mount: %j', (starter, name) => {
    const el = render({ ...base, starter });
    expect(el.querySelector('app-starter-pill')?.textContent).toContain(name);
  });

  it('names nothing for a mount without a starter', () => {
    const el = render(base);
    expect(el.querySelector('app-starter-pill span')).toBeNull();
  });

  it('emits unmount and open without also emitting a card click', () => {
    const el = render(base);
    const unmount = vi.fn();
    const open = vi.fn();
    const click = vi.fn();
    component.unmount.subscribe(unmount);
    component.openMount.subscribe(open);
    component.cardClick.subscribe(click);

    const [openBtn, unmountBtn] = Array.from(
      el.querySelectorAll<HTMLButtonElement>('button:not(.card-primary-action)')
    );
    openBtn.click();
    unmountBtn.click();

    expect(open).toHaveBeenCalledWith(base);
    expect(unmount).toHaveBeenCalledWith(base);
    expect(click).not.toHaveBeenCalled();
  });

  describe('start time and type', () => {
    it('shows neither for a mount that reports none', () => {
      expect(render(base).querySelector('.mount-meta')).toBeNull();
    });

    it('shows the type and the time rclone mounted it', () => {
      const mounted_on = '2026-11-19T10:00:00+01:00';
      const el = render({ ...base, mount_type: 'cmount', mounted_on });
      const pills = el.querySelectorAll('.mount-meta [appPill], .mount-meta .app-pill');
      expect(pills[0].textContent).toContain('cmount');
      expect(pills[1].textContent).toContain(new Date(mounted_on).toLocaleString());
    });

    it('ignores a time it cannot read', () => {
      const el = render({ ...base, mounted_on: 'yesterday' });
      expect(el.querySelector('.mount-meta')).toBeNull();
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
      expect(main.getAttribute('aria-label')).toBe('drive');
      expect(card.querySelector('button button, [role="button"] button')).toBeNull();

      const click = vi.fn();
      component.cardClick.subscribe(click);
      main.click();
      expect(click).toHaveBeenCalledWith(base);
    });
  });
});
