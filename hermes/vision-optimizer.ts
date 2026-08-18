import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || ''
});

/**
 * AI Vision Optimizer CLI
 * 
 * Usage: npx tsx hermes/vision-optimizer.ts [target_file_to_optimize]
 * 
 * This tool scans the hermes/learning/idle_anomalies/ directory for the latest
 * anomaly (screenshot + DOM dump), analyzes it using Gemini Vision, and suggests
 * or applies code adjustments (script improvements & timing improvements) to the target file.
 */

async function main() {
  console.log("🚀 Starting Hermes Vision Optimizer...");

  if (!process.env.GEMINI_API_KEY) {
    console.error("❌ GEMINI_API_KEY environment variable is required.");
    process.exit(1);
  }

  const targetFile = process.argv[2] || 'engine.ts';
  const targetFilePath = path.resolve(process.cwd(), targetFile);

  if (!fs.existsSync(targetFilePath)) {
    console.error(`❌ Target file not found: ${targetFilePath}`);
    process.exit(1);
  }

  const anomaliesDir = path.join(process.cwd(), 'hermes/learning/idle_anomalies');
  if (!fs.existsSync(anomaliesDir)) {
    console.error(`❌ Anomalies directory not found: ${anomaliesDir}`);
    process.exit(1);
  }

  // Find the most recent anomaly (JPEG + HTML pair)
  const files = fs.readdirSync(anomaliesDir);
  const jpegs = files.filter(f => f.endsWith('.jpeg')).sort((a, b) => {
    return fs.statSync(path.join(anomaliesDir, b)).mtimeMs - fs.statSync(path.join(anomaliesDir, a)).mtimeMs;
  });

  if (jpegs.length === 0) {
    console.log("✅ No idle anomalies found. Everything looks perfect.");
    process.exit(0);
  }

  const latestJpeg = jpegs[0];
  const baseName = latestJpeg.replace('.jpeg', '');
  const htmlFile = `${baseName}.html`;

  const imgPath = path.join(anomaliesDir, latestJpeg);
  const htmlPath = path.join(anomaliesDir, htmlFile);

  console.log(`🔍 Analyzing latest anomaly: ${baseName}`);

  // Load context
  const sourceCode = fs.readFileSync(targetFilePath, 'utf8');
  const domDump = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : 'DOM dump not available';

  // Read image as base64 for Gemini
  const imgBuffer = fs.readFileSync(imgPath);

  console.log("🧠 Sending context to Gemini Vision API for Agentic code optimization...");

  const prompt = `You are Hermes, an advanced AI automation engineer.
I am providing you with:
1. A screenshot of a web page where the automation script hung or idled unexpectedly.
2. The raw HTML DOM dump of that exact moment.
3. The source code of the automation script (${targetFile}).

Your task is to act as an advanced Vision-Driven Script Improver:
- Analyze the screenshot to understand what the user is seeing visually (e.g. is there a CAPTCHA, a popup, a loading spinner, or did the page change layout?).
- Identify where the script (${targetFile}) is getting stuck. Usually this is due to a bad CSS selector, a static sleep() call, or an unhandled UI state.
- Suggest a concrete code patch to solve this issue.
- Focus specifically on Timing Improvements: replace blind sleeps with dynamic visual/DOM waits.
- Provide the exact line numbers and the modified code block to apply to ${targetFile}.

Output your response in Markdown. Include a \`\`\`typescript block with the exact patched function.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: 'image/jpeg', data: imgBuffer.toString('base64') } },
            { text: `\n\n--- DOM DUMP ---\n${domDump.substring(0, 50000)}` }, // truncate to fit limits
            { text: `\n\n--- TARGET SCRIPT (${targetFile}) ---\n${sourceCode.substring(0, 100000)}` }
          ]
        }
      ]
    });

    const report = response.text || "No report generated";

    const reportPath = path.join(process.cwd(), `hermes/reports/vision-opt-${baseName}.md`);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, report);

    console.log(`✅ Vision analysis complete! Generated script improvement patch:`);
    console.log(`👉 ${reportPath}`);
    console.log(`\nReview the report and apply the suggested AI timing and logic improvements to ${targetFile}.`);

  } catch (error) {
    console.error("❌ Failed to communicate with Gemini:", error);
  }
}

main();
