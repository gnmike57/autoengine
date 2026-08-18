export interface SiteConfig {
  name: string;
  url: string;
  fallbackUrls?: string[];
  verifyUrl?: string;
  apiLoginEndpoint?: string;
  legacyApiEndpoints?: string[];
  apiPayloadFormat?: "json" | "form";
  selectors: {
    username: string;
    password: string;
    submit: string;
  };
}

export const TargetJoeFortune: SiteConfig = {
  name: "joe",
  url: "https://www.joefortune.zone/login",
  fallbackUrls: ["https://www.joefortune.ooo/login"],
  verifyUrl: "/account/cashier/deposit/cc",
  selectors: {
    username: "#username",
    password: "#password",
    submit: "button[type='submit']",
  },
};

export const TargetIgnition: SiteConfig = {
  name: "ignition",
  url: "https://www.ignitioncasino.ooo/login",
  fallbackUrls: ["https://www.ignitioncasino.eu/login"],
  verifyUrl: "/account/cashier/deposit/cc",
  selectors: {
    username: "#username",
    password: "#password",
    submit: "#loginSubmit",
  },
};

export const DEFAULT_TARGETS: SiteConfig[] = [TargetJoeFortune, TargetIgnition];
