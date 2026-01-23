import { useAtom } from "jotai"
import { useEffect, useState } from "react"
import {
  analyticsOptOutAtom,
  claudeCliPathAtom,
  ctrlTabTargetAtom,
  extendedThinkingEnabledAtom,
  soundNotificationsEnabledAtom,
  type CtrlTabTarget,
} from "../../../lib/atoms"
import { Kbd } from "../../ui/kbd"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "../../ui/select"
import { Switch } from "../../ui/switch"
import { Button } from "../../ui/button"
import { Input } from "../../ui/input"
import { Label } from "../../ui/label"
import { trpc } from "../../../lib/trpc"
import { RefreshCw, CheckCircle2, AlertTriangle, FolderOpen, ExternalLink } from "lucide-react"

// Hook to detect narrow screen
function useIsNarrowScreen(): boolean {
  const [isNarrow, setIsNarrow] = useState(false)

  useEffect(() => {
    const checkWidth = () => {
      setIsNarrow(window.innerWidth <= 768)
    }

    checkWidth()
    window.addEventListener("resize", checkWidth)
    return () => window.removeEventListener("resize", checkWidth)
  }, [])

  return isNarrow
}

export function AgentsPreferencesTab() {
  const [thinkingEnabled, setThinkingEnabled] = useAtom(
    extendedThinkingEnabledAtom,
  )
  const [soundEnabled, setSoundEnabled] = useAtom(soundNotificationsEnabledAtom)
  const [analyticsOptOut, setAnalyticsOptOut] = useAtom(analyticsOptOutAtom)
  const [ctrlTabTarget, setCtrlTabTarget] = useAtom(ctrlTabTargetAtom)
  const [claudeCliPath, setClaudeCliPath] = useAtom(claudeCliPathAtom)
  const [pathInputValue, setPathInputValue] = useState(claudeCliPath ?? "")
  const [pathValidationError, setPathValidationError] = useState<string | null>(null)
  const isNarrowScreen = useIsNarrowScreen()

  // Sync pathInputValue with atom
  useEffect(() => {
    setPathInputValue(claudeCliPath ?? "")
  }, [claudeCliPath])

  // Co-authored-by setting from Claude settings.json
  const { data: includeCoAuthoredBy, refetch: refetchCoAuthoredBy } =
    trpc.claudeSettings.getIncludeCoAuthoredBy.useQuery()
  const setCoAuthoredByMutation =
    trpc.claudeSettings.setIncludeCoAuthoredBy.useMutation({
      onSuccess: () => {
        refetchCoAuthoredBy()
      },
    })

  const handleCoAuthoredByToggle = (enabled: boolean) => {
    setCoAuthoredByMutation.mutate({ enabled })
  }

  // Claude CLI health check
  const { data: cliHealth, refetch: refetchCliHealth, isLoading: isLoadingCliHealth } =
    trpc.claude.checkCliHealth.useQuery(
      {
        configuredPath: claudeCliPath,
        skipCache: false,
      },
      {
        refetchOnMount: true,
      },
    )

  // Path validation mutation
  const validatePathMutation = trpc.claude.validateCliPath.useMutation({
    onSuccess: (data) => {
      if (data.valid) {
        setPathValidationError(null)
        setClaudeCliPath(pathInputValue)
        refetchCliHealth()
      } else {
        setPathValidationError(data.error ?? "Invalid path")
      }
    },
    onError: (error) => {
      setPathValidationError(error.message)
    },
  })

  // File picker mutation
  const openFilePickerMutation = trpc.claude.openCliPathPicker.useMutation({
    onSuccess: (selectedPath) => {
      if (selectedPath) {
        setPathInputValue(selectedPath)
        validatePathMutation.mutate(selectedPath)
      }
    },
  })

  const handleRefreshHealth = () => {
    refetchCliHealth()
  }

  const handlePathChange = (value: string) => {
    setPathInputValue(value)
    setPathValidationError(null)
  }

  const handlePathBlur = () => {
    if (pathInputValue.trim() === "") {
      // Clear path if empty
      setClaudeCliPath(null)
      setPathValidationError(null)
      refetchCliHealth()
    } else if (pathInputValue !== claudeCliPath) {
      // Validate if changed
      validatePathMutation.mutate(pathInputValue)
    }
  }

  const handleOpenFilePicker = () => {
    openFilePickerMutation.mutate()
  }

  const handleInstallCli = () => {
    window.desktopApi?.openExternal("https://claude.ai/download")
  }

  const isCliOk = cliHealth?.status === "OK"
  const isCliMissing = cliHealth?.status === "MISSING"
  const isCliIncompatible = cliHealth?.status === "VERSION_INCOMPATIBLE"
  const cliError = cliHealth?.message ?? cliHealth?.error ?? null

  // Sync opt-out status to main process
  const handleAnalyticsToggle = async (optedOut: boolean) => {
    setAnalyticsOptOut(optedOut)
    // Notify main process
    try {
      await window.desktopApi?.setAnalyticsOptOut(optedOut)
    } catch (error) {
      console.error("Failed to sync analytics opt-out to main process:", error)
    }
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header - hidden on narrow screens since it's in the navigation bar */}
      {!isNarrowScreen && (
        <div className="flex flex-col space-y-1.5 text-center sm:text-left">
          <h3 className="text-sm font-semibold text-foreground">Preferences</h3>
          <p className="text-xs text-muted-foreground">
            Configure Claude's behavior and features
          </p>
        </div>
      )}

      {/* Features Section */}
      <div className="bg-background rounded-lg border border-border overflow-hidden">
        <div className="p-4 space-y-6">
          {/* Extended Thinking Toggle */}
          <div className="flex items-start justify-between">
            <div className="flex flex-col space-y-1">
              <span className="text-sm font-medium text-foreground">
                Extended Thinking
              </span>
              <span className="text-xs text-muted-foreground">
                Enable deeper reasoning with more thinking tokens (uses more
                credits).{" "}
                <span className="text-foreground/70">Disables response streaming.</span>
              </span>
            </div>
            <Switch
              checked={thinkingEnabled}
              onCheckedChange={setThinkingEnabled}
            />
          </div>

          {/* Sound Notifications Toggle */}
          <div className="flex items-start justify-between">
            <div className="flex flex-col space-y-1">
              <span className="text-sm font-medium text-foreground">
                Sound Notifications
              </span>
              <span className="text-xs text-muted-foreground">
                Play a sound when agent completes work while you're away
              </span>
            </div>
            <Switch checked={soundEnabled} onCheckedChange={setSoundEnabled} />
          </div>

          {/* Co-Authored-By Toggle */}
          <div className="flex items-start justify-between">
            <div className="flex flex-col space-y-1">
              <span className="text-sm font-medium text-foreground">
                Include Co-Authored-By
              </span>
              <span className="text-xs text-muted-foreground">
                Add "Co-authored-by: Claude" to git commits made by Claude
              </span>
            </div>
            <Switch
              checked={includeCoAuthoredBy ?? true}
              onCheckedChange={handleCoAuthoredByToggle}
              disabled={setCoAuthoredByMutation.isPending}
            />
          </div>

          {/* Quick Switch */}
          <div className="flex items-start justify-between">
            <div className="flex flex-col space-y-1">
              <span className="text-sm font-medium text-foreground">
                Quick Switch
              </span>
              <span className="text-xs text-muted-foreground">
                What <Kbd>⌃Tab</Kbd> switches between
              </span>
            </div>
            <Select
              value={ctrlTabTarget}
              onValueChange={(value: CtrlTabTarget) => setCtrlTabTarget(value)}
            >
              <SelectTrigger className="w-auto px-2">
                <span className="text-xs">
                  {ctrlTabTarget === "workspaces" ? "Workspaces" : "Agents"}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="workspaces">Workspaces</SelectItem>
                <SelectItem value="agents">Agents</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Claude CLI Configuration Section */}
      <div className="space-y-2">
        <div className="pb-2">
          <h4 className="text-sm font-medium text-foreground">Claude CLI</h4>
          <p className="text-xs text-muted-foreground mt-1">
            Configure Claude CLI executable path
          </p>
        </div>

        <div className="bg-background rounded-lg border border-border overflow-hidden">
          <div className="p-4 space-y-4">
            {/* Health Indicator */}
            <div className="flex items-start justify-between">
              <div className="flex flex-col space-y-1 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">
                    Claude CLI Status
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    onClick={handleRefreshHealth}
                    disabled={isLoadingCliHealth}
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${isLoadingCliHealth ? "animate-spin" : ""}`}
                    />
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  {isCliOk ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                      <span className="text-xs text-muted-foreground">
                        Claude CLI: ✓ Detected
                        {cliHealth?.version && ` (v${cliHealth.version})`}
                      </span>
                    </>
                  ) : isCliMissing ? (
                    <>
                      <AlertTriangle className="h-4 w-4 text-yellow-500" />
                      <span className="text-xs text-muted-foreground">
                        ⚠ Not found
                      </span>
                    </>
                  ) : isCliIncompatible ? (
                    <>
                      <AlertTriangle className="h-4 w-4 text-yellow-500" />
                      <span className="text-xs text-muted-foreground">
                        ⚠ Version incompatible
                        {cliHealth?.version && ` (v${cliHealth.version})`}
                      </span>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="h-4 w-4 text-yellow-500" />
                      <span className="text-xs text-muted-foreground">
                        ⚠ {cliError ?? "Unknown error"}
                      </span>
                    </>
                  )}
                </div>
                {cliHealth?.path && (
                  <p className="text-xs text-muted-foreground/70 mt-1">
                    {cliHealth.path}
                  </p>
                )}
              </div>
            </div>

            {/* Actionable Errors */}
            {isCliMissing && (
              <div className="flex items-center gap-2 p-2 bg-yellow-500/10 border border-yellow-500/20 rounded-md">
                <AlertTriangle className="h-4 w-4 text-yellow-500 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-xs text-foreground font-medium">
                    Claude CLI not found
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Install Claude CLI to use this feature
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleInstallCli}
                  className="text-xs"
                >
                  <ExternalLink className="h-3 w-3 mr-1.5" />
                  Install Claude CLI
                </Button>
              </div>
            )}

            {isCliIncompatible && (
              <div className="flex items-start gap-2 p-2 bg-yellow-500/10 border border-yellow-500/20 rounded-md">
                <AlertTriangle className="h-4 w-4 text-yellow-500 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-xs text-foreground font-medium">
                    Upgrade Required
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Current version: {cliHealth?.version ?? "unknown"} (minimum: 2.0.0)
                  </p>
                </div>
              </div>
            )}

            {/* CLI Path Override Field */}
            <div className="space-y-2">
              <Label className="text-sm font-medium text-foreground">
                Custom Claude CLI path (optional)
              </Label>
              <div className="flex gap-2">
                <Input
                  value={pathInputValue}
                  onChange={(e) => handlePathChange(e.target.value)}
                  onBlur={handlePathBlur}
                  placeholder="Leave empty to use system PATH"
                  className={`flex-1 ${pathValidationError ? "border-destructive" : ""}`}
                  disabled={validatePathMutation.isPending}
                />
                <Button
                  variant="outline"
                  size="default"
                  onClick={handleOpenFilePicker}
                  disabled={openFilePickerMutation.isPending}
                >
                  <FolderOpen className="h-4 w-4 mr-1.5" />
                  Browse
                </Button>
              </div>
              {pathValidationError && (
                <p className="text-xs text-destructive">
                  {pathValidationError}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Privacy Section */}
      <div className="space-y-2">
        <div className="pb-2">
          <h4 className="text-sm font-medium text-foreground">Privacy</h4>
          <p className="text-xs text-muted-foreground mt-1">
            Control what data you share with us
          </p>
        </div>

        <div className="bg-background rounded-lg border border-border overflow-hidden">
          <div className="p-4">
            {/* Share Usage Analytics */}
            <div className="flex items-start justify-between">
              <div className="flex flex-col space-y-1">
                <span className="text-sm font-medium text-foreground">
                  Share Usage Analytics
                </span>
                <span className="text-xs text-muted-foreground">
                  Help us improve Agents by sharing anonymous usage data. We only track feature usage and app performance–never your code, prompts, or messages. No AI training on your data.
                </span>
              </div>
              <Switch
                checked={!analyticsOptOut}
                onCheckedChange={(enabled) => handleAnalyticsToggle(!enabled)}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
