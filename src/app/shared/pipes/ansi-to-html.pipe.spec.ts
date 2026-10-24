import { TestBed } from '@angular/core/testing';
import { DomSanitizer } from '@angular/platform-browser';
import { describe, it, expect, beforeEach } from 'vitest';
import { AnsiToHtmlPipe } from './ansi-to-html.pipe';

describe('AnsiToHtmlPipe', () => {
  let pipe: AnsiToHtmlPipe;
  let sanitizer: DomSanitizer;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [AnsiToHtmlPipe],
    });
    pipe = TestBed.inject(AnsiToHtmlPipe);
    sanitizer = TestBed.inject(DomSanitizer);
  });

  it('should return empty string for null or empty values', () => {
    expect(pipe.transform('')).toBe('');
    expect(pipe.transform(null as unknown as string)).toBe('');
    expect(pipe.transform(undefined as unknown as string)).toBe('');
  });

  it('should escape HTML tags to prevent XSS', () => {
    const raw = '<script>alert("xss")</script>';
    const result = pipe.transform(raw);
    const sanitizedHtml = sanitizer.sanitize(1, result) ?? '';
    expect(sanitizedHtml).toContain('&lt;script&gt;');
    expect(sanitizedHtml).not.toContain('<script>');
  });

  it('should transform ANSI color codes into styled spans', () => {
    const raw = '\u001b[31mError message\u001b[0m';
    const result = pipe.transform(raw);
    const sanitizedHtml = sanitizer.sanitize(1, result) ?? '';
    expect(sanitizedHtml).toContain('<span style="color: #ef5350">Error message</span>');
  });

  it('should automatically close open spans at the end of the string', () => {
    const raw = '\u001b[32mSuccess message without reset';
    const result = pipe.transform(raw);
    const sanitizedHtml = sanitizer.sanitize(1, result) ?? '';
    expect(sanitizedHtml).toContain(
      '<span style="color: #4caf50">Success message without reset</span>'
    );
  });

  it('should handle unmapped ANSI codes gracefully without crashing', () => {
    const raw = '\u001b[999mUnknown code\u001b[0m';
    const result = pipe.transform(raw);
    const sanitizedHtml = sanitizer.sanitize(1, result) ?? '';
    expect(sanitizedHtml).toContain('Unknown code');
  });
});
