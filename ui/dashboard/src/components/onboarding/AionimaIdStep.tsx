/**
 * AionimaIdStep — Identity & OAuth connection step.
 *
 * As of s180, identity management is built into the AGI gateway (no separate
 * Local-ID service). This step confirms the gateway's identity system is
 * reachable and shows connected OAuth providers.
 */

import { useCallback, useEffect, useState } from "react";
import { Callout } from "@particle-academy/react-fancy";
import { Card } from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import type { OnboardingStepStatus, OnboardingState } from "@/types.js";

interface Props {
  onNext: () => void;
  onSkip: () => void;
  status?: OnboardingStepStatus;
  idMode?: OnboardingState["idMode"];
}

export function AionimaIdStep({ onNext, onSkip, status }: Props) {
  const [idStatus, setIdStatus] = useState<"checking" | "healthy" | "unreachable">("checking");
  const [idUrl, setIdUrl] = useState<string | null>(null);
  const [connectedServices, setConnectedServices] = useState<Array<{ provider: string; role: string; accountLabel: string | null }>>([]);

  const isCompleted = status === "completed";

  const checkIdService = useCallback(async () => {
    setIdStatus("checking");
    try {
      // Get ID service URL from AGI backend (now the gateway itself)
      const urlRes = await fetch("/api/onboarding/id-service-url");
      if (urlRes.ok) {
        const { url } = await urlRes.json() as { url: string };
        setIdUrl(url);
      }
      // The gateway serves identity routes directly; check /health as proxy for readiness
      const healthRes = await fetch("/health");
      if (healthRes.ok) {
        setIdStatus("healthy");
        // Fetch connected services via AGI backend proxy
        try {
          const statusRes = await fetch("/api/onboarding/aionima-id/status");
          if (statusRes.ok) {
            const statusData = await statusRes.json() as { services?: Array<{ provider: string; role: string }> };
            if (statusData.services) {
              setConnectedServices(statusData.services.map((s) => ({ ...s, accountLabel: null })));
            }
          }
        } catch { /* non-fatal */ }
      } else {
        setIdStatus("unreachable");
      }
    } catch {
      setIdStatus("unreachable");
    }
  }, []);

  useEffect(() => { void checkIdService(); }, [checkIdService]);

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      <div className="onboard-animate-in">
        <h2 className="text-xl sm:text-2xl font-semibold mb-1">
          Connect your Identity
        </h2>
        <p className="text-[13px] sm:text-sm text-muted-foreground leading-relaxed">
          Aion's identity system is built into the gateway — authentication, OAuth connections,
          and entity registration are managed here, with no separate service to install.
        </p>
      </div>

      {isCompleted && (
        <Callout color="green" className="text-sm text-muted-foreground onboard-animate-in">
          Identity service is connected. Continue to keep the current configuration.
        </Callout>
      )}

      <Card className="p-5 onboard-animate-in onboard-stagger-1">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary font-bold text-sm">
              ID
            </div>
            <div>
              <div className="text-[13px] font-semibold">Identity Service</div>
              <div className="text-[11px] text-muted-foreground font-mono">
                {idUrl ?? "Resolving..."}
              </div>
            </div>
          </div>

          {idStatus === "checking" && (
            <span className="text-[11px] text-muted-foreground">Checking...</span>
          )}
          {idStatus === "healthy" && (
            <Badge variant="outline" className="text-green border-green/50">Connected</Badge>
          )}
          {idStatus === "unreachable" && (
            <Badge variant="outline" className="text-red border-red/50">Unreachable</Badge>
          )}
        </div>

        {idStatus === "unreachable" && (
          <div className="mt-3 space-y-2">
            <p className="text-[11px] text-red">
              Cannot reach the gateway identity service. Make sure the AGI gateway is
              running and the Caddy reverse proxy is configured.
            </p>
            <Button variant="outline" size="sm" onClick={() => void checkIdService()}>
              Retry
            </Button>
          </div>
        )}

        {idStatus === "healthy" && connectedServices.length > 0 && (
          <div className="mt-3 pt-3 border-t border-border">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
              Connected Services
            </div>
            <div className="flex flex-wrap gap-2">
              {connectedServices.map((svc) => (
                <Badge key={`${svc.provider}-${svc.role}`} variant="secondary" className="text-[10px]">
                  {svc.provider} {svc.accountLabel ? `(${svc.accountLabel})` : ""}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {idStatus === "healthy" && idUrl && (
          <div className="mt-3 pt-3 border-t border-border">
            <p className="text-[11px] text-muted-foreground mb-2">
              Manage your OAuth connections (GitHub, Google, Discord) in Settings → Identity:
            </p>
            <a
              href={idUrl ?? "/settings/identity"}
              target={idUrl ? "_blank" : undefined}
              rel="noopener noreferrer"
              className="text-[12px] text-primary underline font-mono"
            >
              Open Identity Settings →
            </a>
          </div>
        )}
      </Card>

      <div className="flex gap-3 onboard-animate-in onboard-stagger-2">
        <Button
          onClick={onNext}
          disabled={idStatus !== "healthy" && !isCompleted}
        >
          Continue
        </Button>
        <Button variant="ghost" onClick={onSkip}>
          Skip for now
        </Button>
      </div>
    </div>
  );
}
