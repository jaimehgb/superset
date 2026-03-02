import { createFileRoute } from "@tanstack/react-router";
import { RemoteComputeSettings } from "./components/RemoteComputeSettings";

export const Route = createFileRoute(
	"/_authenticated/settings/remote-compute/",
)({
	component: RemoteComputeSettings,
});
