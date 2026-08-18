import "dotenv/config";
import fetch from "node-fetch";

async function verifySecrets() {
  console.log("=== Verifying Environment Secrets ===");
  let allPass = true;

  // Verify OpenRouter
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
        headers: { "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}` }
      });
      if (res.ok) {
        console.log("✅ OPENROUTER_API_KEY is valid.");
      } else {
        console.error(`❌ OPENROUTER_API_KEY verification failed: ${res.status} ${res.statusText}`);
        allPass = false;
      }
    } catch (e) {
      console.error("❌ OPENROUTER_API_KEY network error:", e);
      allPass = false;
    }
  } else {
    console.log("⚠️ OPENROUTER_API_KEY is not set.");
  }

  // Verify Mistral
  if (process.env.MISTRAL_API_KEY) {
    try {
      const res = await fetch("https://api.mistral.ai/v1/models", {
        headers: { "Authorization": `Bearer ${process.env.MISTRAL_API_KEY}` }
      });
      if (res.ok) {
        console.log("✅ MISTRAL_API_KEY is valid.");
      } else {
        console.error(`❌ MISTRAL_API_KEY verification failed: ${res.status} ${res.statusText}`);
        allPass = false;
      }
    } catch (e) {
      console.error("❌ MISTRAL_API_KEY network error:", e);
      allPass = false;
    }
  } else {
    console.log("⚠️ MISTRAL_API_KEY is not set.");
  }

  // Other keys can be added here (e.g. Gemini, Spider)
  const keysToCheck = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'SPIDER_API_KEY', 'SPIDER_LOCAL_API_KEY', 'PRIMARY_PROXY_URL', 'REDIS_URL'];
  for (const key of keysToCheck) {
      if (!process.env[key]) {
          console.log(`⚠️ ${key} is not set.`);
      } else {
          console.log(`ℹ️ ${key} is set, but no generic verifier exists for it yet.`);
      }
  }

  if (allPass) {
    console.log("\n✅ All tested secrets are valid!");
  } else {
    console.log("\n❌ Some secrets failed validation.");
    process.exit(1);
  }
}

verifySecrets().catch(console.error);
