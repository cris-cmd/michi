import { useState } from "react";
import QRCode from "qrcode";
import { useStore } from "../flow/store";
import { activityById, partyCostJpy } from "../data/activities";
import { useSettings } from "../flow/settings";
import { t } from "../i18n";

function makeCode(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `MCH-${s}`;
}

// confirm → Reserve → 3-field demo checkout → 1.5s processing → code + QR.
// Booking promotes the proposed calendar item to reserved (store/engine).
export default function Booking({
  onReserve,
  onPaid,
}: {
  onReserve: () => void;
  onPaid: (code: string) => void;
}) {
  const stage = useStore((s) => s.stage);
  const selection = useStore((s) => s.selection);
  const booking = useStore((s) => s.booking);
  const party = useStore((s) => s.party);
  const plan = useStore((s) => s.plan);
  const locale = useSettings((s) => s.language);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [card, setCard] = useState("4242 4242 4242 4242");
  const [processing, setProcessing] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

  const a = selection ? activityById.get(selection) : undefined;
  if (!a) return null;

  const planned = plan.days.flatMap((d) => d.items).find((i) => i.activityId === a.id);
  const alreadyReserved = plan.days.some((d) =>
    d.items.some((i) => i.status === "reserved" && i.activityId === a.id),
  );
  const cost = partyCostJpy(a, party);
  const partyLabel = [
    `${party.adults} adults`,
    party.children ? `${party.children} children` : null,
    party.infants ? `${party.infants} infant` : null,
  ]
    .filter(Boolean)
    .join(", ");

  if (stage === "confirm") {
    return (
      <div className="card-enter rounded-xl border border-accent bg-panel p-4 shadow-sm">
        <p className="text-[10px] font-bold tracking-widest text-accent uppercase">{t(locale, "readyToBook")}</p>
        <h3 className="mt-1 text-[15px] font-semibold">{a.name}</h3>
        <p className="mt-0.5 text-xs text-muted">
          {planned ? `Today ${planned.startAt}–${planned.endAt} · ` : ""}
          {partyLabel} · ¥{cost.toLocaleString("en-US")}
        </p>
        <button
          onClick={onReserve}
          disabled={alreadyReserved}
          className="mt-3 w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {alreadyReserved ? `✓ ${t(locale, "reserved")}` : t(locale, "reserve")}
        </button>
        <button
          type="button"
          onClick={() => useStore.getState().cancelCheckout()}
          className="w-full rounded-lg border border-line bg-panel py-2 text-xs font-medium text-muted transition-colors hover:text-text"
        >
          {t(locale, "notNow")}
        </button>
      </div>
    );
  }

  if (stage === "checkout" && !booking) {
    const pay = async (e: React.FormEvent) => {
      e.preventDefault();
      setProcessing(true);
      const code = makeCode();
      const dataUrl = await QRCode.toDataURL(`michi:${code}:${a.id}`, {
        margin: 1,
        width: 150,
        color: { dark: "#0f172a", light: "#ffffff" },
      });
      // fake the processor
      await new Promise((res) => setTimeout(res, 1500));
      setQr(dataUrl);
      setProcessing(false);
      onPaid(code);
    };

    return (
      <form onSubmit={pay} className="card-enter space-y-2.5 rounded-xl border border-line bg-panel p-4 shadow-sm">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[15px] font-semibold">{a.name}</h3>
          <span className="text-sm font-medium">¥{cost.toLocaleString("en-US")}</span>
        </div>
        <input
          required
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <input
          required
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <input
          required
          value={card}
          onChange={(e) => setCard(e.target.value)}
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={processing}
          className="w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {processing ? t(locale, "processing") : t(locale, "confirmBooking")}
        </button>
        {!processing && (
          <button
            type="button"
            onClick={() => useStore.getState().cancelCheckout()}
            className="w-full rounded-lg border border-line bg-panel py-2 text-xs font-medium text-muted transition-colors hover:text-text"
          >
            {t(locale, "notNow")}
          </button>
        )}
        <p className="text-center text-[10px] text-faint">{t(locale, "checkoutNote")}</p>
      </form>
    );
  }

  if (booking) {
    return (
      <div className="card-enter rounded-xl border border-ok bg-ok-soft p-4 text-center shadow-sm">
        <p className="text-[10px] font-bold tracking-widest text-ok uppercase">{t(locale, "reservedDemo")}</p>
        <p className="mt-1.5 font-mono text-xl font-semibold tracking-widest">{booking.code}</p>
        <p className="mt-0.5 text-xs text-muted">
          {a.name}
          {planned ? ` · Today ${planned.startAt}` : ""}
        </p>
        {qr && <img src={qr} alt={booking.code} className="mx-auto mt-3 rounded-lg" />}
      </div>
    );
  }

  return null;
}
