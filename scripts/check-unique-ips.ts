import fs from "fs";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

const PROXY_FILE = "proxy-pool-6.txt";
const CONCURRENCY = 30;

async function checkProxyIP(proxyUrl: string): Promise<string | null> {
  try {
    const url = new URL(proxyUrl);
    // Format required by HttpsProxyAgent
    const agentUrl = `${url.protocol}//${url.username}:${url.password}@${url.hostname}:${url.port}`;
    const agent = new HttpsProxyAgent(agentUrl);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
    
    const res = await fetch("https://api.ipify.org?format=text", {
      agent,
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (res.ok) {
      return (await res.text()).trim();
    }
  } catch (err: unknown) {
    // Ignore errors for this count
  }
  return null;
}

async function main() {
  const proxies = fs.readFileSync(PROXY_FILE, "utf-8")
    .split("\n")
    .map(p => p.trim())
    .filter(p => p.length > 0);
    
  const uniqueProxies = [...new Set(proxies)];
  console.log(`Checking ${uniqueProxies.length} proxies for unique exit IPs...`);
  
  const ips = new Set<string>();
  let successCount = 0;
  let failCount = 0;

  const validProxies: string[] = [];

  let i = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (i < uniqueProxies.length) {
      const proxy = uniqueProxies[i++]!;
      const ip = await checkProxyIP(proxy);
      if (ip) {
        ips.add(ip);
        successCount++;
        validProxies.push(proxy);
        process.stdout.write("✓");
      } else {
        failCount++;
        process.stdout.write("x");
      }
    }
  });

  await Promise.all(workers);
  
  console.log(`\n\nResults:`);
  console.log(`Total Proxies Checked: ${uniqueProxies.length}`);
  console.log(`Successful Connections: ${successCount}`);
  console.log(`Failed Connections (Timeout/Dead): ${failCount}`);
  console.log(`UNIQUE EXIT IPs: ${ips.size}`);

  if (validProxies.length > 0) {
    fs.writeFileSync(PROXY_FILE, validProxies.join("\n") + "\n");
    console.log(`\nOverwrote ${PROXY_FILE} with ${validProxies.length} reachable proxies.`);
  } else {
    console.log(`\nNo valid proxies found, did not overwrite ${PROXY_FILE}.`);
  }
}

main().catch(console.error);
