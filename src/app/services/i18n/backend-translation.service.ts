import { Injectable, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

interface LocalizedMessage {
  key: string;
  params?: Record<string, string>;
}

/**
 * Service for translating backend error/success messages.
 * Handles multiple formats:
 * 1. JSON string with key + params: {"key": "backendErrors.mount.alreadyInUse", "params": {...}}
 * 2. Embedded JSON in string: "Start job failed: {\"key\":\"backendErrors.mount.configIncomplete\",...}"
 * 3. Structured object: { key: "backendErrors.mount.alreadyInUse", params: {...} }
 * 4. Simple translation key: "backendErrors.mount.pointEmpty"
 * 5. Error instance wrapping key/JSON
 * 6. Legacy English message: "Mount point cannot be empty"
 */
@Injectable({ providedIn: 'root' })
export class BackendTranslationService {
  private translate = inject(TranslateService);

  /**
   * Translate a backend error/message response.
   */
  translateBackendMessage(message: unknown): string {
    if (message === null || message === undefined) {
      return '';
    }

    // Direct object with key property
    if (
      typeof message === 'object' &&
      'key' in message &&
      typeof (message as LocalizedMessage).key === 'string'
    ) {
      const loc = message as LocalizedMessage;
      return this.translateWithFallback(loc.key, loc.params);
    }

    let msgStr: string;
    if (typeof message === 'string') {
      msgStr = message;
    } else if (message instanceof Error) {
      msgStr = message.message;
    } else if (typeof message === 'object' && 'message' in message) {
      msgStr = String((message as { message: unknown }).message);
    } else {
      return String(message);
    }

    // 1. Try to parse entire string as JSON (dynamic error with params)
    const parsed = this.tryParseLocalizedError(msgStr);
    if (parsed) {
      return this.translateWithFallback(parsed.key, parsed.params, msgStr);
    }

    // 2. Check if message contains an embedded JSON error (e.g., "Prefix: {"key":"...", ...}")
    const embedded = this.tryExtractEmbeddedLocalizedError(msgStr);
    if (embedded) {
      const translated = this.translateWithFallback(
        embedded.error.key,
        embedded.error.params,
        embedded.rawJson
      );
      return msgStr.replace(embedded.rawJson, translated);
    }

    // 3. Check if it looks like a translation key (e.g., "backendErrors.mount.pointEmpty")
    if (this.looksLikeTranslationKey(msgStr)) {
      return this.translateWithFallback(msgStr, undefined, msgStr);
    }

    // 4. Return as-is (legacy English message or unknown format)
    return msgStr;
  }

  private tryParseLocalizedError(message: string): LocalizedMessage | null {
    const trimmed = message.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.key === 'string') {
        return parsed as LocalizedMessage;
      }
    } catch {
      // Not valid JSON, ignore
    }
    return null;
  }

  private tryExtractEmbeddedLocalizedError(
    message: string
  ): { error: LocalizedMessage; rawJson: string } | null {
    const startIndex = message.indexOf('{');
    const lastIndex = message.lastIndexOf('}');
    if (startIndex === -1 || lastIndex <= startIndex) return null;

    const rawJson = message.slice(startIndex, lastIndex + 1);
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed.key === 'string') {
        return { error: parsed as LocalizedMessage, rawJson };
      }
    } catch {
      // Not valid JSON, ignore
    }
    return null;
  }

  private looksLikeTranslationKey(message: string): boolean {
    return /^[a-z0-9_]+(\.[a-z0-9_]+)+$/i.test(message.trim());
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
