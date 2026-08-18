/**
 * PROFILES BARREL
 * Re-exports all profile modules for organized access.
 *
 * Usage:
 *   import { generateUAProfile } from "./profiles/index.js";
 *   import { buildHardwareProfile } from "./profiles/index.js";
 */

// User-Agent profile generation
export {
  generateUAProfile,
  generateUAProfileForEmail,
  getUAProfileForOs,
} from "../profile-useragent.js";
export type { UAProfile } from "../profile-useragent.js";

// Hardware, screen, font profiles
export {
  buildHardwareProfile,
  generateHardwareForEmail,
} from "../profile-determinism.js";
export type { HardwareProfile, GpuProfile } from "../profile-determinism.js";

export {
  selectFontProfile,
} from "../profile-fonts.js";
export type { FontProfile } from "../profile-fonts.js";

export {
  resolveScreenProfile,
} from "../profile-resolution.js";

// Geo alignment
export {
  alignGeoToProxy,
  buildGeoProfile,
} from "../profile-geo-alignment.js";
export type { GeoProfile } from "../profile-geo-alignment.js";

// Cache profile
export {
  generateCacheProfile,
  getCacheInjectionScript,
} from "../profile-cache.js";
export type { CacheProfile } from "../profile-cache.js";

// Extensions
export {
  buildExtensionProfile,
} from "../profile-extensions.js";
export type { ExtensionProfile } from "../profile-extensions.js";

// Interaction patterns
export {
  buildInteractionProfile,
} from "../profile-interaction.js";
export type { InteractionProfile } from "../profile-interaction.js";

// Credential noise
export {
  applyCredentialNoise,
} from "../profile-credential-noise.js";

// Metrics
export {
  profileMetrics,
} from "../profile-metrics.js";

// Validator
export {
  verifyFingerprintCoherence,
} from "../profile-validator.js";
