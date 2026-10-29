import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { PolicyInput, PolicyEditInput, Template, FilterRule, FilterRuleInput, AccessProfileInput, PostureCheckInput, AutomationInput, AutomationTestResult, AutomationRunResult, DryRunResult, TidyNamesPlan, TidyNamesResult, CreateProxyServiceInput, ExposeDockerInput, UpdateProxyServiceInput, BlocklistInput, BulkBlocklistInput, BulkBlocklistResult, BlockedMatchesResult, EnforceBlocklistResult, MatchingEventsResult, TelegramInput, SmtpConfigInput, ApproverConfigInput, AutoApprovalConfigInput, FeaturePermsConfig, RecurringAccessInput, EdrAutoBypassConfig, SecurityConfig, GrantTarget, TemporaryAccessGrantInput, ExtendGrantInput, CreateAccessRequestInput, CreateAccessRequestResult, ApplyTenantDefaultsResult, AutoConfigureNbResult, TenantDefaultsProfile, NetbirdNbSettings, NetbirdSettingsResponse, MspDigestConfig, MspDigestSendResult, InternalBackupConfig, InternalBackupRunResult, InternalBackupRestoreResult, InviteUserInput, InviteDefaultGroups, NbUser, SetupKeyResult, CreateSetupKeyInput, TrafficPullStatus, AuditPullStatus } from './types';

export interface ResourcePayload {
  name: string;
  address: string;
  description?: string;
  groups: string[];
  policies?: PolicyInput[]; // omitted on edit when unchanged - the server then leaves the policies alone
  /** Preserved on edit so saving a disabled resource doesn't silently re-enable it. */
  enabled?: boolean;
}

// Enable / disable a resource (the dashboard's Disable action).
export function useToggleResource(networkId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ rid, enabled }: { rid: string; enabled: boolean }) =>
      api.post(`/api/networks/${encodeURIComponent(networkId)}/resources/${encodeURIComponent(rid)}/enabled`, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['network-detail', networkId] });
      qc.invalidateQueries({ queryKey: ['networks'] });
    },
  });
}

export function useSaveResource(networkId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ rid, payload }: { rid?: string; payload: ResourcePayload }) =>
      rid
        ? api.put(`/api/networks/${encodeURIComponent(networkId)}/resources/${encodeURIComponent(rid)}`, payload)
        : api.post(`/api/networks/${encodeURIComponent(networkId)}/resources`, payload),
    // onSettled: a partial save (resource saved, policies refused) still changed the resource.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['network-detail', networkId] });
      qc.invalidateQueries({ queryKey: ['networks'] });
      qc.invalidateQueries({ queryKey: ['access-profiles'] });
    },
  });
}

export function useDeleteResource(networkId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rid: string) => api.del(`/api/networks/${encodeURIComponent(networkId)}/resources/${encodeURIComponent(rid)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['network-detail', networkId] });
      qc.invalidateQueries({ queryKey: ['networks'] });
      qc.invalidateQueries({ queryKey: ['access-profiles'] });
    },
  });
}

export interface BulkDeleteResult { deleted: number; failed: { id: string; error: string }[] }

export function useBulkDeleteResources(networkId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      api.post<BulkDeleteResult>(`/api/networks/${encodeURIComponent(networkId)}/resources/bulk-delete`, { ids }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['network-detail', networkId] });
      qc.invalidateQueries({ queryKey: ['networks'] });
      qc.invalidateQueries({ queryKey: ['access-profiles'] });
    },
  });
}

export interface MoveResourcesResult { moved: string[]; failed: { id: string; name: string; error: string }[]; targetNetworkName: string }
export function useMoveResources(networkId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, targetNetworkId }: { ids: string[]; targetNetworkId: string }) =>
      api.post<MoveResourcesResult>(`/api/networks/${encodeURIComponent(networkId)}/resources/move`, { ids, targetNetworkId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['network-detail'] });
      qc.invalidateQueries({ queryKey: ['networks'] });
      qc.invalidateQueries({ queryKey: ['access-profiles'] });
      qc.invalidateQueries({ queryKey: ['resource-conflicts'] });
    },
  });
}

export interface MergeResourcesResult { keptId: string; keptName: string; movedPolicies: number; deleted: string[] }
export function useMergeResources(networkId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, keepId }: { ids: string[]; keepId: string }) =>
      api.post<MergeResourcesResult>(`/api/networks/${encodeURIComponent(networkId)}/resources/merge`, { ids, keepId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['network-detail', networkId] });
      qc.invalidateQueries({ queryKey: ['networks'] });
      qc.invalidateQueries({ queryKey: ['access-profiles'] });
      qc.invalidateQueries({ queryKey: ['resource-conflicts'] });
    },
  });
}

export function useCreateNetwork() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { name: string; description?: string }) => api.post<{ id: string }>('/api/networks', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['networks'] }),
  });
}

// Rename/re-describe a network; allowDuplicates toggles the app's duplicate-address guard.
export function useUpdateNetwork() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...payload }: { id: string; name?: string; description?: string; allowDuplicates?: boolean }) =>
      api.put(`/api/networks/${encodeURIComponent(id)}`, payload),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['networks'] });
      qc.invalidateQueries({ queryKey: ['network-detail', v.id] });
    },
  });
}

export function useDeleteNetwork() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/networks/${encodeURIComponent(id)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['networks'] });
      qc.invalidateQueries({ queryKey: ['network-detail'] });
    },
  });
}

export function useCreateRouter(networkId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { peer?: string; peerGroups?: string[]; metric: number; masquerade: boolean; enabled: boolean }) =>
      api.post(`/api/networks/${encodeURIComponent(networkId)}/routers`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['network-detail', networkId] });
      qc.invalidateQueries({ queryKey: ['networks'] });
    },
  });
}

export function useDeleteRouter(networkId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rid: string) => api.del(`/api/networks/${encodeURIComponent(networkId)}/routers/${encodeURIComponent(rid)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['network-detail', networkId] });
      qc.invalidateQueries({ queryKey: ['networks'] });
    },
  });
}

export function useSaveGrants() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ networkId, grants }: { networkId: string; grants: { id: string; access: 'edit' | 'view' | 'source'; policySource?: boolean }[] }) =>
      api.put(`/api/networks/${encodeURIComponent(networkId)}/grants`, { grants }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['networks'] }),
  });
}

// Per-network default Access Profiles (pre-selected when adding a resource).
export function useSaveNetworkDefaultProfiles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ networkId, profileIds }: { networkId: string; profileIds: number[] }) =>
      api.put(`/api/networks/${encodeURIComponent(networkId)}/default-profiles`, { profileIds }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['network-default-profiles'] });
      qc.invalidateQueries({ queryKey: ['policy-options'] });
    },
  });
}

export interface TemplatePayload { name: string; protocol: string; ports: string[]; description?: string }

export function useSaveTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id?: Template['id']; payload: TemplatePayload }) =>
      id ? api.put(`/api/templates/${id}`, payload) : api.post('/api/templates', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: Template['id']) => api.del(`/api/templates/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  });
}

// ── Access Profiles ──
export function useSaveAccessProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id?: number; payload: AccessProfileInput }) =>
      id ? api.put(`/api/access-profiles/${id}`, payload) : api.post('/api/access-profiles', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['access-profiles'] }),
  });
}

export function useDeleteAccessProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/access-profiles/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['access-profiles'] }),
  });
}

// ── Posture Checks ──
export function useSavePostureCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id?: string; payload: PostureCheckInput }) =>
      id ? api.put(`/api/posture-checks/${encodeURIComponent(id)}`, payload) : api.post('/api/posture-checks', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['posture-checks'] }),
  });
}

export function useDeletePostureCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/posture-checks/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['posture-checks'] }),
  });
}

// ── Automations ──
export function useSaveAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id?: number; payload: AutomationInput }) =>
      id ? api.put(`/api/automations/${id}`, payload) : api.post('/api/automations', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations'] }),
  });
}

export function useDeleteAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/automations/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations'] }),
  });
}

export function useRunAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<AutomationRunResult>(`/api/automations/${id}/run`),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ['automations'] });
      qc.invalidateQueries({ queryKey: ['automation-runs', id] });
      qc.invalidateQueries({ queryKey: ['network-detail'] });
    },
  });
}

export function useTestAutomation() {
  return useMutation({
    mutationFn: ({ id, payload }: { id?: number; payload: AutomationInput }) =>
      api.post<AutomationTestResult>(id ? `/api/automations/${id}/test` : '/api/automations/test', payload),
  });
}

export function useRepairAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<{ removed: number }>(`/api/automations/${id}/repair`),
    onSuccess: (_d, id) => qc.invalidateQueries({ queryKey: ['automation-managed', id] }),
  });
}

export function useForgetAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<{ forgotten: number }>(`/api/automations/${id}/forget`),
    onSuccess: (_d, id) => qc.invalidateQueries({ queryKey: ['automation-managed', id] }),
  });
}

// ── Event filtering rules ──
export function useSaveFilterRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id?: FilterRule['id']; payload: FilterRuleInput }) =>
      id ? api.put(`/api/filter-rules/${id}`, payload) : api.post('/api/filter-rules', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['filter-rules'] }),
  });
}

export function useDeleteFilterRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: FilterRule['id']) => api.del(`/api/filter-rules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['filter-rules'] }),
  });
}

export function useSetBuiltinNoise() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => api.put('/api/filter-rules/settings/builtin-noise', { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['filter-rules'] }),
  });
}

// MSP admin (main account only): REPLACE every tenant's event-filtering rules + built-in noise
// toggle with the main account's current configuration.
export interface PropagateFilterRulesResult { tenants: number; rules: number; errors?: number }
export function usePropagateFilterRules() {
  return useMutation({
    mutationFn: () => api.post<PropagateFilterRulesResult>('/api/filter-rules/propagate', {}),
  });
}

// ── Reverse-proxy service creation ──
export function useCreateProxyService() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateProxyServiceInput) => api.post<{ id: string; domain: string }>('/api/reverse-proxy-services', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reverse-proxy-status'] }),
  });
}
export function useUpdateProxyService() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateProxyServiceInput }) =>
      api.put(`/api/reverse-proxy-services/${encodeURIComponent(id)}`, patch),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['reverse-proxy-status'] });
      qc.invalidateQueries({ queryKey: ['reverse-proxy-service', v.id] });
    },
  });
}
export function useDeleteProxyService() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/reverse-proxy-services/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reverse-proxy-status'] }),
  });
}
export function useExposeDocker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ExposeDockerInput) => api.post<{ service: { id: string; domain: string } }>('/api/reverse-proxy-services/expose-docker', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reverse-proxy-status'] });
      qc.invalidateQueries({ queryKey: ['networks'] });
      qc.invalidateQueries({ queryKey: ['network-detail'] });
    },
  });
}

// ── Tidy policy names (preview + apply, admin) ──
export function useTidyNamesPlan() {
  return useMutation({ mutationFn: () => api.get<TidyNamesPlan>('/api/policies/tidy-names') });
}
export function useApplyTidyNames() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.post<TidyNamesResult>('/api/policies/tidy-names', { ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['policies'] }),
  });
}

// ── Address blocklist ──
export function useSaveBlocklist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id?: number; payload: BlocklistInput }) =>
      id ? api.put(`/api/blocklist/${id}`, payload) : api.post('/api/blocklist', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blocklist'] }),
  });
}

// Bulk add - addresses picked from a network's existing resources; duplicates are skipped.
export function useBulkAddBlocklist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: BulkBlocklistInput) => api.post<BulkBlocklistResult>('/api/blocklist/bulk', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blocklist'] }),
  });
}

export function useDeleteBlocklist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/blocklist/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blocklist'] }),
  });
}

// MSP admin (main account only): REPLACE every tenant's blocklist with the main account's
// current entries. Entries limited to specific networks are skipped (network ids are per-account).
export interface PropagateBlocklistResult { tenants: number; copied: number; skipped: number; errors?: number }
export function usePropagateBlocklist() {
  return useMutation({
    mutationFn: () => api.post<PropagateBlocklistResult>('/api/blocklist/propagate', {}),
  });
}

// Enforce the blocklist on EXISTING resources. Scan finds matches; enforce disables/deletes them.
export function useScanBlockedResources() {
  return useMutation({ mutationFn: () => api.get<BlockedMatchesResult>('/api/blocklist/matching') });
}
export function useEnforceBlocklist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) => api.post<EnforceBlocklistResult>('/api/blocklist/enforce', ids && ids.length ? { ids } : {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['networks'] });
      qc.invalidateQueries({ queryKey: ['network-detail'] });
      qc.invalidateQueries({ queryKey: ['blocklist'] });
    },
  });
}

// ── Temporary access grants ──
export function useCreateGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: TemporaryAccessGrantInput) => api.post<{ id: number; devices: number }>('/api/temporary-access', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['temporary-access-grants'] }),
  });
}
export function useExtendGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: ExtendGrantInput }) => api.put(`/api/temporary-access/${id}`, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['temporary-access-grants'] }),
  });
}
export function useRevokeGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post(`/api/temporary-access/${id}/revoke`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['temporary-access-grants'] }),
  });
}
export function useDeleteGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/temporary-access/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['temporary-access-grants'] }),
  });
}

// ── Access requests ──
export function useCreateAccessRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateAccessRequestInput) => api.post<CreateAccessRequestResult>('/api/access-requests', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-access-requests'] }),
  });
}
export function useSaveAutoApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AutoApprovalConfigInput) => api.put('/api/auto-approval-config', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auto-approval-config'] }),
  });
}
// ── Recurring access rules ──
export function useSaveRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id?: number; payload: RecurringAccessInput }) =>
      id ? api.put(`/api/recurring-access/${id}`, payload) : api.post('/api/recurring-access', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recurring-access'] });
      qc.invalidateQueries({ queryKey: ['temporary-access-grants'] });
    },
  });
}
export function useDeleteRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/recurring-access/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recurring-access'] });
      qc.invalidateQueries({ queryKey: ['temporary-access-grants'] });
    },
  });
}

export function useSaveSecurity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: Partial<SecurityConfig>) => api.put('/api/security-config', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['security-config'] }),
  });
}

// Save the per-account automatic EDR bypass rules. Peers are re-read because the next sync may
// bypass devices right away.
export function useSaveEdrAutoBypass() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: EdrAutoBypassConfig) => api.put<EdrAutoBypassConfig>('/api/edr-auto-bypass', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['edr-auto-bypass'] });
      qc.invalidateQueries({ queryKey: ['peers'] });
    },
  });
}

// Save the per-account data-retention window (days; 0 = keep forever). Tenant-aware endpoint.
export function useSaveRetention() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (days: number) => api.put('/api/data-retention', { days }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['data-retention'] });
      qc.invalidateQueries({ queryKey: ['security-config'] }); // main stores retention in the security blob
    },
  });
}

// Automation dry-run: preview exactly what a sync would do right now (no writes, no cache impact).
export function useDryRunAutomation() {
  return useMutation({
    mutationFn: (id: number) => api.post<DryRunResult>(`/api/automations/${id}/dry-run`, {}),
  });
}

// Device tags & notes (operational metadata, app-side; admin only).
export function useSavePeerMeta() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note, tags }: { id: string; note: string; tags: string[] }) =>
      api.put(`/api/peers/${encodeURIComponent(id)}/meta`, { note, tags }),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ['peers'] });
      qc.invalidateQueries({ queryKey: ['peer-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['peer-tags'] });
    },
  });
}

// Bulk-add tags to many devices (merge - existing tags and notes stay).
export function useBulkTagPeers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, tags }: { ids: string[]; tags: string[] }) =>
      api.post<{ updated: number }>('/api/peers/bulk-tags', { ids, tags }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['peers'] });
      qc.invalidateQueries({ queryKey: ['peer-tags'] });
    },
  });
}

// Access recertification: open a round on demand / decide one item (keep or revoke).
// A revoke performs the actual removal, so the affected caches are invalidated too.
export function useStartRecert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/api/recertification/start', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recertification'] }),
  });
}
export function useCancelRecert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/api/recertification/cancel', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recertification'] }),
  });
}
export function useDecideRecertItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: 'keep' | 'revoke' }) =>
      api.post(`/api/recertification/items/${id}/${decision}`, {}),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ['recertification'] });
      if (vars.decision === 'revoke') {
        qc.invalidateQueries({ queryKey: ['peers'] });
        qc.invalidateQueries({ queryKey: ['feature-permissions'] });
        qc.invalidateQueries({ queryKey: ['auto-approval'] });
        qc.invalidateQueries({ queryKey: ['recurring-access'] });
      }
    },
  });
}

export function useSaveFeaturePerms() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: FeaturePermsConfig) => api.put('/api/feature-permissions', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['feature-permissions'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}
export function useCancelAccessRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post(`/api/access-requests/${id}/cancel`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-access-requests'] });
      qc.invalidateQueries({ queryKey: ['access-requests'] });
    },
  });
}
function invalidateRequestViews(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['access-requests'] });
  qc.invalidateQueries({ queryKey: ['pending-request-count'] });
}
export function useApproveRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: { durationMinutes?: number; expiresAt?: string; targets?: GrantTarget[] } }) =>
      api.post(`/api/access-requests/${id}/approve`, payload),
    onSuccess: () => { invalidateRequestViews(qc); qc.invalidateQueries({ queryKey: ['temporary-access-grants'] }); },
  });
}
export function useDenyRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason?: string }) => api.post(`/api/access-requests/${id}/deny`, { reason }),
    onSuccess: () => invalidateRequestViews(qc),
  });
}

// ── Access-control policies (admin overview page) ──
export function useSavePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id?: string; payload: PolicyEditInput }) =>
      id ? api.put(`/api/policies/${encodeURIComponent(id)}`, payload) : api.post('/api/policies', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['policies'] });
      qc.invalidateQueries({ queryKey: ['groups'] });
      // A policy sourced from a group changes that group's policy count / list (group detail).
      qc.invalidateQueries({ queryKey: ['group-detail'] });
    },
  });
}

export function useDeletePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/policies/${encodeURIComponent(id)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['policies'] });
      qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

// ── Peers ──
export function useDeletePeer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/peers/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['peers'] }),
  });
}

// Remove a compliance (EDR) bypass - the device is blocked again until it passes the checks.
export function useRevokeBypass() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/peers/${encodeURIComponent(id)}/revoke-bypass`),
    onSuccess: (_r, id) => {
      qc.invalidateQueries({ queryKey: ['peers'] });
      qc.invalidateQueries({ queryKey: ['peer-detail', id] });
    },
  });
}

export function useBulkDeletePeers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.post<BulkDeleteResult>('/api/peers/bulk-delete', { ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['peers'] }),
  });
}

// ── Groups ──
export function useDeleteGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/groups/${encodeURIComponent(id)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['groups'] });
      qc.invalidateQueries({ queryKey: ['group-detail'] });
    },
  });
}

export function useBulkDeleteGroups() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      api.post<BulkDeleteResult>('/api/groups/bulk-delete', { ids }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['groups'] });
      qc.invalidateQueries({ queryKey: ['group-detail'] });
    },
  });
}

// Replace a group's PEER membership. The frontend computes the FULL desired peer id list (for both
// add and remove); the server PUTs it to NetBird (which replaces the set). The group detail and the
// groups/peers lists all reflect membership, so all three are invalidated.
export function useSetGroupPeers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, peers }: { id: string; peers: string[] }) =>
      api.post<{ ok: boolean; name: string; count: number }>(`/api/groups/${encodeURIComponent(id)}/peers`, { peers }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['group-detail'] });
      qc.invalidateQueries({ queryKey: ['groups'] });
      qc.invalidateQueries({ queryKey: ['peers'] });
    },
  });
}

// Add/remove USERS to/from a group. Group membership for users lives in each user's auto_groups, so
// the server does one PUT per user (best-effort) - here we just pass add/remove user-id deltas.
export interface AssignGroupUsersResult {
  ok: boolean;
  added: number;
  removed: number;
  failed: { id: string; error: string }[];
}
export function useAssignGroupUsers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, add, remove }: { id: string; add?: string[]; remove?: string[] }) =>
      api.post<AssignGroupUsersResult>(`/api/groups/${encodeURIComponent(id)}/users`, { add: add || [], remove: remove || [] }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['group-detail'] });
      qc.invalidateQueries({ queryKey: ['groups'] });
      qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

// ── Users: invite / resend invitation ──
// The invite goes through our backend, which posts to NetBird in the CURRENT account
// Create an empty NetBird group (official parity). Works in tenant context too.
export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<{ id: string; name: string }>('/api/groups', { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['groups'] });
      qc.invalidateQueries({ queryKey: ['netbird-groups'] });
    },
  });
}

// Rename a group (API-created groups only; the "All" and IdP-issued groups are rejected server-side).
export function useRenameGroup(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<{ ok: boolean; name: string }>(`/api/groups/${encodeURIComponent(id)}/rename`, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['group-detail', id] });
      qc.invalidateQueries({ queryKey: ['groups'] });
      qc.invalidateQueries({ queryKey: ['netbird-groups'] });
    },
  });
}

// context - so it works while managing an MSP tenant too. The server force-refreshes the
// users mirror, so invalidating ['users'] already shows the new user as Invited.
export function useInviteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InviteUserInput) => api.post<NbUser>('/api/users/invite', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

// Save the current Auto-Assigned Groups selection as this account's invite default.
// Per account server-side, so an MSP tenant's defaults never touch the main account's.
export function useSaveInviteDefaultGroups() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (groups: string[]) => api.put<InviteDefaultGroups>('/api/users/invite-defaults', { groups }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['invite-defaults'] });
    },
  });
}

export function useResendInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/users/${encodeURIComponent(id)}/resend-invite`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['user-detail'] });
    },
  });
}

// Delete a user. NetBird deletes the user's peers along with them, so the peers list is
// invalidated too - it is stale the moment this succeeds.
export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/users/${encodeURIComponent(id)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['peers'] });
    },
  });
}

// Block / unblock a user. The Users list and the user-detail page both reflect is_blocked, so
// both are invalidated on success.
export function useSetUserBlocked() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, blocked }: { id: string; blocked: boolean }) =>
      api.post(`/api/users/${encodeURIComponent(id)}/block`, { blocked }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['user-detail'] });
    },
  });
}

// Reset a user's MFA methods. Only the user-detail view carries MFA state, so it alone is refreshed.
export function useResetUserMfa() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/users/${encodeURIComponent(id)}/reset-mfa`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-detail'] });
    },
  });
}

// ── Create a setup key ──
// Two callers: Add Peer (server flow) sends only { name } for the official one-off install key;
// the group Setup Keys tab sends the full field set (type / expiresInDays / usageLimit / ephemeral
// / autoGroups) so the key auto-assigns that group. The backend posts in the CURRENT account
// context, so this works while managing an MSP tenant too. The plaintext key comes back once and
// lives only in the modal's state - nothing is cached in react-query. A key with auto_groups
// changes the group's setup-key count, so the group detail + groups list are refreshed.
export function useCreateSetupKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSetupKeyInput = {}) => api.post<SetupKeyResult>('/api/setup-keys', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['group-detail'] });
      qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

// ── App configuration (display name + log timezone) ──
export function useSaveAppConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { appName?: string; timeZone?: string; dateFormat?: string; hour12?: boolean; showResourceGroups?: boolean; policyNameTemplate?: string; policyNameTemplateShared?: string; proxyDefaultDomain?: string }) => api.put('/api/app-config', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['app-config'] }),
  });
}

// ── NetBird Management API connection (url + token) ──
export function useSaveNetbirdApi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { url: string; token?: string }) => api.put('/api/integrations/netbird', payload),
    // The connection drives users/peers/groups/networks - refresh everything.
    onSuccess: () => qc.invalidateQueries(),
  });
}

// ── Incoming-webhook auth token (set a new token, or clear to disable auth) ──
export function useSaveWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { token?: string; clear?: boolean; notifToken?: string; clearNotif?: boolean }) => api.put('/api/integrations/webhook', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhook-config'] }),
  });
}

// ── Traffic Events API pull (opt-in polling; the alternative to webhook event streaming) ──
// Enabling also kicks one immediate server-side pull, so the status line fills in shortly after.
export function useSetTrafficPull() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => api.put<TrafficPullStatus>('/api/traffic-pull', { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['traffic-pull'] }),
  });
}

// ── Audit Events API pull (opt-in polling; the alternative to webhook event streaming) ──
// Enabling also kicks one immediate server-side pull, so the status line fills in shortly after.
export function useSetAuditPull() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => api.put<AuditPullStatus>('/api/audit-pull', { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['audit-pull'] }),
  });
}

// One-click NetBird notifications setup: (re)generates the ingest token and creates-or-updates
// the NetBird Account Notifications webhook channel (all event types) in the CURRENT account
// (works in main and tenant context). May 502 with a NetBird error message.
export function useAutoConfigureNbNotifications() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<AutoConfigureNbResult>('/api/integrations/webhook/notifications-auto', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhook-config'] }),
  });
}

// One-click NetBird event-streaming setup: creates-or-updates the Generic HTTP Event Streaming
// integration (activity + traffic events) in the CURRENT account and handles the events ingest token
// (rotated, unless the main account's token is env-managed via WEBHOOK_AUTH_TOKEN and reused as-is).
// Works in main and tenant context. May 502 with a NetBird error message.
export function useAutoConfigureNbEvents() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<AutoConfigureNbResult>('/api/integrations/webhook/events-auto', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhook-config'] }),
  });
}

// ── Telegram notifications config (write-only bot token) + a "send test message" action ──
export function useSaveTelegram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: TelegramInput) => api.put('/api/integrations/telegram', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['telegram'] }),
  });
}
export function useSaveApproverConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ApproverConfigInput) => api.put('/api/approver-config', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approver-config'] }),
  });
}
export function useTestTelegram() {
  return useMutation({ mutationFn: () => api.post<{ ok: boolean; error?: string }>('/api/integrations/telegram/test') });
}

// ── SMTP email config (write-only password) + a "send test email" action ──
export function useSaveSmtp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SmtpConfigInput) => api.put('/api/integrations/smtp', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['smtp'] }),
  });
}
export function useTestSmtp() {
  return useMutation({ mutationFn: (to?: string) => api.post<{ ok: boolean; error?: string }>('/api/integrations/smtp/test', { to }) });
}
export function useCreateTelegramTopics() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (categories: Record<string, string>) =>
      api.post<{ ok: boolean; created: number; errors: string[] }>('/api/integrations/telegram/create-topics', { categories }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['telegram'] }),
  });
}

// ── Manual "Refresh": bust + re-pull the server-side NetBird caches, then refetch every active
// query. `onSettled` fires on success OR error, so the UI still refetches even if the bust call
// fails (e.g. an older backend) - the button never silently does nothing. ──
// Send the weekly review digest right now (skips the schedule; admin only).
export function useSendReviewDigest() {
  return useMutation({
    mutationFn: () => api.post<{ telegram: boolean; emails: number }>('/api/security-config/send-digest', {}),
  });
}

// Mark / unmark a Cleanup finding as deliberately ignored.
export function useSetCleanupIgnore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { category: string; id: string; name?: string; ignore: boolean }) => api.post('/api/cleanup-scan/ignore', p),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cleanup-scan'] }),
  });
}

// ─── MSP tenants ───
export function useSaveTenant() {
  const qc = useQueryClient();
  return useMutation({
    // Create returns { id, status, dnsChallenge, setup } - the caller opens the TXT modal when
    // a challenge comes back and warns when a requested setup step failed. Update returns { ok }
    // (id/dnsChallenge/setup absent). `payload.setup` (create only) toggles the initial-setup steps;
    // response `setup` reports each: null = skipped/not requested, true/false = attempted result.
    mutationFn: ({ id, payload }: { id?: string; payload: { name: string; domain?: string; groups: { id: string; role: string }[]; setup?: { seed: boolean; provision: boolean; notifications: boolean; events: boolean } } }): Promise<{ ok?: boolean; id?: string; status?: string; dnsChallenge?: string; setup?: { provisioned: boolean | null; seeded: boolean | null; notifications: boolean | null; events: boolean | null } }> =>
      id
        ? api.put(`/api/msp/tenants/${encodeURIComponent(id)}`, payload)
        : api.post('/api/msp/tenants', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['msp-tenants'] }),
  });
}
export function useDeleteTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/msp/tenants/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['msp-tenants'] }),
  });
}
// MSP provisioning token (write-only; empty string clears it).
export function useSetProvisioningToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.put<{ hasProvisioningToken: boolean }>('/api/msp/provisioning-token', { token }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['msp-status'] }),
  });
}
// Provision (or rotate) a tenant's managed service user + token.
export function useProvisionTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ serviceUser: string; expiresAt: string }>(`/api/msp/tenants/${encodeURIComponent(id)}/provision`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['msp-tenants'] }),
  });
}
// Per-tenant API token (write-only; empty string clears it).
export function useSetTenantToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, token }: { id: string; token: string }) =>
      api.put<{ hasApiToken: boolean }>(`/api/msp/tenants/${encodeURIComponent(id)}/token`, { token }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['msp-tenants'] }),
  });
}
// REAL BILLING ACTION: subscribe a tenant to a paid plan, billed to the MSP account. The server
// picks POST (free/trial) or PUT (already paying) against NetBird itself. Invalidating the tenant
// list refreshes the Plan column.
export function useChangeTenantPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, priceId }: { id: string; priceId: string }) =>
      api.post(`/api/msp/tenants/${encodeURIComponent(id)}/subscription`, { priceId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['msp-tenants'] }),
  });
}
// Settings Sync: REPLACE this tenant's Event Filtering + Blocklist + Data Retention with main's
// current config (webhook tokens are NOT touched). The caller refetches the drift afterwards.
export function useApplyTenantDefaults() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<ApplyTenantDefaultsResult>(`/api/msp/tenants/${encodeURIComponent(id)}/apply-defaults`, {}),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ['msp-tenants'] });
      qc.invalidateQueries({ queryKey: ['msp-tenant-drift', id] });
    },
  });
}
// Save the Tenant Defaults profile (admin, main only) - what new tenants are seeded with and what
// "Apply Defaults" applies. Returns the saved profile; invalidates the query.
export function useSaveTenantDefaults() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (profile: TenantDefaultsProfile) => api.put<TenantDefaultsProfile>('/api/tenant-defaults', profile),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenant-defaults'] }),
  });
}
// Save the CURRENT account's live NetBird settings (admin) - main in main mode, the managed tenant's
// account in tenant mode. Returns the account's merged/normalized settings; invalidates the query.
export function useSaveNetbirdSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (nb: NetbirdNbSettings) => api.put<NetbirdSettingsResponse>('/api/netbird-settings', { nb }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['netbird-settings'] }),
  });
}
// ── Weekly MSP digest (admin, main only) ──
export function useSaveMspDigest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: MspDigestConfig) => api.put('/api/msp-digest', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['msp-digest'] }),
  });
}
// Send the MSP digest right now (skips the schedule). Returns what it actually reached.
export function useSendMspDigest() {
  return useMutation({
    mutationFn: () => api.post<MspDigestSendResult>('/api/msp-digest/send', {}),
  });
}
export function useVerifyTenantDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ verified: boolean; dnsChallenge?: string }>(`/api/msp/tenants/${encodeURIComponent(id)}/dns`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['msp-tenants'] }),
  });
}

// Admin "Ignore" on a NetBird notice - hides it (and older rows of the same issue) for everyone.
export function useDismissNbNotice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post(`/api/diagnostics/notices/${id}/dismiss`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['diag-notices'] }),
  });
}

export function useNetbirdRefresh() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/api/refresh'),
    onSettled: () => qc.invalidateQueries(),
  });
}

// ── Purge stored events matching the filters (EVENT_PURGE_ADMINS only) ──
// Scan returns a count + sample; purge deletes them and refreshes the traffic log.
export function useScanMatchingEvents() {
  return useMutation({ mutationFn: () => api.get<MatchingEventsResult>('/api/filter-rules/matching') });
}
export function usePurgeMatchingEvents() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ deleted: number }>('/api/filter-rules/purge'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['logs'] }),
  });
}

// ─── Internal envelope-encrypted backup (tier 2) ───
// Set / change / reset the encryption passphrase. The passphrase is sent once and never stored.
export function useSetBackupPassphrase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { passphrase: string; currentPassphrase?: string; reset?: boolean }) =>
      api.post<{ ok: boolean; mode: string }>('/api/internal-backup/passphrase', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['internal-backup'] }),
  });
}
export function useSaveInternalBackupConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: InternalBackupConfig) => api.put<InternalBackupConfig>('/api/internal-backup/config', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['internal-backup'] }),
  });
}
export function useRunInternalBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<InternalBackupRunResult>('/api/internal-backup/run'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['internal-backup'] }),
  });
}
// Restore from a folder file. A full restore replaces EVERY setting/config across all tenants, so it
// invalidates the whole cache (the app reloads immediately).
export function useRestoreInternalBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; passphrase: string }) =>
      api.post<InternalBackupRestoreResult>('/api/internal-backup/restore', body),
    onSuccess: () => qc.invalidateQueries(),
  });
}
// Restore from an uploaded file: raw encrypted bytes, passphrase in a header.
export function useUploadInternalBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ bytes, passphrase }: { bytes: ArrayBuffer; passphrase: string }) =>
      api.postRaw<InternalBackupRestoreResult>('/api/internal-backup/upload', bytes, { 'X-Backup-Passphrase': passphrase }),
    onSuccess: () => qc.invalidateQueries(),
  });
}
