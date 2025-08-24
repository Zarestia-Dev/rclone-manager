export type AppTab = 'mount' | 'sync' | 'files' | 'general';

export interface ModalSize {
  width: string;
  maxWidth: string;
  minWidth: string;
  height: string;
  maxHeight: string;
}

export const STANDARD_MODAL_SIZE: ModalSize = {
  width: '90vw',
  maxWidth: '642px',
  minWidth: '360px',
  height: '80vh',
  maxHeight: '600px',
};
