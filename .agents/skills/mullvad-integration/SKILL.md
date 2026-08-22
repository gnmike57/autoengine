---
name: mullvad-integration
description: Provides instructions and operational context for managing the Mullvad WireGuard API, Wireproxy adapter, and CLI wrappers.
---

# Mullvad Integration & Proxy Skill

You are equipped with this skill to debug, maintain, and expand the Mullvad VPN integration for the automation engine.

## Core Concepts

The engine uses Mullvad as a proxy alternative to standard datacenter residential proxies, taking advantage of WireGuard and Wireproxy.

### Modes
1. **`mullvad-cli`**: Uses the local `mullvad` CLI binary to globally tunnel the entire OS interface. This requires root permissions and is typically only useful for single-threaded headed testing where Docker/Network namespaces are configured elsewhere.
2. **`wireproxy-api`**: (Recommended) Uses a local `wireproxy` binary to create a local SOCKS5 proxy port mapped to a WireGuard tunnel on the fly. 

## Key Files
- `src/proxy/mullvad-api.ts`: Implements the HTTP interactions with `api.mullvad.net` to rotate WireGuard public keys and fetch IPs.
- `src/proxy/mullvad-session-adapter.ts`: Orchestrates the lifecycle (Key Generation -> Config Rendering -> Wireproxy process spawn -> SOCKS5 proxy port binding).

## Concurrency Locks
Because `api.mullvad.net` only allows 5 active WireGuard keys per account, the adapter uses filesystem `.lock` files in `credentials/mullvad/` to guarantee that concurrent workers do not clobber each other's keys or exceed the 5-device limit. The logic maps a worker ID (0-4) to a specific Mullvad device slot.

## Standard Operating Procedures

When the user asks you to "troubleshoot Mullvad" or "update the Wireproxy adapter":
1. **Verify Binary**: Always ensure the `wireproxy` binary is executable (`chmod +x`).
2. **Check Lock Files**: If tests are deadlocking during proxy acquisition, check for stale `.lock` files in the `credentials/mullvad/` directory and purge them.
3. **Verify API Token**: Ensure `MULLVAD_API_TOKEN` is loaded from `.env`. Without it, `mullvad-api.ts` cannot rotate IPs.
4. **IP Rotation Limits**: Remember that Mullvad rotates IPs by changing the exit server in the WireGuard config. The `mullvad-session-adapter.ts` does this by selecting a random server from `mullvad-api.ts`'s server list payload and rendering a new `wg0.conf`.
