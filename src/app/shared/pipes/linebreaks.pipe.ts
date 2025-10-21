import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { inject } from '@angular/core';

@Pipe({
  name: 'linebreaks',
  standalone: true,
  pure: true,
})
export class LinebreaksPipe implements PipeTransform {
  private sanitizer = inject(DomSanitizer);

  transform(value: string | null | undefined): SafeHtml {
    if (!value || typeof value !== 'string') {
      return '';
    }

    // First, escape all HTML to prevent XSS
    let html = this.escapeHtml(value.trim());

    // Now apply safe transformations on escaped content

    // Process markdown bold **text** - safe because content is already escaped
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Process markdown italic *text* (but not **text**)
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

    // Process inline code `code`
    html = html.replace(/`(.+?)`/g, '<code>$1</code>');

    // Process URLs - safely capture and create links
    html = this.linkifyUrls(html);

    // Process markdown links [text](url) - validate URLs first
    html = this.linkifyMarkdownLinks(html);

    // Replace line breaks (\n, \r\n, \r) with <br> - handle both literal \n and actual line breaks
    html = html.replace(/\\n|\\r\\n|\\r|\r\n|\r|\n/g, '<br>');

    // Replace tabs with non-breaking spaces
    html = html.replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');

    // Use bypassSecurityTrustHtml safely - content is already escaped, only safe tags added
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private linkifyUrls(html: string): string {
    // Match URLs and replace with safe anchor tags
    return html.replace(/(https?:\/\/[^\s<>")]+|ftp:\/\/[^\s<>")]+)/g, url =>
      this.createSafeLink(url, url)
    );
  }

  private linkifyMarkdownLinks(html: string): string {
    // Match markdown links [text](url)
    return html.replace(/\[(.+?)\]\(([^)]+)\)/g, (match, text, url) => {
      if (this.isValidUrl(url)) {
        return this.createSafeLink(url, text);
      }
      return match; // Return original if URL is invalid
    });
  }

  private createSafeLink(href: string, text: string): string {
    if (!this.isValidUrl(href)) {
      return text;
    }
    // Create link with security attributes
    return `<a href="${this.escapeAttribute(
      href
    )}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  }

  private isValidUrl(url: string): boolean {
    try {
      // Only allow http, https, ftp protocols
      const parsed = new URL(url, window.location.origin);
      return /^(https?|ftp):/.test(parsed.protocol);
    } catch {
      return false;
    }
  }

  private escapeAttribute(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/'/g, '&#39;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
