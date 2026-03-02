import { useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";

/**
 * When a workspace has no tabs but the remote daemon has alive sessions,
 * adopt those sessions by creating tabs with the daemon's pane IDs.
 * This enables warm reattach after app restart even if tab state was lost.
 */
export function useAdoptRemoteSessions(workspaceId: string | undefined) {
	const adoptSessions = useTabsStore((s) => s.adoptSessions);
	const allTabs = useTabsStore((s) => s.tabs);
	const attemptedRef = useRef<Set<string>>(new Set());

	const workspaceTabs = workspaceId
		? allTabs.filter((t) => t.workspaceId === workspaceId)
		: [];
	const hasNoTabs = workspaceTabs.length === 0;

	const { data, isLoading } =
		electronTrpc.terminal.listSessionsForWorkspace.useQuery(
			{ workspaceId: workspaceId ?? "" },
			{
				enabled: !!workspaceId && hasNoTabs,
			},
		);

	useEffect(() => {
		if (!workspaceId || !hasNoTabs || isLoading || !data?.sessions?.length) {
			return;
		}

		// Only attempt adoption once per workspace per app session
		if (attemptedRef.current.has(workspaceId)) {
			return;
		}
		attemptedRef.current.add(workspaceId);

		console.log(
			`[useAdoptRemoteSessions] Adopting ${data.sessions.length} session(s) for workspace ${workspaceId}`,
		);
		adoptSessions(workspaceId, data.sessions);
	}, [workspaceId, hasNoTabs, isLoading, data, adoptSessions]);
}
