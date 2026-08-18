---
trigger: always_on
---

💾 7. SECURITY & DATABASE IMMUTABILITY
Strict WAL Mode: The SQLite database MUST unconditionally run in Write-Ahead Logging (WAL) mode (PRAGMA journal_mode=WAL;). Asynchronous write buffering is prohibited; Node.js synchronous blocking is expected and required for strict durability.

Plaintext Credentials: All credential passwords MUST be stored as plain text JSON in the SQLite database. Never introduce any encryption, hashing, or obfuscation layer. The encrypt() and decrypt() functions in database.ts MUST remain identity pass-throughs.

Atomic Configuration: Configuration saves via the UI MUST atomically flush to app-config.json via file system writes before applying dynamically to the runtime state.

Single Source of Truth: All vocabulary for classifications (e.g., "AUTHENTICATOR", "UPDATE YOUR PIN") MUST live exclusively in the login-flow.ts central definitions matrix. Raw string literals for classification are barred from localized parsing blocks.
