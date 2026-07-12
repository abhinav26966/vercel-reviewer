import { customAlphabet } from "nanoid";

const nano = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 14);

/**
 * Prefixed-nanoid ids per doc 08 ("All ids are prefixed nanoids (`prj_`, `flw_`…)").
 */
export const ID_PREFIXES = {
  org: "org",
  user: "usr",
  githubInstallation: "ghi",
  project: "prj",
  secret: "sec",
  credentialSet: "crd",
  paymentConfig: "pay",
  flow: "flw",
  flowSpecVersion: "fsv",
  recording: "rec",
  coverageMap: "cov",
  perfBaseline: "pfb",
  deployment: "dep",
  pullRequest: "pull",
  run: "run",
  runFlowResult: "rfr",
  verdict: "vrd",
  alert: "alr",
  verdictReport: "vrp",
  usageEvent: "use",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type PrefixedId<K extends IdKind = IdKind> = `${(typeof ID_PREFIXES)[K]}_${string}`;

export function newId<K extends IdKind>(kind: K): PrefixedId<K> {
  return `${ID_PREFIXES[kind]}_${nano()}` as PrefixedId<K>;
}

export function idKindOf(id: string): IdKind | null {
  const prefix = id.split("_")[0];
  const entry = Object.entries(ID_PREFIXES).find(([, p]) => p === prefix);
  return entry ? (entry[0] as IdKind) : null;
}
