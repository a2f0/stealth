import { useCallback, useEffect, useState } from "react";
import {
  getOrganizationAccess,
  type OrganizationCapability,
} from "./organizationGroupsApi";

interface AccessState {
  capabilities: OrganizationCapability[];
  memberRole: string;
  organizationId: string;
  ownerCount: number;
  userId: string;
}

export function useOrganizationAccess(
  userId: string | undefined,
  organizationId: string | undefined,
) {
  const [state, setState] = useState<AccessState>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const refresh = useCallback(async () => {
    if (!userId || !organizationId) {
      setState(undefined);
      return;
    }
    setLoading(true);
    setLoadError(undefined);
    try {
      const result = await getOrganizationAccess();
      setState({
        capabilities: result.capabilities,
        memberRole: result.memberRole,
        organizationId,
        ownerCount: result.ownerCount,
        userId,
      });
    } catch (cause) {
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
    } finally {
      setLoading(false);
    }
  }, [organizationId, userId]);
  useEffect(() => void refresh(), [refresh]);
  const current =
    state?.organizationId === organizationId && state?.userId === userId
      ? state
      : undefined;
  return {
    can: (capability: OrganizationCapability) =>
      current?.capabilities.includes(capability) ?? false,
    isPending: Boolean(userId && organizationId && (!current || loading)),
    loadError,
    memberRole: current?.memberRole || undefined,
    ownerCount: current?.ownerCount ?? 0,
    refresh,
  };
}
