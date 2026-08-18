export type GoldenSite = "joe" | "ignition";

export interface GoldenCredential {
  email: string;
  password: string;
  source: "combined-environment" | "separate-environment";
}

interface EnvironmentLike {
  [key: string]: string | undefined;
}

const SITE_KEYS: Record<GoldenSite, {
  combined: string;
  email: string;
  password: string;
}> = {
  joe: {
    combined: "GOLDEN_CRED_JOE",
    email: "JOE_EMAIL",
    password: "JOE_PASSWORD",
  },
  ignition: {
    combined: "GOLDEN_CRED_IGNITION",
    email: "IGNITION_EMAIL",
    password: "IGNITION_PASSWORD",
  },
};

function required(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function loadPrivateGoldenCredential(
  site: GoldenSite,
  environment: EnvironmentLike = process.env,
): GoldenCredential {
  const keys = SITE_KEYS[site];
  const combined = required(environment[keys.combined]);
  if (combined) {
    const delimiter = combined.indexOf(":");
    if (delimiter <= 0 || delimiter === combined.length - 1) {
      throw new Error(`invalid-private-golden-credential-format:${site}`);
    }
    return {
      email: combined.slice(0, delimiter),
      password: combined.slice(delimiter + 1),
      source: "combined-environment",
    };
  }

  const email = required(environment[keys.email]);
  const password = required(environment[keys.password]);
  if (!email || !password) {
    throw new Error(`private-golden-credential-unavailable:${site}`);
  }
  return { email, password, source: "separate-environment" };
}
