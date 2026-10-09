/**
 * Extension enable/disable config manager.
 * Stores state in ~/.pi/agent/rl-extensions.json
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(getAgentDir(), "rl-extensions.json");

interface ExtensionsConfig {
	enabled: Record<string, boolean>;
}

const DEFAULT_CONFIG: ExtensionsConfig = {
	enabled: {},
};

export function loadConfig(): ExtensionsConfig {
	if (existsSync(CONFIG_PATH)) {
		try {
			const content = readFileSync(CONFIG_PATH, "utf-8");
			return JSON.parse(content) as ExtensionsConfig;
		} catch {
			return { ...DEFAULT_CONFIG };
		}
	}
	return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: ExtensionsConfig): void {
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

export function isExtensionEnabled(config: ExtensionsConfig, name: string): boolean {
	// undefined means not configured yet — disabled by default (opt-in)
	return config.enabled[name] === true;
}

export function setExtensionEnabled(config: ExtensionsConfig, name: string, enabled: boolean): ExtensionsConfig {
	return {
		...config,
		enabled: { ...config.enabled, [name]: enabled },
	};
}

export interface ExtensionInfo {
	name: string;
	label: string;
	description: string;
	enabled: boolean;
}
