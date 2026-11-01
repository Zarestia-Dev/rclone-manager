import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { RcCommandInfo } from '@app/types';
import { RcHelpComponent } from './rc-help.component';

const LIST: RcCommandInfo = {
  Path: 'operations/list',
  Title: 'List files',
  Help: `This takes the following parameters:

- fs - a remote name string
- remote - a path (optional)

Returns:

- list

    rclone rc operations/list fs=drive:

See [lsjson](/commands/rclone_lsjson/).`,
};

describe('RcHelpComponent', () => {
  let fixture: ComponentFixture<RcHelpComponent>;
  let component: RcHelpComponent;

  const open = (command: RcCommandInfo): void => {
    fixture.componentRef.setInput('command', command);
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RcHelpComponent],
      providers: [provideTranslateService()],
    }).compileComponents();
    fixture = TestBed.createComponent(RcHelpComponent);
    component = fixture.componentInstance;
  });

  it('lists the parsed parameters and examples', () => {
    open(LIST);
    expect(component.params().map(p => p.name)).toEqual(['fs', 'remote']);
    expect(component.examples()).toEqual(['operations/list fs=drive:']);
    expect(fixture.nativeElement.querySelectorAll('.param-input')).toHaveLength(2);
  });

  it('builds a command line from the filled-in fields and ignores empty ones', () => {
    open(LIST);
    component.setValue('fs', 'my drive:');
    expect(component.built()).toBe('operations/list fs="my drive:"');
    component.setValue('remote', 'dir');
    expect(component.built()).toBe('operations/list fs="my drive:" remote=dir');
  });

  it('forgets the fields when another command is shown', () => {
    open(LIST);
    component.setValue('fs', 'x:');
    open({ ...LIST, Path: 'operations/size' });
    expect(component.built()).toBe('operations/size');
  });

  it('emits the line to insert, run and when closed', () => {
    open(LIST);
    const inserted: string[] = [];
    const ran: string[] = [];
    let closed = 0;
    component.insert.subscribe(l => inserted.push(l));
    component.run.subscribe(l => ran.push(l));
    component.closed.subscribe(() => closed++);

    const buttons: HTMLButtonElement[] = [...fixture.nativeElement.querySelectorAll('button')];
    buttons.forEach(b => b.click());

    expect(inserted).toContain('operations/list fs=drive:');
    expect(ran).toEqual(['operations/list fs=drive:']);
    expect(closed).toBe(1);
  });

  it('renders the full documentation with absolute links', () => {
    open(LIST);
    const link = fixture.nativeElement.querySelector('.markdown a');
    expect(link.getAttribute('href')).toBe('https://rclone.org/commands/rclone_lsjson/');
  });

  it('says so when the help lists no parameters', () => {
    open({ Path: 'vfs/refresh', Title: 'Refresh', Help: 'Prose only.' });
    expect(component.params()).toEqual([]);
    expect(fixture.nativeElement.querySelector('.note')).not.toBeNull();
  });
});
