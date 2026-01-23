import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { getShellEnvironment } from "../git/shell-env";

const execFileAsync = promisify(execFile);

/**
 * Minimum supported Claude CLI version.
 * Update this when SDK requirements change or new features require a newer CLI.
 */
const MINIMUM_CLAUDE_VERSION = "2.0.0";

/**
 * Health check status for Claude CLI resolution and validation.
 */
export enum ClaudeCliHealthStatus {
	/** CLI is resolved, executable, and version-compatible */
	OK = "OK",
	/** CLI binary not found in PATH or configured location */
	MISSING = "MISSING",
	/** CLI found but version is incompatible (too old) */
	VERSION_INCOMPATIBLE = "VERSION_INCOMPATIBLE",
	/** CLI found but permission error (not executable) */
	PERMISSION_ERROR = "PERMISSION_ERROR",
	/** CLI found but validation failed (security check, path issue) */
	VALIDATION_ERROR = "VALIDATION_ERROR",
}

/**
 * Version information parsed from `claude --version` output.
 */
export interface ClaudeVersionInfo {
	/** Full version string (e.g., "2.1.5") */
	version: string;
	/** Major version number */
	major: number;
	/** Minor version number */
	minor: number;
	/** Patch version number */
	patch: number;
	/** Whether version meets minimum requirement */
	isCompatible: boolean;
}

/**
 * Resolved CLI path and validation result.
 */
export interface ClaudeCliResolution {
	/** Absolute path to Claude CLI executable, or null if not found */
	path: string | null;
	/** Version information if CLI was found and executable */
	version: ClaudeVersionInfo | null;
	/** Health check status */
	status: ClaudeCliHealthStatus;
	/** Error message if resolution failed */
	error?: string;
}

/**
 * Cache for resolved CLI path and version.
 * Invalidated when settings change or explicitly cleared.
 */
interface ResolutionCache {
	path: string | null;
	version: ClaudeVersionInfo | null;
	status: ClaudeCliHealthStatus;
	error?: string;
	timestamp: number;
}

let resolutionCache: ResolutionCache | null = null;

/**
 * Clears the resolution cache.
 * Call this when user settings change (e.g., configured CLI path is updated).
 */
export function clearResolutionCache(): void {
	resolutionCache = null;
	console.log("[claude-cli-resolver] Cache cleared");
}

/**
 * Validates a user-provided CLI path for security and correctness.
 * Rejects:
 * - Non-existent files
 * - Directories
 * - Paths with directory traversal (../, ..)
 * - Relative paths (must be absolute)
 * - Non-executable files (platform-specific check)
 *
 * @param cliPath - Path to validate
 * @returns Error message if invalid, null if valid
 */
async function validateCliPath(cliPath: string): Promise<string | null> {
	try {
		// Must be absolute
		if (!path.isAbsolute(cliPath)) {
			return "CLI path must be absolute";
		}

		// Normalize to resolve any redundant separators, but check for traversal
		const normalized = path.normalize(cliPath);
		if (normalized !== cliPath) {
			return "CLI path contains invalid characters or redundant separators";
		}

		// Check for directory traversal attempts
		const parts = normalized.split(path.sep);
		if (parts.some((part) => part === ".." || part === ".")) {
			return "CLI path cannot contain directory traversal (.. or .)";
		}

		// Check if file exists
		try {
			const stats = await fs.promises.stat(normalized);
			if (!stats.isFile()) {
				return "CLI path must point to a file, not a directory";
			}

			// Check executable permission (platform-specific)
			if (process.platform !== "win32") {
				// On Unix-like systems, check if file is executable
				const mode = stats.mode;
				const isExecutable = (mode & fs.constants.S_IXUSR) !== 0;
				if (!isExecutable) {
					return "CLI path is not executable";
				}
			}
			// On Windows, we rely on file extension (.exe, .cmd, .bat) and try execution

			return null; // Valid
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return "CLI path does not exist";
			}
			throw error;
		}
	} catch (error) {
		return `Validation error: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * Parses version string from `claude --version` output.
 * Handles various output formats:
 * - "claude 2.1.5"
 * - "2.1.5"
 * - "v2.1.5"
 *
 * @param output - Raw output from `claude --version`
 * @returns Parsed version info, or null if parsing fails
 */
function parseVersion(output: string): ClaudeVersionInfo | null {
	// Extract version string (look for semantic version pattern)
	const versionMatch = output.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!versionMatch) {
		return null;
	}

	const major = parseInt(versionMatch[1]!, 10);
	const minor = parseInt(versionMatch[2]!, 10);
	const patch = parseInt(versionMatch[3]!, 10);

	if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
		return null;
	}

	const version = `${major}.${minor}.${patch}`;

	// Compare with minimum version
	const minParts = MINIMUM_CLAUDE_VERSION.split(".").map(Number);
	const isCompatible =
		major > minParts[0]! ||
		(major === minParts[0]! &&
			(minor > minParts[1]! ||
				(minor === minParts[1]! && patch >= minParts[2]!)));

	return {
		version,
		major,
		minor,
		patch,
		isCompatible,
	};
}

/**
 * Executes `claude --version` and parses the output.
 *
 * @param cliPath - Absolute path to Claude CLI executable
 * @param env - Environment variables to use for execution
 * @returns Version info, or null if execution/parsing fails
 */
async function getCliVersion(
	cliPath: string,
	env: Record<string, string>,
): Promise<ClaudeVersionInfo | null> {
	try {
		const { stdout } = await execFileAsync(cliPath, ["--version"], {
			encoding: "utf8",
			timeout: 10_000,
			env,
		});

		const version = parseVersion(stdout);
		if (!version) {
			console.warn(
				`[claude-cli-resolver] Failed to parse version from output: ${stdout}`,
			);
		}
		return version;
	} catch (error) {
		console.error(
			`[claude-cli-resolver] Failed to execute --version: ${error}`,
		);
		return null;
	}
}

/**
 * Resolves `claude` executable from PATH using platform-specific commands.
 * Uses `which` on Unix-like systems and `where` on Windows.
 *
 * @param env - Environment variables (should include PATH)
 * @returns Absolute path to `claude` executable, or null if not found
 */
async function resolveFromPath(
	env: Record<string, string>,
): Promise<string | null> {
	const platform = process.platform;
	const candidates = platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];

	try {
		if (platform === "win32") {
			// On Windows, try `where` command
			for (const candidate of candidates) {
				try {
					const { stdout } = await execFileAsync("where", [candidate], {
						encoding: "utf8",
						timeout: 5_000,
						env,
					});
					const resolved = stdout.trim().split("\n")[0]?.trim();
					if (resolved && fs.existsSync(resolved)) {
						return path.resolve(resolved);
					}
				} catch {
					// Continue to next candidate
				}
			}
		} else {
			// On Unix-like systems, use `which`
			for (const candidate of candidates) {
				try {
					const { stdout } = await execFileAsync("which", [candidate], {
						encoding: "utf8",
						timeout: 5_000,
						env,
					});
					const resolved = stdout.trim();
					if (resolved && fs.existsSync(resolved)) {
						return path.resolve(resolved);
					}
				} catch {
					// Continue to next candidate
				}
			}
		}
	} catch (error) {
		console.warn(
			`[claude-cli-resolver] PATH resolution failed: ${error}`,
		);
	}

	return null;
}

/**
 * Resolves the Claude CLI executable path using the specified resolution order:
 * 1. User-configured path (if provided and valid)
 * 2. PATH resolution via `which`/`where`
 * 3. Windows-specific shims (`claude.exe`, `claude.cmd`)
 *
 * Also validates the resolved path and checks version compatibility.
 *
 * @param options - Resolution options
 * @param options.configuredPath - Optional user-configured absolute path to Claude CLI
 * @param options.skipCache - If true, bypass cache and force re-resolution
 * @returns Resolution result with path, version, and health status
 */
export async function resolveClaudeCli(options?: {
	configuredPath?: string | null;
	skipCache?: boolean;
}): Promise<ClaudeCliResolution> {
	const { configuredPath = null, skipCache = false } = options || {};

	// Return cached result if available and not skipping cache
	if (!skipCache && resolutionCache) {
		console.log("[claude-cli-resolver] Using cached resolution");
		return {
			path: resolutionCache.path,
			version: resolutionCache.version,
			status: resolutionCache.status,
			error: resolutionCache.error,
		};
	}

	console.log("[claude-cli-resolver] Resolving Claude CLI...");

	// Get shell environment for PATH resolution (important for packaged apps)
	// This uses cross-platform shell environment with Windows-specific PATH building
	let shellEnv: Record<string, string>;
	try {
		shellEnv = await getShellEnvironment();
	} catch (error) {
		console.warn(
			`[claude-cli-resolver] Failed to get shell environment, using process.env: ${error}`,
		);
		shellEnv = { ...process.env } as Record<string, string>;
	}

	let resolvedPath: string | null = null;
	let validationError: string | null = null;

	// Step 1: Try user-configured path
	if (configuredPath) {
		console.log(`[claude-cli-resolver] Checking configured path: ${configuredPath}`);
		validationError = await validateCliPath(configuredPath);
		if (!validationError) {
			resolvedPath = path.resolve(configuredPath);
			console.log(`[claude-cli-resolver] Using configured path: ${resolvedPath}`);
		} else {
			console.warn(
				`[claude-cli-resolver] Configured path validation failed: ${validationError}`,
			);
		}
	}

	// Step 2: Try PATH resolution
	if (!resolvedPath) {
		console.log("[claude-cli-resolver] Resolving from PATH...");
		resolvedPath = await resolveFromPath(shellEnv);
		if (resolvedPath) {
			console.log(`[claude-cli-resolver] Resolved from PATH: ${resolvedPath}`);
		}
	}

	// Step 3: If still not found, return MISSING status
	if (!resolvedPath) {
		const result: ClaudeCliResolution = {
			path: null,
			version: null,
			status: ClaudeCliHealthStatus.MISSING,
			error: configuredPath
				? `Configured path invalid: ${validationError}. Also not found in PATH.`
				: "Claude CLI not found in PATH. Install it or configure a custom path in settings.",
		};

		// Cache the failure
		resolutionCache = {
			...result,
			timestamp: Date.now(),
		};

		return result;
	}

	// Step 4: Validate resolved path (should already be validated if from config, but double-check)
	if (!validationError) {
		validationError = await validateCliPath(resolvedPath);
	}

	if (validationError) {
		const result: ClaudeCliResolution = {
			path: resolvedPath,
			version: null,
			status: ClaudeCliHealthStatus.VALIDATION_ERROR,
			error: validationError,
		};

		resolutionCache = {
			...result,
			timestamp: Date.now(),
		};

		return result;
	}

	// Step 5: Check version
	let version: ClaudeVersionInfo | null = null;
	try {
		version = await getCliVersion(resolvedPath, shellEnv);
	} catch (error) {
		console.error(
			`[claude-cli-resolver] Version check failed: ${error}`,
		);
	}

	if (!version) {
		const result: ClaudeCliResolution = {
			path: resolvedPath,
			version: null,
			status: ClaudeCliHealthStatus.VERSION_INCOMPATIBLE,
			error: "Failed to determine Claude CLI version. CLI may be corrupted or incompatible.",
		};

		resolutionCache = {
			...result,
			timestamp: Date.now(),
		};

		return result;
	}

	// Step 6: Check version compatibility
	if (!version.isCompatible) {
		const result: ClaudeCliResolution = {
			path: resolvedPath,
			version,
			status: ClaudeCliHealthStatus.VERSION_INCOMPATIBLE,
			error: `Claude CLI version ${version.version} is below minimum required version ${MINIMUM_CLAUDE_VERSION}. Please upgrade.`,
		};

		resolutionCache = {
			...result,
			timestamp: Date.now(),
		};

		return result;
	}

	// Success!
	const result: ClaudeCliResolution = {
		path: resolvedPath,
		version,
		status: ClaudeCliHealthStatus.OK,
	};

	resolutionCache = {
		...result,
		timestamp: Date.now(),
	};

	console.log(
		`[claude-cli-resolver] Successfully resolved Claude CLI ${version.version} at ${resolvedPath}`,
	);

	return result;
}

/**
 * Performs a health check on the Claude CLI.
 * This is a convenience wrapper around `resolveClaudeCli` that returns
 * a simple status enum suitable for UI display.
 *
 * @param options - Resolution options (same as resolveClaudeCli)
 * @returns Health status enum
 */
export async function checkClaudeCliHealth(options?: {
	configuredPath?: string | null;
	skipCache?: boolean;
}): Promise<ClaudeCliHealthStatus> {
	const resolution = await resolveClaudeCli(options);
	return resolution.status;
}

/**
 * Gets the resolved CLI path from cache without re-resolution.
 * Returns null if not cached or if resolution failed.
 *
 * @returns Cached path or null
 */
export function getCachedCliPath(): string | null {
	return resolutionCache?.path ?? null;
}

/**
 * Gets the resolved CLI version from cache without re-resolution.
 * Returns null if not cached or if version check failed.
 *
 * @returns Cached version info or null
 */
export function getCachedCliVersion(): ClaudeVersionInfo | null {
	return resolutionCache?.version ?? null;
}
