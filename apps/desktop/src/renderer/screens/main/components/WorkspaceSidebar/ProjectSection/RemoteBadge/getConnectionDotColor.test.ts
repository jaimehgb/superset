import { describe, expect, test } from "bun:test";
import { getConnectionDotColor } from "./getConnectionDotColor";

describe("getConnectionDotColor", () => {
	test("returns green when sshState is connected", () => {
		expect(
			getConnectionDotColor({ status: "connected", sshState: "connected" }),
		).toBe("green");
	});

	test("returns yellow when sshState is connecting", () => {
		expect(
			getConnectionDotColor({ status: "unknown", sshState: "connecting" }),
		).toBe("yellow");
	});

	test("returns yellow when sshState is reconnecting", () => {
		expect(
			getConnectionDotColor({
				status: "connected",
				sshState: "reconnecting",
			}),
		).toBe("yellow");
	});

	test("returns red when sshState is error", () => {
		expect(
			getConnectionDotColor({ status: "connected", sshState: "error" }),
		).toBe("red");
	});

	test("returns red when sshState is disconnected", () => {
		expect(
			getConnectionDotColor({
				status: "disconnected",
				sshState: "disconnected",
			}),
		).toBe("red");
	});

	test("falls back to DB status when sshState is undefined", () => {
		expect(
			getConnectionDotColor({ status: "connected", sshState: undefined }),
		).toBe("green");
	});

	test("falls back to DB status disconnected when sshState is undefined", () => {
		expect(
			getConnectionDotColor({ status: "disconnected", sshState: undefined }),
		).toBe("red");
	});

	test("returns yellow for unknown DB status when sshState is undefined", () => {
		expect(
			getConnectionDotColor({ status: "unknown", sshState: undefined }),
		).toBe("yellow");
	});

	test("returns yellow when no status data is available (null input)", () => {
		expect(getConnectionDotColor(null)).toBe("yellow");
	});
});
