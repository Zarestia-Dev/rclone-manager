import { inject, Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

@Pipe({
  name: 'ansiToHtml',
  standalone: true,
})
export class AnsiToHtmlPipe implements PipeTransform {
  private readonly sanitizer = inject(DomSanitizer);

  transform(value: string): SafeHtml {
    if (!value) return '';

    // 1. Escape HTML to prevent XSS
    const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // 2. Map ANSI codes to CSS variables or hex colors
    const colors: Record<string, string> = {
      '30': '#000000',
      '31': '#ef5350',
      '32': '#4caf50',
      '33': '#ffca28',
      '34': '#42a5f5',
      '35': '#ab47bc',
      '36': '#26c6da',
      '37': '#e0e0e0',
      '90': '#757575',
      '91': '#e57373',
      '92': '#81c784',
      '93': '#fff176',
      '94': '#64b5f6',
      '95': '#ba68c8',
      '96': '#4dd0e1',
      '97': '#ffffff',
    };

    // 3. Replace ANSI codes
    // eslint-disable-next-line no-control-regex
    const ansiRegex = /\u001b\[(\d+)(?:;(\d+))?m/g;
    let openTags = 0;

    const formatted = escaped.replace(ansiRegex, (match, p1) => {
      const code = p1;
      if (code === '0') {
        if (openTags > 0) {
          openTags--;
          return '</span>';
        }
        return '';
      }
      if (colors[code]) {
        openTags++;
        return `<span style="color: ${colors[code]}">`;
      }
      return '';
    });

    const closing = '</span>'.repeat(openTags);
    return this.sanitizer.bypassSecurityTrustHtml(formatted + closing);
  }
}
