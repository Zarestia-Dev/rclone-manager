import { Injectable } from '@angular/core';

const STORAGE_PREFIX = 'rcman.';

@Injectable({
  providedIn: 'root',
})
export class LocalStorageService {
  private fallbackStore = new Map<string, unknown>();
  private useLocalStorage = this.checkLocalStorageAvailable();

  private checkLocalStorageAvailable(): boolean {
    try {
      const testKey = STORAGE_PREFIX + '__test__';
      localStorage.setItem(testKey, '1');
      localStorage.removeItem(testKey);
      return true;
    } catch {
      return false;
    }
  }

  private getFullKey(key: string): string {
    return key.startsWith(STORAGE_PREFIX) ? key : STORAGE_PREFIX + key;
  }

  private getScopedKey(scope: string, key: string): string {
    const fullScope = scope.startsWith(STORAGE_PREFIX) ? scope : STORAGE_PREFIX + scope;
    return `${fullScope}.${key}`;
  }

  get<T>(key: string, fallback: T): T {
    const fullKey = this.getFullKey(key);
    if (!this.useLocalStorage) {
      return this.fallbackStore.has(fullKey) ? (this.fallbackStore.get(fullKey) as T) : fallback;
    }

    try {
      const value = localStorage.getItem(fullKey);
      if (value === null) return fallback;
      return JSON.parse(value) as T;
    } catch (err) {
      console.warn(`Failed to parse localStorage key "${fullKey}":`, err);
      return fallback;
    }
  }

  set<T>(key: string, value: T): void {
    const fullKey = this.getFullKey(key);
    if (!this.useLocalStorage) {
      this.fallbackStore.set(fullKey, value);
      return;
    }

    try {
      localStorage.setItem(fullKey, JSON.stringify(value));
    } catch (err) {
      console.error(`Failed to set localStorage key "${fullKey}":`, err);
    }
  }

  remove(key: string): void {
    const fullKey = this.getFullKey(key);
    if (!this.useLocalStorage) {
      this.fallbackStore.delete(fullKey);
      return;
    }

    try {
      localStorage.removeItem(fullKey);
    } catch (err) {
      console.error(`Failed to remove localStorage key "${fullKey}":`, err);
    }
  }

  getScoped<T>(scope: string, key: string, fallback: T): T {
    const scopedKey = this.getScopedKey(scope, key);
    return this.get<T>(scopedKey, fallback);
  }

  setScoped<T>(scope: string, key: string, value: T): void {
    const scopedKey = this.getScopedKey(scope, key);
    this.set<T>(scopedKey, value);
  }

  clearAll(): void {
    this.fallbackStore.clear();
    if (!this.useLocalStorage) return;

    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(STORAGE_PREFIX)) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach(key => localStorage.removeItem(key));
    } catch (err) {
      console.error('Failed to clear rcman.* localStorage keys:', err);
    }
  }
}
