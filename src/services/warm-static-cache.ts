/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
import "dotenv/config";
import * as fs from "fs";
import * as readline from "readline";
import { launchPersistentContext } from "cloakbrowser";
import { getStaticCacheDir, sanitizeStaticCacheProfile } from "../stealth/static-cache.js";

type ProxyEntry = { server: string; username?: string; password?: string };

const DEFAULT_URLS = [
  "https://www.joefortune.zone/login",
  "https://www.ignitioncasino551.com/login",
];

function parseProxyLine(line: string): ProxyEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  if (/^(https?|socks5):\/\//i.test(trimmed)) {
    const u = new URL(trimmed);
    return {
      server: `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  }
  const parts = trimmed.split(":");
  if (parts.length < 4) return undefined;
  const [host, port, username, ...passParts] = parts;
  return { server: `http://${host}:${port}`, username, password: passParts.join(":") };
}

async function pickWarmProxy(): Promise<ProxyEntry | undefined> {
  if (process.env.AU_PROXY_URL) return parseProxyLine(process.env.AU_PROXY_URL);
  const file = process.env.AU_PROXY_FILE;
  if (file && fs.existsSync(file)) {
    const stream = fs.createReadStream(file);
    stream.on("error", (err) => {
      console.warn(`[static-cache] failed to read proxy file: ${err}`);
    });
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity
    });
    for await (const line of rl) {
      if (line.trim()) {
        rl.close();
        return parseProxyLine(line);
      }
    }
  }
  return undefined;
}

const urls = process.env.CLOAK_STATIC_CACHE_URLS
  ? process.env.CLOAK_STATIC_CACHE_URLS.split(",").map((u) => u.trim()).filter(Boolean)
  : DEFAULT_URLS;

const userDataDir = getStaticCacheDir();
fs.rmSync(userDataDir, { recursive: true, force: true });
fs.mkdirSync(userDataDir, { recursive: true });

const proxy = await pickWarmProxy();
const context = await launchPersistentContext({
  userDataDir,
  headless: true,
  proxy,
  geoip: !!proxy,
  humanize: false,
  viewport: { width: 1280, height: 720 },
  args: ["--disable-features=TranslateUI"],
});

try {
  const page = context.pages()[0] ?? (await context.newPage());
  for (const url of urls) {
    console.log(`[static-cache] warming ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e: any) => {
      console.warn(`[static-cache] goto failed for ${url}: ${e?.message || e}`);
    });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => { });
    await page.evaluate(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch { /* intentional */ }
    }).catch(() => { });
    await page.context().clearCookies().catch(() => { });
  }
} finally {
  await context.close().catch(() => { });
    void sanitizeStaticCacheProfile(userDataDir);
}

console.log(`[static-cache] warmed static cache at ${userDataDir}`);