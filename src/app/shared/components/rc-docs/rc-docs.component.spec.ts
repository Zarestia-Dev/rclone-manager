import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { RcDocsComponent } from './rc-docs.component';

describe('RcDocsComponent', () => {
  let fixture: ComponentFixture<RcDocsComponent>;

  const show = (help: string): void => {
    fixture.componentRef.setInput('help', help);
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RcDocsComponent],
      providers: [provideTranslateService()],
    }).compileComponents();
    fixture = TestBed.createComponent(RcDocsComponent);
  });

  it('renders the markdown with absolute documentation links', () => {
    show('See [lsjson](/commands/rclone_lsjson/).\n\n- one\n- two');
    const link = fixture.nativeElement.querySelector('.markdown a');
    expect(link.getAttribute('href')).toBe('https://rclone.org/commands/rclone_lsjson/');
    expect(fixture.nativeElement.querySelectorAll('.markdown li')).toHaveLength(2);
  });

  it('is folded away until asked for', () => {
    show('text');
    expect(fixture.nativeElement.querySelector('details').open).toBe(false);
  });

  it('shows nothing for an empty help text', () => {
    show('');
    expect(fixture.nativeElement.querySelector('details')).toBeNull();
  });
});
