import { useEffect, useRef } from "react";
import { useStore } from "../flow/store";

// Clean contemporary chat: Michi left, guest right.

export default function Transcript() {
  const transcript = useStore((s) => s.transcript);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [transcript.length]);

  return (
    <div className="space-y-3">
      {transcript.map((t, i) => (
        <div key={i} className={`fade-in flex ${t.who === "guest" ? "justify-end" : "justify-start"}`}>
          {t.who === "guest" ? (
            <div className="max-w-[78%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm leading-relaxed text-white shadow-sm">
              {t.text}
            </div>
          ) : (
            <div className="max-w-[85%]">
              <p className="mb-0.5 text-[11px] font-medium text-faint">Michi</p>
              <div className="rounded-2xl rounded-tl-md border border-line bg-panel px-4 py-2.5 text-sm leading-relaxed shadow-sm">
                {t.text}
              </div>
            </div>
          )}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
