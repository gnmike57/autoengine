import fs from 'node:fs';
import path from 'node:path';
import { FingerprintGenerator } from 'fingerprint-generator';

const ANDROID_DEVICES = [
  {
    model: "SM-S928B", androidVersion: "14",
    screen: { width: 1440, height: 3120, pixelRatio: 3.5 }, deviceMemory: 8,
    webgl: { vendor: "ARM", renderer: "Mali-G715 Immortalis MC11" },
    battery: { charging: false, level: 0.72 },
    connection: { type: "5g", downlink: 150, rtt: 30 },
  },
  {
    model: "SM-S918B", androidVersion: "13",
    screen: { width: 1440, height: 3088, pixelRatio: 3.5 }, deviceMemory: 8,
    webgl: { vendor: "ARM", renderer: "Mali-G710 MC10" },
    battery: { charging: true, level: 0.88 },
    connection: { type: "5g", downlink: 140, rtt: 28 },
  },
  {
    model: "Pixel 8 Pro", androidVersion: "14",
    screen: { width: 1344, height: 2992, pixelRatio: 3.0 }, deviceMemory: 8,
    webgl: { vendor: "ARM", renderer: "Mali-G715 MC10" },
    battery: { charging: false, level: 0.55 },
    connection: { type: "5g", downlink: 130, rtt: 32 },
  },
];

function generatePoolForEngine(engine: 'chrome' | 'firefox', outputFile: string) {
  console.log(`[generate-ua-pool] Generating ${engine} fingerprints...`);
  const pool: any[] = [];
  const seen = new Set<string>();
  const generator = new FingerprintGenerator();
  const count = 1000;
  
  for (let i = 0; i < count; i++) {
    const fpWrapper = generator.getFingerprint({
      browsers: [engine],
      operatingSystems: ['windows', 'macos', 'linux', 'android'],
      screen: {
        minWidth: 1280,
        minHeight: 720,
        maxWidth: 3840,
        maxHeight: 2160
      }
    });
    const fp = fpWrapper.fingerprint;
    const nav = fp.navigator;
    
    let browserMajor = 130;
    if (engine === 'chrome') {
      const match = nav.userAgent.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
      const ver = match ? match[1]! : "130.0.0.0";
      browserMajor = parseInt(ver.split('.')[0]!, 10);
    } else {
      const match = nav.userAgent.match(/Firefox\/(\d+\.\d+)/);
      const ver = match ? match[1]! : "128.0";
      browserMajor = parseInt(ver.split('.')[0]!, 10);
    }
    
    let os: "windows" | "macos" | "linux" | "android" = "windows";
    let windowsLabel: string = "Win10";
    let platformVersion = nav.userAgentData?.platformVersion || "10.0.0";
    let architecture: "x64" | "arm64" = (nav.userAgentData?.architecture === "arm") ? "arm64" : "x64";
    
    const uaLower = nav.userAgent.toLowerCase();
    
    if (uaLower.includes("android")) {
      os = "android";
      windowsLabel = "Android";
      architecture = "arm64";
    } else if (uaLower.includes("mac os x")) {
      os = "macos";
      windowsLabel = architecture === "arm64" ? "macOS Apple Silicon" : "macOS Intel";
      const macMatch = nav.userAgent.match(/Mac OS X (\d+_\d+(_\d+)?)/);
      if (macMatch) platformVersion = macMatch[1]!.replace(/_/g, '.');
    } else if (uaLower.includes("linux")) {
      os = "linux";
      windowsLabel = "Linux";
      architecture = "x64";
    } else {
      os = "windows";
      const pvNum = parseInt(platformVersion.split('.')[0] || "10", 10);
      windowsLabel = pvNum >= 13 ? "Win11" : "Win10"; 
      architecture = "x64";
    }

    // --- CRITICAL FIX: Eliminate Fingerprint-Generator Frankenstein Anomalies ---
    // 1. Force Apple Silicon / Intel Mac alignment
    if (os === "macos") {
      if (architecture === "arm64") {
        fp.navigator.userAgent = fp.navigator.userAgent.replace("Intel Mac OS X", "Macintosh; ARM Mac OS X"); // Force UA alignment
        if (!fp.videoCard.renderer.includes("Apple")) {
          fp.videoCard.renderer = "Apple M1";
          fp.videoCard.vendor = "Apple";
        }
      } else {
        if (fp.videoCard.renderer.includes("Apple")) {
          fp.videoCard.renderer = "Intel Iris Pro Graphics 580";
          fp.videoCard.vendor = "Intel Inc.";
        }
      }
    }
    // 2. Force Linux architecture alignment
    if (os === "linux") {
      if (architecture === "x64") {
        fp.navigator.platform = "Linux x86_64";
        if (fp.videoCard.renderer.includes("Mali") || fp.videoCard.renderer.includes("Adreno")) {
          fp.videoCard.renderer = "Mesa DRI Intel(R) UHD Graphics 620";
        }
      }
    }
    
    // Fix innerWidth > screen.width anomaly (very common bug in fpGen)
    if (fp.screen.innerWidth > fp.screen.width) fp.screen.innerWidth = fp.screen.width;
    if (fp.screen.innerHeight > fp.screen.height) fp.screen.innerHeight = fp.screen.height;
    if (fp.screen.clientWidth > fp.screen.width) fp.screen.clientWidth = fp.screen.width;
    if (fp.screen.clientHeight > fp.screen.height) fp.screen.clientHeight = fp.screen.height;
    
    const entry: any = {
      ua: nav.userAgent,
      chromeVersion: engine === 'chrome' ? nav.userAgent.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/)?.[1] || "130.0.0.0" : browserMajor.toString() + ".0",
      chromeMajor: browserMajor,
      windowsVersion: platformVersion,
      windowsLabel,
      os,
      platformVersion,
      architecture,
      isBot: false,
      locale: "en-AU",
      country: "AU"
    };
    
    if (os === "android") {
      const device = ANDROID_DEVICES[Math.floor(Math.random() * ANDROID_DEVICES.length)]!;
      
      entry.ua = entry.ua.replace(/\(Linux; Android [^;)]*(;?[^)]*)\)/, `(Linux; Android ${device.androidVersion}; ${device.model})`);
      entry.windowsVersion = device.androidVersion;
      entry.platformVersion = device.androidVersion;
      
      entry.mobile = true;
      entry.deviceModel = device.model;
      entry.deviceMemory = device.deviceMemory;
      entry.screen = device.screen;
      entry.touchSupport = true;
      entry.webgl = device.webgl;
      entry.battery = device.battery;
      entry.connection = device.connection;
      
      fpWrapper.fingerprint.navigator.userAgent = entry.ua;
      if (fpWrapper.fingerprint.navigator.userAgentData) {
        fpWrapper.fingerprint.navigator.userAgentData.model = device.model;
        fpWrapper.fingerprint.navigator.userAgentData.platformVersion = device.androidVersion + ".0.0";
      }
      fpWrapper.headers["user-agent"] = entry.ua;
      fpWrapper.headers["sec-ch-ua-platform-version"] = `"${device.androidVersion}.0.0"`;
      fpWrapper.headers["sec-ch-ua-model"] = `"${device.model}"`;
      
      (fpWrapper.fingerprint as any).deviceMemory = device.deviceMemory;
      fpWrapper.fingerprint.videoCard = device.webgl;
      (fpWrapper.fingerprint as any).battery = { charging: device.battery.charging, chargingTime: 0, dischargingTime: null as any, level: device.battery.level as any };
      fpWrapper.fingerprint.screen = {
         ...fpWrapper.fingerprint.screen,
         width: device.screen.width,
         height: device.screen.height,
         availWidth: device.screen.width,
         availHeight: device.screen.height,
         devicePixelRatio: device.screen.pixelRatio
      };
    }
    
    entry.apifyFingerprint = fpWrapper;
    
    const k = `${entry.ua}|${entry.windowsLabel}|${entry.architecture}|${entry.mobile ? "m" : "d"}|${entry.deviceModel ?? ""}`;
    if (!seen.has(k)) {
      seen.add(k);
      pool.push(entry);
    }
  }

  const out = {
    source: `fingerprint-generator-full-payload-${engine}`,
    fetchedAt: new Date().toISOString(),
    count: pool.length,
    pool: pool,
  };
  
  const outPath = path.join(process.cwd(), "data", outputFile);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`[generate-ua-pool] Wrote ${pool.length} ${engine} entries → ${path.relative(process.cwd(), outPath)}`);
}

async function main() {
  await generatePoolForEngine('chrome', 'ua-pool-chrome.json');
  await generatePoolForEngine('firefox', 'ua-pool-firefox.json');
}

main().catch((e) => {
  console.error(`[generate-ua-pool] ${e.stack || e.message || e}`);
  process.exit(1);
});