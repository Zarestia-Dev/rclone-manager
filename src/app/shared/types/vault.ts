export interface VaultInfo {
  enabled: boolean;
  isLocked: boolean;
  lockTimeoutSecs?: number | null;
}
