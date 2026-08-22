export type FeatureLabelStatus = "active" | "deprecated";

export type FeatureLabel = {
  readonly id: string;
  readonly projectScopeId: string;
  readonly canonicalName: string;
  readonly status: FeatureLabelStatus;
  readonly redirectsToId: string | null;
  readonly validFromVersion: number;
  readonly validToVersion: number | null;
};

export type FeatureLabelAlias = {
  readonly labelId: string;
  readonly alias: string;
  readonly projectScopeId: string;
  readonly validFromVersion: number;
  readonly validToVersion: number | null;
};

export type LabelRegistry = {
  readonly labels: readonly FeatureLabel[];
  readonly aliases: readonly FeatureLabelAlias[];
};

export type LabelCandidate = {
  readonly kind: "candidate";
  readonly normalised: string;
};

export type ResolvedLabel = {
  readonly kind: "resolved";
  readonly labelId: string;
};

export type LabelResolution = ResolvedLabel | LabelCandidate;
