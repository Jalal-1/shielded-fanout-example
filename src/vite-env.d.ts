/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the proof server listens. Defaults to http://127.0.0.1:6300. */
  readonly VITE_PROOF_SERVER_URL?: string;
}
