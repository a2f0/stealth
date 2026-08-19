import { useCallback, useEffect, useState } from "react";
import {
  getOrganizationAccess,
  type OrganizationCapability,
} from "./organizationGroupsApi";

interface AccessState {
  capabilities: OrganizationCapability[];
  organizationId: string;
  userId: string;
}

export function useOrganizationAccess(
  userId: string | undefined,
  organizationId: string | undefined,
) {
  const [state, setState] = useState<AccessState>();
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    if (!userId || !organizationId) {
      setState(undefined);
      return;
    }
    setLoading(true);
    try {
      const result = await getOrganizationAccess();
      setState({
        capabilities: result.capabilities,
        organizationId,
        userId,
      });
    } catch {
      setState({ capabilities: [], organizationId, userId });
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
    refresh,
  };
}
