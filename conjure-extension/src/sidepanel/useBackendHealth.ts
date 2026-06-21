// Backend connectivity controller. Polls the backend's GET /health on mount and
// on an interval so the side panel can show whether the API server is reachable
// — independent of the lazily-opened chat websocket. SRP: owns only this signal.
import { useEffect, useState } from "react";
import { CONJURE_CONFIG } from "../shared/config";

export type BackendHealth = "checking" | "online" | "offline";

export function useBackendHealth(intervalMs = 10000): BackendHealth {
  const [health, setHealth] = useState<BackendHealth>("checking");

  useEffect(() => {
    let cancelled = false;

    const ping = async () => {
      try {
        const response = await fetch(`${CONJURE_CONFIG.backendUrl}/health`, { cache: "no-store" });
        if (!cancelled) setHealth(response.ok ? "online" : "offline");
      } catch {
        if (!cancelled) setHealth("offline");
      }
    };

    void ping();
    const timer = setInterval(ping, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs]);

  return health;
}
