type DotColor = "green" | "yellow" | "red";

interface StatusInput {
	status: "connected" | "disconnected" | "unknown";
	sshState?:
		| "disconnected"
		| "connecting"
		| "connected"
		| "reconnecting"
		| "error";
}

/**
 * Maps a remote machine's DB status and live SSH state to a dot color.
 *
 * Priority: live sshState takes precedence over the persisted DB status.
 *
 * - green:  connected
 * - yellow: connecting / reconnecting / unknown
 * - red:    disconnected / error
 */
export function getConnectionDotColor(input: StatusInput | null): DotColor {
	if (!input) return "yellow";

	const { status, sshState } = input;

	// Prefer live SSH state when available
	if (sshState !== undefined) {
		switch (sshState) {
			case "connected":
				return "green";
			case "connecting":
			case "reconnecting":
				return "yellow";
			case "disconnected":
			case "error":
				return "red";
		}
	}

	// Fall back to DB-persisted status
	switch (status) {
		case "connected":
			return "green";
		case "disconnected":
			return "red";
		case "unknown":
			return "yellow";
	}
}
