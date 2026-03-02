import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTabsStore } from "renderer/stores/tabs/store";
import { resolveActiveTabIdForWorkspace } from "renderer/stores/tabs/utils";
import { EmptyTabView } from "./EmptyTabView";
import { TabView } from "./TabView";
import { useAdoptRemoteSessions } from "./useAdoptRemoteSessions";

export function TabsContent() {
	const { workspaceId: activeWorkspaceId } = useParams({ strict: false });
	const allTabs = useTabsStore((s) => s.tabs);
	const activeTabIds = useTabsStore((s) => s.activeTabIds);
	const tabHistoryStacks = useTabsStore((s) => s.tabHistoryStacks);

	// Adopt daemon sessions when a workspace has no tabs (e.g. after app restart
	// when tab persistence was lost but the remote daemon still has sessions)
	useAdoptRemoteSessions(activeWorkspaceId);

	const activeTabId = useMemo(() => {
		if (!activeWorkspaceId) return null;

		const resolvedActiveTabId = resolveActiveTabIdForWorkspace({
			workspaceId: activeWorkspaceId,
			tabs: allTabs,
			activeTabIds,
			tabHistoryStacks,
		});
		if (!resolvedActiveTabId) return null;

		const tab = allTabs.find((t) => t.id === resolvedActiveTabId) || null;
		if (!tab || tab.workspaceId !== activeWorkspaceId) return null;
		return resolvedActiveTabId;
	}, [activeWorkspaceId, activeTabIds, allTabs, tabHistoryStacks]);

	const tabToRender = useMemo(() => {
		if (!activeTabId) return null;
		return allTabs.find((tab) => tab.id === activeTabId) || null;
	}, [activeTabId, allTabs]);

	return (
		<div className="flex-1 min-h-0 flex overflow-hidden">
			{tabToRender ? <TabView tab={tabToRender} /> : <EmptyTabView />}
		</div>
	);
}
