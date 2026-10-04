// Allocator versions and the ONE version-aware rule for which template a
// planned job sends (V2-06A). Dependency-free so the resolver, the send
// path, previews and tests share exactly the same precedence.
//
//  v1 (historical; every plan before V2-06): a route is one (number,
//     template) pair. Precedence: the route's frozen template, then the
//     job's own template as a fallback. Unchanged.
//  v2: a route is one sender LANE (one number, shared budget) that can carry
//     several templates; the allocator froze each recipient's template in
//     campaign_allocations.template_id and execute copied it onto the job.
//     Precedence: the job's frozen template first, the lane's default
//     template only as a compatibility fallback.
//
// The plan's allocatorVersion is authoritative. There is deliberately no
// heuristic (e.g. "a job with a templateId must be v2").

export const ALLOCATOR_V1 = "v1";
export const ALLOCATOR_V2 = "v2";
export type AllocatorVersion = typeof ALLOCATOR_V1 | typeof ALLOCATOR_V2;

type PlanLike = { allocatorVersion: string; routes: Array<{ routeId: number; templateId: number | null | undefined }> };

export function effectiveFrozenTemplateId(plan: PlanLike, routeId: number | null | undefined, jobTemplateId: number | null | undefined): number | undefined {
  const routeTemplateId = plan.routes.find((route) => route.routeId === routeId)?.templateId ?? undefined;
  if (plan.allocatorVersion === ALLOCATOR_V2) return jobTemplateId ?? routeTemplateId;
  return routeTemplateId ?? jobTemplateId ?? undefined;
}
