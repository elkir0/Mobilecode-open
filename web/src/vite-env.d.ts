// SPDX-License-Identifier: Apache-2.0
/// <reference types="vite/client" />

// Build-time-injected push relay defaults (web/.env.local, gitignored).
// The built app ships with these prefilled (zero-config push for the owner);
// the public source never contains them. Settings fields stay editable so a
// fork can use its own relay. localStorage (user-entered) still wins.
interface ImportMetaEnv {
  readonly VITE_PUSH_RELAY_URL?: string
  readonly VITE_PUSH_API_KEY?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
