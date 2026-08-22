export type ScopeKind = "global" | "project" | "workstream" | "phase";

export type Scope = {
  readonly id: string;
  readonly kind: ScopeKind;
  readonly parentId: string | null;
  readonly name: string;
  readonly path: string;
  readonly depth: number;
};

export const LEGAL_PARENT_KIND: { readonly [K in Exclude<ScopeKind, "global">]: ScopeKind } = {
  project: "global",
  workstream: "project",
  phase: "workstream",
};
