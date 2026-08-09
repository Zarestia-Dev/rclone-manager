import { FlagType } from './remote-config';

export type TemplateCategory = FlagType | 'remote' | 'operation';

export interface UserPresetTemplate {
  id: string;
  name: string;
  description?: string;
  remoteType?: string;
  values: Partial<Record<TemplateCategory, Record<string, unknown>>>;
}

export interface ApplyTemplateOptions {
  categories?: TemplateCategory[];
  overwriteExisting?: boolean;
}

export interface ConfigSourceItem {
  id: string;
  name: string;
  type: 'remote' | 'quick-run';
  subtitle?: string;
  icon?: string;
  values: Partial<Record<TemplateCategory, Record<string, unknown>>>;
}
