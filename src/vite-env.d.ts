/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional backend origin used when the frontend is a separate static site. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}