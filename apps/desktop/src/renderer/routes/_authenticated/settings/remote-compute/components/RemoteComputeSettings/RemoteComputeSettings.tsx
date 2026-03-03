import { Badge } from "@superset/ui/badge";
import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { useCallback, useState } from "react";
import {
	HiOutlinePlus,
	HiOutlineServerStack,
	HiOutlineTrash,
} from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface MachineFormData {
	name: string;
	host: string;
	port: number;
	username: string;
	identityFile: string;
	projectsDir: string;
}

const EMPTY_FORM: MachineFormData = {
	name: "",
	host: "",
	port: 22,
	username: "",
	identityFile: "",
	projectsDir: "~/projects",
};

// -----------------------------------------------------------------------------
// Status Badge
// -----------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
	switch (status) {
		case "connected":
			return (
				<Badge
					variant="default"
					className="bg-green-600 text-white border-transparent"
				>
					Connected
				</Badge>
			);
		case "disconnected":
			return <Badge variant="secondary">Disconnected</Badge>;
		default:
			return <Badge variant="outline">Unknown</Badge>;
	}
}

// -----------------------------------------------------------------------------
// Machine Card
// -----------------------------------------------------------------------------

function MachineCard({
	machine,
}: {
	machine: {
		id: string;
		name: string;
		host: string;
		port: number;
		username: string;
		identityFile: string | null;
		projectsDir: string;
		status: string;
	};
}) {
	const utils = electronTrpc.useUtils();

	const [testResult, setTestResult] = useState<{
		success: boolean;
		message: string;
	} | null>(null);

	const deleteMachine = electronTrpc.remoteMachines.delete.useMutation({
		onSettled: () => {
			utils.remoteMachines.list.invalidate();
		},
	});

	const testConnection = electronTrpc.remoteMachines.testConnection.useMutation(
		{
			onSuccess: (result) => {
				if (result.success) {
					setTestResult({
						success: true,
						message: `SSH OK, Node ${result.nodeVersion ?? "available"}`,
					});
				} else {
					setTestResult({
						success: false,
						message: result.error ?? "Connection failed",
					});
				}
			},
			onError: (err) => {
				setTestResult({ success: false, message: err.message });
			},
		},
	);

	const [connectError, setConnectError] = useState<string | null>(null);

	const connectMachine = electronTrpc.remoteMachines.connect.useMutation({
		onMutate: () => {
			setConnectError(null);
		},
		onError: (err) => {
			setConnectError(err.message);
		},
		onSettled: () => {
			utils.remoteMachines.list.invalidate();
		},
	});

	const disconnectMachine = electronTrpc.remoteMachines.disconnect.useMutation({
		onSettled: () => {
			utils.remoteMachines.list.invalidate();
		},
	});

	const isConnected = machine.status === "connected";
	const isConnecting = connectMachine.isPending;
	const isDisconnecting = disconnectMachine.isPending;
	const isTesting = testConnection.isPending;

	const handleToggleConnection = useCallback(() => {
		setTestResult(null);
		setConnectError(null);
		if (isConnected) {
			disconnectMachine.mutate({ id: machine.id });
		} else {
			connectMachine.mutate({ id: machine.id });
		}
	}, [isConnected, machine.id, connectMachine, disconnectMachine]);

	const handleTestConnection = useCallback(() => {
		setTestResult(null);
		testConnection.mutate({ id: machine.id });
	}, [machine.id, testConnection]);

	return (
		<div className="border rounded-lg p-4 space-y-3">
			{/* Header row */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-3">
					<div className="p-2 bg-accent rounded-md">
						<HiOutlineServerStack className="h-5 w-5" />
					</div>
					<div>
						<div className="font-medium">{machine.name}</div>
						<div className="text-sm text-muted-foreground">
							{machine.username}@{machine.host}
							{machine.port !== 22 ? `:${machine.port}` : ""}
						</div>
					</div>
				</div>
				<StatusBadge status={machine.status} />
			</div>

			{/* Details */}
			<div className="text-sm text-muted-foreground space-y-1">
				{machine.identityFile && (
					<div>
						SSH Key:{" "}
						<code className="bg-muted px-1.5 py-0.5 rounded text-xs">
							{machine.identityFile}
						</code>
					</div>
				)}
				<div>
					Projects:{" "}
					<code className="bg-muted px-1.5 py-0.5 rounded text-xs">
						{machine.projectsDir}
					</code>
				</div>
			</div>

			{/* Test result */}
			{testResult && (
				<div
					className={`text-sm px-3 py-2 rounded ${
						testResult.success
							? "bg-green-500/10 text-green-600 dark:text-green-400"
							: "bg-destructive/10 text-destructive"
					}`}
				>
					{testResult.message}
				</div>
			)}

			{/* Connect error */}
			{connectError && (
				<div className="text-sm px-3 py-2 rounded bg-destructive/10 text-destructive">
					{connectError}
				</div>
			)}

			{/* Actions */}
			<div className="flex items-center gap-2 pt-1">
				<Button
					variant="outline"
					size="sm"
					onClick={handleTestConnection}
					disabled={isTesting}
				>
					{isTesting ? "Testing..." : "Test Connection"}
				</Button>

				<Button
					variant={isConnected ? "outline" : "default"}
					size="sm"
					onClick={handleToggleConnection}
					disabled={isConnecting || isDisconnecting}
				>
					{isConnecting
						? "Connecting..."
						: isDisconnecting
							? "Disconnecting..."
							: isConnected
								? "Disconnect"
								: "Connect"}
				</Button>

				<div className="flex-1" />

				<Button
					variant="ghost"
					size="sm"
					onClick={() => deleteMachine.mutate({ id: machine.id })}
					disabled={deleteMachine.isPending || isConnected}
					className="text-destructive hover:text-destructive"
				>
					<HiOutlineTrash className="h-4 w-4" />
				</Button>
			</div>
		</div>
	);
}

// -----------------------------------------------------------------------------
// Add Machine Form
// -----------------------------------------------------------------------------

function AddMachineForm({ onClose }: { onClose: () => void }) {
	const utils = electronTrpc.useUtils();
	const [form, setForm] = useState<MachineFormData>({ ...EMPTY_FORM });

	const createMachine = electronTrpc.remoteMachines.create.useMutation({
		onSuccess: () => {
			utils.remoteMachines.list.invalidate();
			onClose();
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		createMachine.mutate({
			name: form.name,
			host: form.host,
			port: form.port,
			username: form.username,
			identityFile: form.identityFile || null,
			projectsDir: form.projectsDir,
		});
	};

	const isValid = form.name.trim() && form.host.trim() && form.username.trim();

	return (
		<form onSubmit={handleSubmit} className="border rounded-lg p-4 space-y-4">
			<h3 className="font-medium">Add Remote Machine</h3>

			<div className="grid grid-cols-2 gap-4">
				<div className="space-y-1.5">
					<Label htmlFor="machine-name" className="text-sm">
						Name
					</Label>
					<Input
						id="machine-name"
						placeholder="My Dev Server"
						value={form.name}
						onChange={(e) => setForm({ ...form, name: e.target.value })}
					/>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="machine-host" className="text-sm">
						Host
					</Label>
					<Input
						id="machine-host"
						placeholder="192.168.1.100 or dev.example.com"
						value={form.host}
						onChange={(e) => setForm({ ...form, host: e.target.value })}
					/>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="machine-port" className="text-sm">
						Port
					</Label>
					<Input
						id="machine-port"
						type="number"
						placeholder="22"
						value={form.port}
						onChange={(e) =>
							setForm({
								...form,
								port: Number.parseInt(e.target.value, 10) || 22,
							})
						}
					/>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="machine-username" className="text-sm">
						Username
					</Label>
					<Input
						id="machine-username"
						placeholder="root"
						value={form.username}
						onChange={(e) => setForm({ ...form, username: e.target.value })}
					/>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="machine-identity" className="text-sm">
						SSH Key Path (optional)
					</Label>
					<Input
						id="machine-identity"
						placeholder="~/.ssh/id_ed25519"
						value={form.identityFile}
						onChange={(e) => setForm({ ...form, identityFile: e.target.value })}
					/>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="machine-projects" className="text-sm">
						Projects Directory
					</Label>
					<Input
						id="machine-projects"
						placeholder="~/projects"
						value={form.projectsDir}
						onChange={(e) => setForm({ ...form, projectsDir: e.target.value })}
					/>
				</div>
			</div>

			{createMachine.error && (
				<div className="text-sm text-destructive">
					{createMachine.error.message}
				</div>
			)}

			<div className="flex items-center gap-2">
				<Button
					type="submit"
					size="sm"
					disabled={!isValid || createMachine.isPending}
				>
					{createMachine.isPending ? "Adding..." : "Add Machine"}
				</Button>
				<Button type="button" variant="ghost" size="sm" onClick={onClose}>
					Cancel
				</Button>
			</div>
		</form>
	);
}

// -----------------------------------------------------------------------------
// Main Component
// -----------------------------------------------------------------------------

export function RemoteComputeSettings() {
	const { data: machines, isLoading } =
		electronTrpc.remoteMachines.list.useQuery();
	const [showAddForm, setShowAddForm] = useState(false);

	return (
		<div className="p-6 max-w-4xl w-full">
			<div className="mb-8">
				<h2 className="text-xl font-semibold">Remote Compute</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Configure remote machines for running workspaces over SSH
				</p>
			</div>

			<div className="space-y-4">
				{/* Machine list */}
				{isLoading && (
					<div className="text-sm text-muted-foreground">
						Loading machines...
					</div>
				)}

				{machines?.map((machine) => (
					<MachineCard key={machine.id} machine={machine} />
				))}

				{!isLoading && machines?.length === 0 && !showAddForm && (
					<div className="border border-dashed rounded-lg p-8 text-center">
						<HiOutlineServerStack className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
						<p className="text-sm text-muted-foreground mb-4">
							No remote machines configured. Add one to run workspaces on remote
							hardware.
						</p>
						<Button
							variant="outline"
							size="sm"
							onClick={() => setShowAddForm(true)}
						>
							<HiOutlinePlus className="h-4 w-4 mr-1" />
							Add Machine
						</Button>
					</div>
				)}

				{/* Add form or Add button */}
				{showAddForm ? (
					<AddMachineForm onClose={() => setShowAddForm(false)} />
				) : (
					machines &&
					machines.length > 0 && (
						<Button
							variant="outline"
							size="sm"
							onClick={() => setShowAddForm(true)}
						>
							<HiOutlinePlus className="h-4 w-4 mr-1" />
							Add Machine
						</Button>
					)
				)}
			</div>
		</div>
	);
}
