// ============================================================================
// US Equity Market Status — same logic as main app's MarketStatusService
// Lightweight version for Node.js (no MobX, no intervals)
// ============================================================================

export type MarketSession = "open" | "pre-market" | "after-hours" | "closed";

interface EasternTime {
  hours: number;
  minutes: number;
  dayOfWeek: number;
  totalMinutes: number;
}

function getEasternTime(): EasternTime {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  }).formatToParts(now);

  let hours = 0;
  let minutes = 0;
  let weekday = "";

  for (const p of parts) {
    if (p.type === "hour") hours = parseInt(p.value, 10);
    if (p.type === "minute") minutes = parseInt(p.value, 10);
    if (p.type === "weekday") weekday = p.value;
  }
  if (hours === 24) hours = 0;

  const dayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };

  return {
    hours,
    minutes,
    dayOfWeek: dayMap[weekday] ?? now.getDay(),
    totalMinutes: hours * 60 + minutes,
  };
}

export function getMarketSession(): MarketSession {
  const et = getEasternTime();

  if (et.dayOfWeek === 0 || et.dayOfWeek === 6) return "closed";

  const t = et.totalMinutes;
  if (t >= 570 && t < 960) return "open";         // 09:30–16:00
  if (t >= 240 && t < 570) return "pre-market";    // 04:00–09:30
  if (t >= 960 && t < 1200) return "after-hours";  // 16:00–20:00
  return "closed";
}

export function isMarketTrading(): boolean {
  const s = getMarketSession();
  return s === "open" || s === "pre-market" || s === "after-hours";
}

export function getMarketStatusDescription(): string {
  const session = getMarketSession();
  switch (session) {
    case "open": return "Market OPEN (09:30–16:00 ET)";
    case "pre-market": return "PRE-MARKET (04:00–09:30 ET)";
    case "after-hours": return "AFTER-HOURS (16:00–20:00 ET)";
    case "closed": return "Market CLOSED";
  }
}
