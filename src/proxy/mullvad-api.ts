import crypto from "node:crypto";
import fetch from "node-fetch";

export interface MullvadRelay {
  hostname: string;
  country_code: string;
  country_name: string;
  city_code: string;
  city_name: string;
  active: boolean;
  owned: boolean;
  provider: string;
  ipv4_addr_in: string;
  ipv6_addr_in: string;
  network_port_speed: number;
  type: string;
  pubkey: string;
}

export interface MullvadDeviceKey {
  pubkey: string;
  ipv4_address: string;
  ipv6_address?: string;
  privkey: string; // We store the locally generated private key alongside it
}

export class MullvadApiClient {
  private readonly accountId: string;
  
  constructor(accountId: string) {
    this.accountId = accountId.replace(/\s+/g, "");
  }

  /**
   * Fetches the complete list of active Mullvad relays.
   */
  async fetchRelays(): Promise<MullvadRelay[]> {
    const res = await fetch("https://api.mullvad.net/www/relays/all/");
    if (!res.ok) {
      throw new Error(`Failed to fetch mullvad relays: ${res.status} ${res.statusText}`);
    }
    const data = await res.json() as MullvadRelay[];
    return data.filter(r => r.active && r.type === "wireguard");
  }

  private async getAuthToken(): Promise<string> {
    const res = await fetch("https://api.mullvad.net/auth/v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_number: this.accountId })
    });
    if (!res.ok) throw new Error(`Failed to get auth token: ${res.status} ${res.statusText}`);
    const data = await res.json() as { access_token: string };
    return data.access_token;
  }

  /**
   * Generates a new WireGuard keypair and registers it with the Mullvad API.
   */
  async generateAndRegisterDevice(): Promise<MullvadDeviceKey> {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519");
    const jwkPrivate = privateKey.export({ format: "jwk" });
    const jwkPublic = publicKey.export({ format: "jwk" });
    const wgPrivateBase64 = Buffer.from(jwkPrivate.d as string, "base64url").toString("base64");
    const wgPublicBase64 = Buffer.from(jwkPublic.x as string, "base64url").toString("base64");

    const token = await this.getAuthToken();

    const res = await fetch("https://api.mullvad.net/app/v1/wireguard-keys", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({ pubkey: wgPublicBase64 })
    });

    if (!res.ok) {
      throw new Error(`Failed to register wireguard key with Mullvad: ${res.status} ${res.statusText}`);
    }

    const data = await res.json() as { ipv4_address: string; ipv6_address?: string };
    
    return {
      pubkey: wgPublicBase64,
      privkey: wgPrivateBase64,
      ipv4_address: data.ipv4_address,
      ipv6_address: data.ipv6_address
    };
  }

  /**
   * Generates a wireproxy config string for a given relay and device key.
   */
  generateWireproxyConfig(relay: MullvadRelay, device: MullvadDeviceKey): string {
    return `[Interface]
PrivateKey = ${device.privkey}
Address = ${device.ipv4_address}
${device.ipv6_address ? `Address = ${device.ipv6_address}` : ""}
DNS = 10.64.0.1

[Peer]
PublicKey = ${relay.pubkey}
Endpoint = ${relay.ipv4_addr_in}:51820
AllowedIPs = 0.0.0.0/0, ::/0
`;
  }
}
