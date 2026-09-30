import { AsyncLocalStorage } from "node:async_hooks";

/*
  The workspace (org) scope. Which workspace a piece of work belongs to rides an
  AsyncLocalStorage, entered at the edges (an authenticated request, a queue job adopting its
  row's org, a boot path that is org 1 by definition, a desktop connector that serves one
  workspace). It lives here, with no database behind it, because the browser code scopes its
  work by it and must load where there is no database at all.
*/

export type OrgScope = { orgId: number } | { system: true };
const orgAls = new AsyncLocalStorage<OrgScope>();

/** Run fn with every tenant query scoped to this workspace. */
export function withOrg<T>(orgId: number, fn: () => T): T {
  return orgAls.run({ orgId }, fn);
}
/** Cross-workspace maintenance scope: tenant queries still throw; only *All variants work. */
export function systemScope<T>(fn: () => T): T {
  return orgAls.run({ system: true }, fn);
}
export function currentOrgId(): number | undefined {
  const sc = orgAls.getStore();
  return sc && "orgId" in sc ? sc.orgId : undefined;
}
/** Test-only: scope the rest of the current async context (node --test files run top-level). */
export function enterOrgScope(orgId: number): void {
  orgAls.enterWith({ orgId });
}
/** The raw scope, for the data layer's fail-closed check. */
export function scopeStore(): OrgScope | undefined {
  return orgAls.getStore();
}
