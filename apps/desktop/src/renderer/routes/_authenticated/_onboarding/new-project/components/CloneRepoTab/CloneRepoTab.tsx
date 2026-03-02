import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@superset/ui/toggle-group";
import { cn } from "@superset/ui/utils";
import { useState } from "react";
import { LuCloud, LuMonitor } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useProjectCreationHandler } from "../../hooks/useProjectCreationHandler";
import {
	buildCloneMutationInput,
	type CloneLocation,
	shouldShowRemoteToggle,
	validateCloneInputs,
} from "./clone-location-helpers";

interface CloneRepoTabProps {
	onError: (error: string) => void;
	parentDir: string;
}

export function CloneRepoTab({ onError, parentDir }: CloneRepoTabProps) {
	const [url, setUrl] = useState("");
	const [cloneLocation, setCloneLocation] = useState<CloneLocation>("local");

	const cloneRepo = electronTrpc.projects.cloneRepo.useMutation();
	const { handleResult, handleError } = useProjectCreationHandler(onError);
	const isLoading = cloneRepo.isPending;

	// Query remote machines to decide whether to show the toggle
	const { data: machines } = electronTrpc.remoteMachines.list.useQuery();
	const showRemoteToggle = shouldShowRemoteToggle(machines);

	// Use the first configured machine (single-machine MVP)
	const remoteMachine = machines?.[0];

	const handleClone = () => {
		const error = validateCloneInputs(
			url,
			parentDir,
			cloneLocation,
			remoteMachine,
		);
		if (error) {
			onError(error);
			return;
		}

		const input = buildCloneMutationInput(
			url,
			parentDir,
			cloneLocation,
			remoteMachine,
		);

		cloneRepo.mutate(input, {
			onSuccess: (result) => handleResult(result, () => setUrl("")),
			onError: handleError,
		});
	};

	return (
		<div className="flex flex-col gap-5">
			<div>
				<label
					htmlFor="clone-url"
					className="block text-sm font-medium text-foreground mb-2"
				>
					Repository URL
				</label>
				<Input
					id="clone-url"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					placeholder="https:// or git@github.com:user/repo.git"
					disabled={isLoading}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !isLoading) {
							handleClone();
						}
					}}
					autoFocus
				/>
			</div>

			{showRemoteToggle && (
				<div>
					<span className="block text-sm font-medium text-foreground mb-2">
						Clone to
					</span>
					<ToggleGroup
						type="single"
						value={cloneLocation}
						onValueChange={(value) => {
							if (value) setCloneLocation(value as CloneLocation);
						}}
						variant="outline"
						size="sm"
						className="w-full"
					>
						<ToggleGroupItem
							value="local"
							className="flex-1 gap-2"
							aria-label="Clone locally"
						>
							<LuMonitor className="size-3.5" />
							Local
						</ToggleGroupItem>
						<ToggleGroupItem
							value="remote"
							className="flex-1 gap-2"
							aria-label="Clone to remote machine"
						>
							<LuCloud className="size-3.5" />
							Remote
						</ToggleGroupItem>
					</ToggleGroup>

					{cloneLocation === "remote" && remoteMachine && (
						<p
							className={cn(
								"mt-2 text-xs text-muted-foreground",
								"flex items-center gap-1.5",
							)}
						>
							<LuCloud className="size-3 shrink-0" />
							Cloning to{" "}
							<span className="font-medium text-foreground">
								{remoteMachine.name}
							</span>
						</p>
					)}
				</div>
			)}

			<div className="flex justify-end pt-2 border-t border-border/40">
				<Button onClick={handleClone} disabled={isLoading} size="sm">
					{isLoading ? "Cloning..." : "Clone"}
				</Button>
			</div>
		</div>
	);
}
