/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional override for `SPEED_API_ORIGIN` (e.g. `http://127.0.0.1:3001` with an SSH tunnel). */
  readonly VITE_SPEED_API_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
