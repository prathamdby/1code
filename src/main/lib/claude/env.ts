import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { app } from "electron"
import { stripVTControlCharacters } from "node:util"

// Cache the shell environment
let cachedShellEnv: Record<string, string> | null = null

// Delimiter for parsing env output
const DELIMITER = "_CLAUDE_ENV_DELIMITER_"

// Keys to strip (prevent auth interference)
const STRIPPED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
]

// Cache the bundled binary path (only compute once)
let cachedBinaryPath: string | null = null
let binaryPathComputed = false

/**
 * Get path to the bundled Claude binary.
 * Returns the path to the native Claude executable bundled with the app.
 * CACHED - only computes path once and logs verbose info on first call.
 * 
 * @deprecated Use system CLI resolver instead: resolveClaudeCli() from ./system-cli-resolver
 * This function is kept for backwards compatibility but should not be used for new code.
 * The bundled binary approach is being phased out in favor of system-installed CLI.
 */
export function getBundledClaudeBinaryPath(): string {
  // Return cached path if already computed
  if (binaryPathComputed) {
    return cachedBinaryPath!
  }

  const isDev = !app.isPackaged
  const platform = process.platform
  const arch = process.arch

  // Only log verbose info on first call
  if (process.env.DEBUG_CLAUDE_BINARY) {
    console.log("[claude-binary] ========== BUNDLED BINARY PATH ==========")
    console.log("[claude-binary] isDev:", isDev)
    console.log("[claude-binary] platform:", platform)
    console.log("[claude-binary] arch:", arch)
    console.log("[claude-binary] appPath:", app.getAppPath())
  }

  // In dev: apps/desktop/resources/bin/{platform}-{arch}/claude
  // In production: {resourcesPath}/bin/claude
  const resourcesPath = isDev
    ? path.join(app.getAppPath(), "resources/bin", `${platform}-${arch}`)
    : path.join(process.resourcesPath, "bin")

  if (process.env.DEBUG_CLAUDE_BINARY) {
    console.log("[claude-binary] resourcesPath:", resourcesPath)
  }

  const binaryName = platform === "win32" ? "claude.exe" : "claude"
  const binaryPath = path.join(resourcesPath, binaryName)

  if (process.env.DEBUG_CLAUDE_BINARY) {
    console.log("[claude-binary] binaryPath:", binaryPath)
  }

  // Check if binary exists
  const exists = fs.existsSync(binaryPath)

  // Always log if binary doesn't exist (critical error)
  if (!exists) {
    console.error("[claude-binary] WARNING: Binary not found at path:", binaryPath)
    console.error("[claude-binary] Run 'bun run claude:download' to download it")
  } else if (process.env.DEBUG_CLAUDE_BINARY) {
    const stats = fs.statSync(binaryPath)
    const sizeMB = (stats.size / 1024 / 1024).toFixed(1)
    const isExecutable = (stats.mode & fs.constants.X_OK) !== 0
    console.log("[claude-binary] exists:", exists)
    console.log("[claude-binary] size:", sizeMB, "MB")
    console.log("[claude-binary] isExecutable:", isExecutable)
    console.log("[claude-binary] ===========================================")
  }

  // Cache the result
  cachedBinaryPath = binaryPath
  binaryPathComputed = true

  return binaryPath
}

/**
 * Parse environment variables from shell output
 */
function parseEnvOutput(output: string): Record<string, string> {
  const envSection = output.split(DELIMITER)[1]
  if (!envSection) return {}

  const env: Record<string, string> = {}
  for (const line of stripVTControlCharacters(envSection)
    .split("\n")
    .filter(Boolean)) {
    const separatorIndex = line.indexOf("=")
    if (separatorIndex > 0) {
      const key = line.substring(0, separatorIndex)
      const value = line.substring(separatorIndex + 1)
      env[key] = value
    }
  }
  return env
}

/**
 * Get platform-appropriate shell executable.
 * Windows: COMSPEC (usually cmd.exe) or PowerShell
 * macOS/Linux: SHELL env var or /bin/zsh
 */
function getShellExecutable(): string {
  if (process.platform === "win32") {
    // Windows: prefer COMSPEC (usually C:\Windows\System32\cmd.exe)
    // Fallback to PowerShell if COMSPEC is not set
    return process.env.COMSPEC || "powershell.exe"
  }
  // macOS/Linux: use SHELL env var or default to zsh
  return process.env.SHELL || "/bin/zsh"
}

/**
 * Build Windows PATH by combining process.env.PATH with common install locations.
 * Windows packaged apps via NSIS may have reduced PATH; this fallback ensures
 * common install locations are checked.
 */
function buildWindowsPath(): string {
  const paths: string[] = []
  const pathSeparator = ";"

  // Start with existing PATH from process.env
  if (process.env.PATH) {
    paths.push(...process.env.PATH.split(pathSeparator).filter(Boolean))
  }

  // Add Windows-specific common paths for Claude installations
  const commonPaths = [
    // User-local installations
    path.join(os.homedir(), ".local", "bin"),
    // Program Files installations (both 32-bit and 64-bit)
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Claude"),
    path.join(
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      "Claude",
    ),
    // Local AppData installations (common for Electron apps)
    path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "Programs",
      "Claude",
    ),
    // System paths
    path.join(process.env.SystemRoot || "C:\\Windows", "System32"),
    path.join(process.env.SystemRoot || "C:\\Windows"),
  ]

  // Add common paths that aren't already in PATH
  for (const commonPath of commonPaths) {
    const normalizedPath = path.normalize(commonPath)
    if (!paths.includes(normalizedPath)) {
      paths.push(normalizedPath)
    }
  }

  const finalPath = paths.join(pathSeparator)
  console.log(
    `[claude-env] Built Windows PATH with ${paths.length} entries (${finalPath.length} chars)`,
  )
  return finalPath
}

/**
 * Load full shell environment using login shell (non-interactive).
 * This captures PATH, HOME, and all shell profile configurations.
 * Results are cached for the lifetime of the process.
 *
 * On Windows: Derives PATH directly from process.env + common locations
 * (no shell invocation needed, avoids cmd.exe/PowerShell complexity).
 *
 * On macOS/Linux: Uses shell with -lc flags (login, command) instead of -ilc
 * to avoid interactive prompts and TTY issues from dotfiles expecting a terminal.
 */
export function getClaudeShellEnvironment(): Record<string, string> {
  if (cachedShellEnv !== null) {
    return { ...cachedShellEnv }
  }

  // Windows: derive PATH without shell invocation
  if (process.platform === "win32") {
    console.log("[claude-env] Windows detected, deriving PATH without shell invocation")
    const env: Record<string, string> = {
      ...process.env,
      PATH: buildWindowsPath(),
      HOME: os.homedir(),
      USER: os.userInfo().username,
      USERPROFILE: os.homedir(),
    }

    // Strip keys that could interfere with Claude's auth resolution
    for (const key of STRIPPED_ENV_KEYS) {
      if (key in env) {
        console.log(`[claude-env] Stripped ${key} from shell environment`)
        delete env[key]
      }
    }

    console.log(
      `[claude-env] Loaded ${Object.keys(env).length} environment variables (Windows)`,
    )
    cachedShellEnv = env
    return { ...env }
  }

  // macOS/Linux: use shell to get full environment
  const shell = getShellExecutable()
  const command = `echo -n "${DELIMITER}"; env; echo -n "${DELIMITER}"; exit`

  try {
    // Use -lc flags (not -ilc):
    // -l: login shell (sources .zprofile/.profile for PATH setup)
    // -c: execute command
    // Avoids -i (interactive) to skip TTY prompts and reduce latency
    const output = execSync(`${shell} -lc '${command}'`, {
      encoding: "utf8",
      timeout: 5000,
      env: {
        // Prevent Oh My Zsh from blocking with auto-update prompts
        DISABLE_AUTO_UPDATE: "true",
        // Minimal env to bootstrap the shell
        HOME: os.homedir(),
        USER: os.userInfo().username,
        SHELL: shell,
      },
    })

    const env = parseEnvOutput(output)

    // Strip keys that could interfere with Claude's auth resolution
    for (const key of STRIPPED_ENV_KEYS) {
      if (key in env) {
        console.log(`[claude-env] Stripped ${key} from shell environment`)
        delete env[key]
      }
    }

    console.log(
      `[claude-env] Loaded ${Object.keys(env).length} environment variables from shell`,
    )
    cachedShellEnv = env
    return { ...env }
  } catch (error) {
    console.error("[claude-env] Failed to load shell environment:", error)

    // Fallback: return minimal required env
    const home = os.homedir()
    const pathSeparator = process.platform === "win32" ? ";" : ":"
    const fallbackPathParts =
      process.platform === "win32"
        ? [
            // Windows fallback paths
            path.join(home, ".local", "bin"),
            path.join(process.env.ProgramFiles || "C:\\Program Files", "Claude"),
            path.join(
              process.env.LOCALAPPDATA ||
                path.join(home, "AppData", "Local"),
              "Programs",
              "Claude",
            ),
            path.join(
              process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
              "Claude",
            ),
            path.join(process.env.SystemRoot || "C:\\Windows", "System32"),
          ]
        : [
            // Unix fallback paths
            `${home}/.local/bin`,
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
          ]

    const fallbackPath = fallbackPathParts.join(pathSeparator)

    const fallback: Record<string, string> = {
      HOME: home,
      USER: os.userInfo().username,
      PATH: fallbackPath,
      SHELL: getShellExecutable(),
      TERM: process.platform === "win32" ? undefined : "xterm-256color",
    }

    // Add Windows-specific env vars
    if (process.platform === "win32") {
      fallback.USERPROFILE = home
      fallback.SystemRoot = process.env.SystemRoot || "C:\\Windows"
    }

    console.log("[claude-env] Using fallback environment")
    cachedShellEnv = fallback
    return { ...fallback }
  }
}

/**
 * Build the complete environment for Claude SDK.
 * Merges shell environment, process.env, and custom overrides.
 */
export function buildClaudeEnv(options?: {
  ghToken?: string
  customEnv?: Record<string, string>
}): Record<string, string> {
  const env: Record<string, string> = {}

  // 1. Start with shell environment (has HOME, full PATH, etc.)
  try {
    Object.assign(env, getClaudeShellEnvironment())
  } catch (error) {
    console.error("[claude-env] Shell env failed, using process.env")
  }

  // 2. Overlay current process.env (preserves Electron-set vars)
  // BUT: Don't overwrite PATH from shell env - Electron's PATH is minimal when launched from Finder
  const shellPath = env.PATH
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  // Restore shell PATH if we had one (it contains nvm, homebrew, etc.)
  if (shellPath) {
    env.PATH = shellPath
  }

  // 3. Ensure critical vars are present
  if (!env.HOME) env.HOME = os.homedir()
  if (!env.USER) env.USER = os.userInfo().username
  if (!env.SHELL) env.SHELL = getShellExecutable()
  if (!env.TERM && process.platform !== "win32") env.TERM = "xterm-256color"
  
  // Windows-specific env vars
  if (process.platform === "win32") {
    if (!env.USERPROFILE) env.USERPROFILE = os.homedir()
    if (!env.SystemRoot) env.SystemRoot = process.env.SystemRoot || "C:\\Windows"
  }

  // 4. Add custom overrides
  if (options?.ghToken) {
    env.GH_TOKEN = options.ghToken
  }
  if (options?.customEnv) {
    for (const [key, value] of Object.entries(options.customEnv)) {
      if (value === "") {
        delete env[key]
      } else {
        env[key] = value
      }
    }
  }

  // 5. Mark as SDK entry
  env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts"

  return env
}

/**
 * Clear cached shell environment (useful for testing)
 */
export function clearClaudeEnvCache(): void {
  cachedShellEnv = null
}

/**
 * Debug: Log key environment variables
 */
export function logClaudeEnv(
  env: Record<string, string>,
  prefix: string = "",
): void {
  console.log(`${prefix}[claude-env] HOME: ${env.HOME}`)
  console.log(`${prefix}[claude-env] USER: ${env.USER}`)
  console.log(
    `${prefix}[claude-env] PATH includes homebrew: ${env.PATH?.includes("/opt/homebrew")}`,
  )
  console.log(
    `${prefix}[claude-env] PATH includes /usr/local/bin: ${env.PATH?.includes("/usr/local/bin")}`,
  )
  console.log(
    `${prefix}[claude-env] ANTHROPIC_AUTH_TOKEN: ${env.ANTHROPIC_AUTH_TOKEN ? "set" : "not set"}`,
  )
}
