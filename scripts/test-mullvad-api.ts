import { MullvadApiClient } from "../src/proxy/mullvad-api.js";

async function test() {
  const client = new MullvadApiClient("1234567890123456");
  console.log("Fetching relays...");
  const relays = await client.fetchRelays();
  console.log(`Found ${relays.length} active WireGuard relays.`);
  if (relays.length > 0) {
    console.log("First relay:", relays[0]!.hostname, "in", relays[0]!.country_name);
  }
}

test().catch(console.error);
