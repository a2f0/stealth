import { useCallback, useEffect, useRef, useState } from "react";
import {
  getOrganizationAccess,
  type OrganizationCapability,
  type OrganizationTwoFactorRequirement,
  twoFactorRequirementFrom,
} from "./organizationGroupsApi";

interface AccessState {
  capabilities: OrganizationCapability[];
  memberRole: string;
  organizationId: string;
  ownerCount: number;
  userId: string;
}

interface RequirementState {
  organizationId: string;
  requirement: OrganizationTwoFactorRequirement;
  userId: string;
}

export function useOrganizationAccess(
  userId: string | undefined,
  organizationId: string | undefined,
) {
  const requestSequence = useRef(0);
  const [state, setState] = useState<AccessState>();
  const [loadError, setLoadError] = useState<string>();
  const [requirementState, setRequirementState] = useState<RequirementState>();
  const refresh = useCallback(async () => {
    const requestId = ++requestSequence.current;
    if (!userId || !organizationId) {
      setState(undefined);
      setLoadError(undefined);
      setRequirementState(undefined);
      return;
    }
    setLoadError(undefined);
    try {
      const result = await getOrganizationAccess();
      if (requestId !== requestSequence.current) return;
      setRequirementState(undefined);
      setState({
        capabilities: result.capabilities,
        memberRole: result.memberRole,
        organizationId,
        ownerCount: result.ownerCount,
        userId,
      });
    } catch (cause) {
      if (requestId !== requestSequence.current) return;
      const requirement = twoFactorRequirementFrom(cause);
      setRequirementState(
        requirement ? { organizationId, requirement, userId } : undefined,
      );
      setLoadError(
        cause instanceof Error
          ? cause.message
          : "Could not load organization access.",
      );
      setState({
        capabilities: [],
        memberRole: "",
        organizationId,
        ownerCount: 0,
        userId,
      });
    }
  }, [organizationId, userId]);
  useEffect(() => {
    void refresh();
    return () => {
      requestSequence.current += 1;
    };
  }, [refresh]);
  const current =
    state?.organizationId === organizationId && state?.userId === userId
      ? state
      : undefined;
  const currentRequirement =
    requirementState &&
    requirementState.organizationId === organizationId &&
    requirementState.userId === userId
      ? requirementState.requirement
      : undefined;
  return {
    can: (capability: OrganizationCapability) =>
      current?.capabilities.includes(capability) ?? false,
    // Pending only until this user and organization first resolve; later
    // refreshes keep the current screen instead of blanking the workspace.
    isPending: Boolean(userId && organizationId && !current),
    loadError,
    memberRole: current?.memberRole || undefined,
    ownerCount: current?.ownerCount ?? 0,
    refresh,
    twoFactorRequirement: currentRequirement,
  };
}
