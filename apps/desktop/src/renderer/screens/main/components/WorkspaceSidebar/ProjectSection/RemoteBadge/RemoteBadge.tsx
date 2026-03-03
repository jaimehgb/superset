import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { getConnectionDotColor } from "./getConnectionDotColor";

interface RemoteBadgeProps {
	remoteMachineId: string;
	className?: string;
}

const DOT_COLORS = {
	green: "bg-emerald-500",
	yellow: "bg-amber-400",
	red: "bg-red-500",
} as const;

const STATUS_LABELS: Record<string, string> = {
	connected: "Connected",
	connecting: "Connecting",
	reconnecting: "Reconnecting",
	disconnected: "Disconnected",
	error: "Connection error",
	unknown: "Unknown",
};

/**
 * Small badge shown next to the project name when `remoteMachineId` is set.
 * Displays "Remote" text with a colored connection-status dot.
 */
export function RemoteBadge({ remoteMachineId, className }: RemoteBadgeProps) {
	const { data: statusData } = electronTrpc.remoteMachines.getStatus.useQuery(
		{ id: remoteMachineId },
		{
			// Poll every 10s for live status updates
			refetchInterval: 10_000,
		},
	);

	const dotColor = getConnectionDotColor(statusData ?? null);

	const statusLabel = statusData?.sshState
		? (STATUS_LABELS[statusData.sshState] ?? "Unknown")
		: statusData?.status
			? (STATUS_LABELS[statusData.status] ?? "Unknown")
			: "Checking...";

	return (
		<Tooltip delayDuration={300}>
			<TooltipTrigger asChild>
				<span
					className={cn(
						"inline-flex items-center gap-1 px-1.5 py-0 rounded text-[10px] font-medium leading-4",
						"bg-muted/80 text-muted-foreground border border-border/50",
						"select-none shrink-0",
						className,
					)}
				>
					<span
						className={cn(
							"size-1.5 rounded-full shrink-0",
							DOT_COLORS[dotColor],
						)}
						aria-hidden
					/>
					Remote
				</span>
			</TooltipTrigger>
			<TooltipContent side="bottom" sideOffset={4}>
				<span className="text-xs">{statusLabel}</span>
			</TooltipContent>
		</Tooltip>
	);
}
