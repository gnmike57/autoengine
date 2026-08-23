import { MullvadSessionAdapter } from "../proxy/mullvad-session-adapter.js";
import fetch from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";
import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  console.log("Initializing MullvadSessionAdapter from environment...");
  const adapter = MullvadSessionAdapter.fromEnvironment();
  
  console.log(`Adapter Mode: ${adapter.mode}`);
  
  if (adapter.mode === "disabled") {
    console.error("Mullvad adapter is disabled. Check your .env file.");
    process.exit(1);
  }

  const sessionKey = crypto.randomBytes(16).toString("hex");
  console.log(`Acquiring session lease for key: ${sessionKey}`);

  let lease;
  try {
    lease = await adapter.acquire(sessionKey);
    console.log(`Lease acquired! ID: ${lease.id}`);
    console.log(`Isolation: ${lease.isolation}`);
    console.log(`Proxy: ${lease.proxy.server}`);
    
    // Check if proxy actually works
    console.log("Testing proxy with request to am.i.mullvad.net...");
    const agent = new SocksProxyAgent(lease.proxy.server);
    const res = await fetch("https://am.i.mullvad.net/connected", { agent });
    const text = await res.text();
    
    console.log("Response from am.i.mullvad.net:");
    console.log("--------------------------------------------------");
    console.log(text.trim());
    console.log("--------------------------------------------------");
    
    if (text.toLowerCase().includes("mullvad")) {
      console.log("SUCCESS: Proxy is correctly routing through Mullvad!");
    } else {
      console.warn("WARNING: Proxy may not be routing through Mullvad properly.");
    }
    
  } catch (err) {
    console.error("Failed to acquire or test lease:", err);
    process.exit(1);
  } finally {
    if (lease) {
      console.log("Closing lease...");
      await lease.close();
      console.log("Lease closed.");
    }
  }
}

run().catch(console.error);
