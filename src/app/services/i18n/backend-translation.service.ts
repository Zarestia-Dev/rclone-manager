import { Injectable, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

interface LocalizedError {
  key: string;
  params?: Record<string, string>;
}

/**
 * Service for translating backend error/success messages
 * Handles both simple translation keys and JSON format with parameters
 */
@Injectable({ providedIn: 'root' })
export class BackendTranslationService {
  private translate = inject(TranslateService);

  /**
   * Translate a backend error/message response
   * Handles three formats:
   * 1. JSON with key + params: {"key": "errors.mount.alreadyInUse", "params": {...}}
   * 2. Simple translation key: "errors.mount.pointEmpty"
   * 3. Legacy English message: "Mount point cannot be empty"
   */
  translateBackendMessage(message: unknown): string {
    let msgStr: string;
    if (typeof message === 'string') {
      msgStr = message;
    } else if (message instanceof Error) {
      msgStr = message.message;
    } else if (message && typeof message === 'object' && 'message' in message) {
      msgStr = String((message as { message: unknown }).message);
    } else {
      return String(message);
    }

    // Try to parse as JSON (dynamic error with params)
    const parsed = this.tryParseLocalizedError(msgStr);
    if (parsed) {
      return this.translateWithFallback(parsed.key, parsed.params, msgStr);
    }

    // Check if it looks like a translation key (e.g., "errors.mount.pointEmpty")
    if (this.looksLikeTranslationKey(msgStr)) {
      return this.translateWithFallback(msgStr, undefined, msgStr);
    }

    // Return as-is (legacy English message or unknown format)
    return msgStr;
  }

  private tryParseLocalizedError(message: string): LocalizedError | null {
    if (!message.startsWith('{')) return null;

    try {
      const parsed = JSON.parse(message);
      if (parsed && typeof parsed.key === 'string') {
        return parsed as LocalizedError;
      }
    } catch {
      // Not valid JSON, ignore
    }
    return null;
  }

  private looksLikeTranslationKey(message: string): boolean {
    // Examples: "errors.mount.pointEmpty", "success.mount.completed", "common.error"
    // Must start with category and have at least one dot.
    return /^[a-z0-9_]+\.[a-z0-9_.]*[a-z0-9_]+$/i.test(message);
  }

  private translateWithFallback(
    key: string,
    params?: Record<string, string>,
    fallback?: string
  ): string {
    const translated = this.translate.instant(key, params);
    // If translation returns the key itself, it wasn't found
    return translated !== key ? translated : (fallback ?? key);
  }
}
