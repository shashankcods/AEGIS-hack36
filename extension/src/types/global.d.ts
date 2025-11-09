// extension/src/types/global.d.ts
export {};

declare global {
  interface Window {
    AEGIS_manualCapture?: () => Promise<any>;
  }
}
