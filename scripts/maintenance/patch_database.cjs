const fs = require('fs');
const targetPath = '/Volumes/Macintosh_HD/Users/user294545/Desktop/automati1-111-pORT-main/src/core/database.ts';
let content = fs.readFileSync(targetPath, 'utf8');

const importStmt = `import { enforceVisualLock } from "../intelligence/vision-lock.js";\n`;
if (!content.includes('enforceVisualLock')) {
    content = importStmt + content;
}

const targetBlock = `  pushToWriteQueue(() => {`;
const replaceBlock = `
  // [VISUAL LOCK INTERCEPT]
  const TERMINAL_STATES = ["success", "permanently", "temporarily", "noaccount"];
  if (TERMINAL_STATES.includes(outcome) && finalScreenshotUrl) {
       const absoluteImagePath = require('path').resolve(process.cwd(), finalScreenshotUrl);
       // Enforce lock! (Awaiting since we made this async)
       const confirmed = await enforceVisualLock(absoluteImagePath, outcome);
       if (!confirmed) {
           console.error(\`[Visual Lock] ABORTING database commit for \${email}. Vision model rejected '\${outcome}'. Downgrading to 'incorrect'.\`);
           outcome = "incorrect"; 
       }
  }

  pushToWriteQueue(() => {`;

content = content.replace(targetBlock, replaceBlock);
fs.writeFileSync(targetPath, content);
console.log("Patched database.ts with visual lock");
