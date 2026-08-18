
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SHIELD_ID = 'jghionbmdfkaoncohbmlpjckeikoadjg';

function patchPreferences(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    
    let changed = false;

    // 1. Activate Developer Mode
    if (!data.extensions) data.extensions = {};
    if (!data.extensions.ui) data.extensions.ui = {};
    if (data.extensions.ui.developer_mode !== true) {
      data.extensions.ui.developer_mode = true;
      changed = true;
    }

    // 2. Activate for Incognito
    if (!data.extensions.settings) data.extensions.settings = {};
    if (!data.extensions.settings[SHIELD_ID]) {
      data.extensions.settings[SHIELD_ID] = {};
    }
    if (data.extensions.settings[SHIELD_ID].incognito_enabled !== true) {
      data.extensions.settings[SHIELD_ID].incognito_enabled = true;
      changed = true;
    }

    // 3. Pin the extension
    // Chrome stores this in two possible places depending on version
    const pinPaths = [
      ['extensions', 'pinned_extensions'],
      ['pinned_extensions']
    ];

    for (const p of pinPaths) {
      let target = data;
      for (let i = 0; i < p.length - 1; i++) {
        if (!target[p[i]!]) target[p[i]!] = {};
        target = target[p[i]!];
      }
      const lastKey = p[p.length - 1]!;
      if (!Array.isArray(target[lastKey])) {
        target[lastKey] = [];
      }
      if (!target[lastKey].includes(SHIELD_ID)) {
        target[lastKey].push(SHIELD_ID);
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      console.log(`✅ Patched & Pinned: ${filePath}`);
    } else {
      console.log(`ℹ️ Already correct: ${filePath}`);
    }
  } catch (e: unknown) {
    console.error(`❌ Failed to patch ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  const targets: string[] = [];

  // System Chrome
  const chromePrefs = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Default/Preferences');
  if (fs.existsSync(chromePrefs)) targets.push(chromePrefs);

  // Automated profiles
  const cloakProfilesDir = './cloak-profiles';
  if (fs.existsSync(cloakProfilesDir)) {
    const findPreferences = async (dir: string) => {
      const files = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const file of files) {
        const fullPath = path.join(dir, file.name);
        if (file.isDirectory()) {
          await findPreferences(fullPath);
        } else if (file.name === 'Preferences') {
          targets.push(fullPath);
        }
      }
    };
    await findPreferences(cloakProfilesDir);
  }

  console.log(`Checking ${targets.length} Preference files...`);
  for (const target of targets) {
    await patchPreferences(target);
  }
}

void main();