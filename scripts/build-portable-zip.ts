import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';

// Initialize adm-zip
const zip = new AdmZip();

const rootDir = path.resolve(process.cwd());
const outputZipName = 'automati1-111-portable.zip';
const outputPath = path.join(rootDir, outputZipName);

console.log('Building portable ZIP...');

// Files and directories to explicitly exclude
const exclusions = [
    'node_modules',
    '.git',
    '.venv',
    '.idea',
    '.vscode',
    'test-results',
    'playwright-report',
    'recordings',
    'screenshots',
    'tile-screenshots',
    'backups',
    '.cloak-profiles',
    '.chrome-dashboard',
    'permdisabled',
    'logs',
    'automati1-111-portable.zip',
    '.env' // EXCLUDE the actual .env, but we'll include .env.example
];

// File extensions to exclude (e.g. databases)
const excludedExtensions = ['.db', '.db-wal', '.db-shm'];

function shouldExclude(itemPath: string): boolean {
    const basename = path.basename(itemPath);
    if (exclusions.includes(basename)) {
        return true;
    }
    const ext = path.extname(basename);
    if (excludedExtensions.includes(ext)) {
        return true;
    }
    return false;
}

function addDirectoryToZip(dirPath: string, zipPath: string) {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
        const fullPath = path.join(dirPath, item);
        if (shouldExclude(fullPath)) {
            console.log(`Skipping: ${fullPath}`);
            continue;
        }

        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            addDirectoryToZip(fullPath, path.posix.join(zipPath, item));
        } else {
            zip.addLocalFile(fullPath, zipPath);
        }
    }
}

// Start adding everything from root
addDirectoryToZip(rootDir, '');

console.log('Writing ZIP file... This may take a moment depending on the size.');
zip.writeZip(outputPath);
console.log(`✅ Successfully created portable ZIP at: ${outputPath}`);
