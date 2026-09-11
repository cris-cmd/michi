import { useEffect, useState } from "react";

// kit.ts broadcasts presenter status as a window event (it lives outside
// React). "Ready" = the embodied avatar is live.
export function useKitStatus(): string {
  const [status, setStatus] = useState("");
  useEffect(() => {
    const onStatus = (e: Event) => setStatus(String((e as CustomEvent).detail ?? ""));
    window.addEventListener("michi:kit-status", onStatus);
    return () => window.removeEventListener("michi:kit-status", onStatus);
  }, []);
  return status;
}
