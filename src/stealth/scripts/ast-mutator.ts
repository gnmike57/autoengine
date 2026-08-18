/**
 * MutationClaw - Runtime Payload Polymorphism
 *
 * Mutates JavaScript init scripts at runtime to evade signature-based detection.
 * Designed to be extremely fast (< 2ms per script) while fundamentally altering
 * the byte signature and structural hashes of the payload.
 */

export function mutatePayload(script: string, seed: number): string {
  if (!script || typeof script !== "string") return script;

  // 1. Deterministic PRNG based on seed
  let randSeed = seed;
  function rand() {
    randSeed = (randSeed * 16807) % 2147483647;
    return randSeed / 2147483647;
  }

  // 2. Variable Renaming Map
  // Safely aliases common internal variables used across our stealth scripts
  const prefix = "m" + Math.floor(rand() * 10000).toString(16) + "_";
  const renames: Record<string, string> = {
    origDesc: prefix + "od",
    origExecute: prefix + "oe",
    origMatchMedia: prefix + "omm",
    origInnerWidthDesc: prefix + "oiwd",
    batteryData: prefix + "bd",
    connData: prefix + "cd",
    memData: prefix + "md",
    noiseX: prefix + "nx",
    noiseY: prefix + "ny",
    behavioralScore: prefix + "bs",
    lastMouseX: prefix + "lmx",
    lastMouseY: prefix + "lmy",
    frameCount: prefix + "fc",
  };

  let mutated = script;

  // Apply renames
  for (const [original, replacement] of Object.entries(renames)) {
    // Word boundary regex ensures we only replace exact variable names
    const regex = new RegExp(`\\b${original}\\b`, "g");
    mutated = mutated.replace(regex, replacement);
  }

  // 3. No-Op Injection
  // Inject random no-op variable declarations at the start of try blocks
  if (rand() > 0.3) {
    const noOp = `var _n${Math.floor(rand() * 1000)} = ${Math.floor(rand() * 9999)};`;
    mutated = mutated.replace(/try\s*\{/, `try { ${noOp}`);
  }

  // 4. Structural Whitespace Shifting
  // Replace some newlines with spaces to change line counts and file hashes
  if (rand() > 0.5) {
    mutated = mutated.replace(/;\n\s+/g, "; ");
  }

  // 5. Keyword Shuffling
  // Swap standard function declarations with anonymous assigned functions where safe
  // (We skip this for now as it requires complex AST validation, relying on renames instead)

  return mutated;
}
