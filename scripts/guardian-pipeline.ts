import { FingerprintRotationEngine } from "../src/stealth/fingerprint-rotation-engine.js";
import { ConfigStore } from "../src/core/config-store.js";
import { checkAiFingerprint } from "../backends/index.js";
import { getConsistentUserAgent } from "../src/profiles/profile-useragent.js";
import { getConsistentHardware } from "../src/profiles/profile-determinism.js";
import { getFontProfile } from "../src/profiles/profile-fonts.js";
import { getCacheProfile } from "../src/profiles/profile-cache.js";
import { alignGeoToProxy } from "../src/profiles/profile-geo-alignment.js";
import { buildStealthScripts } from "../src/stealth/stealth-scripts.js";

async function main() {
  console.log("=== Guardian Candidate Pipeline ===\n");
  
  const email = "guardian-test@example.com";
  const proxyStr = "http://192.0.2.1:8080";
  const appConfig = ConfigStore.load();
  
  // 1. Generate Deterministic Bundle
  console.log("[1] Generating Deterministic Profile Bundle...");
  const engine = new FingerprintRotationEngine({ ledgerPath: "guardian_test_db.json" });
  const rotationIndex = engine.getRotation(email);
  
  const uaProfile = getConsistentUserAgent(email, "windows", "default", "firefox", rotationIndex);
  if (!uaProfile) throw new Error("Could not generate UA profile");
  const hardwareProfile = getConsistentHardware(email, uaProfile.os, rotationIndex, "default");
  const fontProfile = getFontProfile(email);
  const cacheProfile = getCacheProfile(email, uaProfile.chromeMajor);
  const geoProfile = alignGeoToProxy(proxyStr, "AU");
  
  console.log(`Expected CPU Cores: ${hardwareProfile.cores}`);
  console.log(`Expected Memory: ${hardwareProfile.memory}GB\n`);

  // 2. Generate Injected Runtime Scripts
  console.log("[2] Building Injected Stealth Scripts Preview...");
  const stealthScripts = buildStealthScripts({
    uaProfile,
    hardwareProfile, // MUST be passed down to resolve drift
    fingerprintSeed: 12345,
    sessionCount: rotationIndex,
    backendType: "zendriver",
    fpStrategy: "optimal",
  });
  
  // 3. Simple regex parse of the generated injected runtime script
  let injectedCores: number | null = null;
  let injectedMemory: number | null = null;
  
  for (const script of stealthScripts) {
    if (script.includes("hardwareConcurrency") && !script.includes("navigator.hardwareConcurrency < 2")) {
      const match = script.match(/return\s+(\d+)\s*;/);
      if (match && match[1]) {
        injectedCores = parseInt(match[1]);
      }
    }
    if (script.includes("deviceMemory") && !script.includes("navigator.deviceMemory < 4")) {
      const match = script.match(/return\s+(\d+)\s*;/);
      if (match && match[1]) {
        injectedMemory = parseInt(match[1]);
      }
    }
  }
  
  console.log(`Injected CPU Cores: ${injectedCores}`);
  console.log(`Injected Memory: ${injectedMemory}\n`);
  
  // 4. Drift Check
  console.log("[3] Verifying Drift resolution...");
  if (hardwareProfile.cores !== injectedCores || hardwareProfile.memory !== injectedMemory) {
    console.error("❌ DRIFT DETECTED! hardwareProfile and injected script do not match.");
    process.exit(1);
  } else {
    console.log("✅ Drift resolved! Hardware parameters are coherent.");
  }
  
  // 5. AI Validation Gate (Dry run)
  console.log("\n[4] Running Candidate through AI Verifier Gate...");
  try {
    await checkAiFingerprint({ liveTest: false }, {
      email,
      uaProfile,
      hardwareProfile,
      geoProfile,
      fontProfile,
      cacheProfile,
      proxyServerStr: proxyStr
    });
    console.log("✅ AI Verification Passed!");
  } catch (err: any) {
    console.error(`❌ AI Verification Failed: ${err.message}`);
    process.exit(1);
  }
}

main().catch(console.error);
