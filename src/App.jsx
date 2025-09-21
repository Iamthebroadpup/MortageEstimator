import React, { useMemo, useState } from "react";
import { Download, Plus, Trash2, TrendingUp, Wallet, Settings, Info } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, Legend as RLegend,
  LineChart, Line, ResponsiveContainer, ReferenceLine
} from "recharts";

/* =============== Helpers =============== */
const toMonthlyRate = (annualPct) => annualPct / 100 / 12;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function irr(cashflows, guess = 0.05) {
  let rate = guess;
  for (let i = 0; i < 100; i++) {
    let npv = 0, d = 0;
    for (let t = 0; t < cashflows.length; t++) {
      const denom = Math.pow(1 + rate, t);
      npv += cashflows[t] / denom;
      d   -= t * cashflows[t] / (denom * (1 + rate));
    }
    const next = rate - npv / d;
    if (!isFinite(next)) break;
    if (Math.abs(next - rate) < 1e-7) return next;
    rate = next;
  }
  return rate;
}
function npv(discountRateAnnualPct, cashflowsMonthly) {
  const r = discountRateAnnualPct / 100 / 12;
  return cashflowsMonthly.reduce((acc, cf, t) => acc + cf / Math.pow(1 + r, t), 0);
}
function pmt(principal, annualRatePct, termMonths) {
  const r = toMonthlyRate(annualRatePct);
  if (r === 0) return principal / termMonths;
  return (principal * r) / (1 - Math.pow(1 + r, -termMonths));
}

/* =============== Core engine =============== */
function buildSchedule({
  price,
  down,
  bankType,
  bankRate,
  bankTermYears,
  arm: { margin = 2.0, caps = { first: 2, periodic: 2, lifetime: 5 }, indexForecast = [] } = {},
  ioMonths = 0,
  pointsPct = 0,
  closingCosts = 0,
  family: {
    amount: famAmt = 0,
    rate: famRate = 4.5,
    termYears: famYears = 30,
    mode = "amortized",               // "amortized" | "interest_only"
    altAnnualPct = 5,                 // what family could earn elsewhere
    altTaxPct = 30,                   // tax applied to the alt return (if NOT lending)
    reinvestAnnualPct = 5,            // what family earns reinvesting repayments from you
  } = {},
  taxPct = 1.2, taxInflationPct = 2.5,
  insuranceAnnual = 2000, insuranceInflationPct = 3,
  hoaMonthly = 0, maintPctAnnual = 1, utilitiesMonthly = 0,
  escrow = true,
  pmi: { enabled: pmiEnabled = true, dropLTV = 0.78, pmiPctAnnual = 0.6 } = {},
  prepay: { monthlyExtra = 0, lumpSums = [] } = {},
  horizonYears = 30,
  discountRatePct = 5.0,
}) {
  const termMonths = bankTermYears * 12;
  const horizonMonths = horizonYears * 12;

  // Principals
  const principalBankFull = price - down;                  // if no family loan
  const principalBank = Math.max(principalBankFull - famAmt, 0); // actual bank principal

  // Upfront
  const pointsCost = principalBank * (pointsPct / 100);
  const cashToClose = down + closingCosts + pointsCost;

  // PMI
  const initLTV = principalBank / price;
  const pmiMonthlyBase = pmiEnabled && initLTV > 0.8 ? (principalBank * (pmiPctAnnual / 100)) / 12 : 0;

  // Tax/Ins bases
  const taxMonthly0 = (taxPct / 100) * price / 12;
  const insMonthly0 = insuranceAnnual / 12;

  // Family amortization
  const famTermMonths = famYears * 12;
  const famMonthly = famAmt > 0
    ? (mode === "interest_only" ? (famAmt * toMonthlyRate(famRate)) : pmt(famAmt, famRate, famTermMonths))
    : 0;

  // Bank fixed payment (if fixed)
  const bankMonthlyFixed = bankType === "fixed" ? pmt(principalBank, bankRate, termMonths) : 0;

  // ARM path
  const indexPath = new Array(bankTermYears)
    .fill(0)
    .map((_, i) => indexForecast[i] ?? indexForecast[indexForecast.length - 1] ?? 0);
  const armCeiling = bankRate + caps.lifetime;

  // Run schedule
  const rows = [];
  let bal = principalBank;
  let famBal = famAmt;
  let currentRate = bankRate;
  let pmiActive = pmiMonthlyBase > 0;

  let cumFamilyInterest = 0;
  let reinvestBal = 0;
  let cumReinvestEarnings = 0;

  for (let m = 1; m <= Math.min(horizonMonths, 720); m++) {
    const year = Math.ceil(m / 12);

    // Drifted tax/ins
    const taxMonthly = taxMonthly0 * Math.pow(1 + taxInflationPct / 100, year - 1);
    const insMonthly = insMonthly0 * Math.pow(1 + insuranceInflationPct / 100, year - 1);

    // ----- Bank payment
    let bankPayment = 0, bankInterest = 0, bankPrincipalPaid = 0;
    if (principalBank > 0 && bal > 0 && m <= termMonths) {
      if (bankType === "fixed") {
        bankPayment = bankMonthlyFixed;
      } else if (bankType === "io" && m <= ioMonths) {
        bankInterest = bal * toMonthlyRate(bankRate);
        bankPayment = bankInterest;
      } else if (bankType === "arm") {
        if (m === 1) currentRate = bankRate;
        if (m > 1 && (m - 1) % 12 === 0) {
          const resetIdx = Math.floor((m - 1) / 12);
          const desired = (indexPath[resetIdx] ?? 0) + margin;
          const lastRate = currentRate;
          const upCap = resetIdx === 1 ? caps.first : caps.periodic;
          currentRate = clamp(desired, lastRate - upCap, lastRate + upCap);
          currentRate = Math.min(currentRate, armCeiling);
        }
        const remaining = termMonths - (m - 1);
        bankPayment = pmt(bal, currentRate, Math.max(remaining, 1));
      } else if (bankType === "io") {
        const remaining = termMonths - (m - ioMonths);
        bankPayment = pmt(bal, bankRate, Math.max(remaining, 1));
      }

      if (!(bankType === "io" && m <= ioMonths)) {
        bankInterest = bal * toMonthlyRate(bankType === "arm" ? currentRate : bankRate);
      }
      bankPrincipalPaid = Math.max(bankPayment - bankInterest, 0);

      // Prepay (monthly + lumps)
      let prepayThisMonth = monthlyExtra;
      const lumps = lumpSums.filter(ls => ls.month === m).reduce((s, ls) => s + ls.amount, 0);
      prepayThisMonth += lumps;

      const principalReduction = Math.min(bankPrincipalPaid + prepayThisMonth, bal);
      bal -= principalReduction;
    }

    // PMI toggle
    if (pmiActive) {
      const ltv = bal / price;
      if (ltv <= dropLTV || bal <= 0) pmiActive = false;
    }
    const pmiMonthly = pmiActive ? pmiMonthlyBase : 0;

    // ----- Family payment
    let famPayment = 0, famInterest = 0, famPrincipalPaid = 0;
    if (famBal > 0) {
      if (mode === "interest_only") {
        famInterest = famBal * toMonthlyRate(famRate);
        famPayment = famInterest;
      } else {
        famPayment = famMonthly;
        famInterest = famBal * toMonthlyRate(famRate);
        famPrincipalPaid = Math.min(Math.max(famPayment - famInterest, 0), famBal);
        famBal -= famPrincipalPaid;
      }
      cumFamilyInterest += famInterest;
    }

    // --- Family reinvest earnings on received payments (assumed untaxed per your note)
    const rReinvest = toMonthlyRate(reinvestAnnualPct);
    const reinvestEarnings = reinvestBal * rReinvest;
    reinvestBal = reinvestBal * (1 + rReinvest) + famPayment;
    cumReinvestEarnings += reinvestEarnings;

    // Carrying costs
    const escrowItems = escrow ? (taxMonthly + insMonthly) : 0;
    const carryingFixed = hoaMonthly + utilitiesMonthly + (price * (maintPctAnnual / 100) / 12);
    const totalMonthly = (bankPayment || 0) + famPayment + pmiMonthly + escrowItems + carryingFixed;

    // Household delta:
    //  + alt return on remaining family balance (AFTER TAX)
    //  - interest family earns from you
    //  - reinvest earnings they make on repayments (untaxed per assumption)
    const altReturnGross = famBal * toMonthlyRate(altAnnualPct);
    const altReturnAfterTax = altReturnGross * (1 - altTaxPct / 100);
    const householdDelta = altReturnAfterTax - famInterest - reinvestEarnings;

    const totalMonthlyHousehold = totalMonthly + householdDelta;

    // Equity approx
    const equity = price - bal - famBal;

    rows.push({
      m, year,
      bankPayment: +(bankPayment || 0).toFixed(2),
      bankInterest: +bankInterest.toFixed(2),
      bankPrincipal: +bankPrincipalPaid.toFixed(2),
      bankBalance: +Math.max(bal, 0).toFixed(2),

      famPayment: +famPayment.toFixed(2),
      famInterest: +famInterest.toFixed(2),
      famPrincipal: +famPrincipalPaid.toFixed(2),
      famBalance: +Math.max(famBal, 0).toFixed(2),

      pmi: +pmiMonthly.toFixed(2),
      tax: +taxMonthly.toFixed(2),
      ins: +insMonthly.toFixed(2),
      hoa: +hoaMonthly.toFixed(2),
      maint: +((price * (maintPctAnnual / 100)) / 12).toFixed(2),
      util: +utilitiesMonthly.toFixed(2),
      escrow: +escrowItems.toFixed(2),

      totalMonthly: +totalMonthly.toFixed(2),
      totalMonthlyHousehold: +totalMonthlyHousehold.toFixed(2),
      householdDelta: +householdDelta.toFixed(2),

      // handy for charts
      equity: +equity.toFixed(2),
      totalInterestThisMonth: +(bankInterest + famInterest).toFixed(2),
      totalPrincipalThisMonth: +(bankPrincipalPaid + famPrincipalPaid).toFixed(2),
    });
  }

  // Investment stream (vs full-bank-only baseline)
  const bankFullMonthly = pmt(price - down, bankRate, termMonths); // baseline ignores family loan
  const actualDebtMonthly = rows.map(r => (r.bankPayment || 0) + r.famPayment);
  const monthlySavings = rows.map((_, i) => Math.max(bankFullMonthly - actualDebtMonthly[i], 0));

  const investTracks = [
    { key: "spx_est", label: "S&P Estimate", annualPct: 6.5 },
    { key: "spx_hist", label: "S&P Historical", annualPct: 10.0 },
    { key: "cd6", label: "CD/T-bill", annualPct: 5.5 },
  ];
  const investResults = investTracks.map(track => {
    let bal = 0;
    const r = toMonthlyRate(track.annualPct);
    for (let i = 0; i < monthlySavings.length; i++) bal = bal * (1 + r) + monthlySavings[i];
    const contributed = monthlySavings.reduce((a, b) => a + b, 0);
    const profit = bal - contributed;
    return { key: track.key, label: track.label, final: +bal.toFixed(2), profit: +profit.toFixed(2) };
  });

  // NPV/IRR: owner + household
  const initialOut = -(down + closingCosts + pointsCost);
  const cash_owner = [initialOut, ...rows.map(r => -r.totalMonthly)];
  cash_owner[cash_owner.length - 1] += rows[rows.length - 1]?.equity ?? 0;

  const cash_house = [initialOut, ...rows.map(r => -r.totalMonthlyHousehold)];
  cash_house[cash_house.length - 1] += rows[rows.length - 1]?.equity ?? 0;

  const irrAnnual = ((1 + irr(cash_owner, 0.005)) ** 12 - 1);
  const irrAnnualHH = ((1 + irr(cash_house, 0.005)) ** 12 - 1);

  return {
    rows,
    investResults,
    irrAnnual: +irrAnnual.toFixed(4),
    irrAnnualHousehold: +irrAnnualHH.toFixed(4),
    npv: +npv(discountRatePct, cash_owner).toFixed(2),
    npvHousehold: +npv(discountRatePct, cash_house).toFixed(2),
    monthlySavings: monthlySavings.map(v => +v.toFixed(2)),
    cumFamilyInterest: +cumFamilyInterest.toFixed(2),
    cumReinvestEarnings: +cumReinvestEarnings.toFixed(2),
  };
}

/* =============== UI =============== */
const preset = {
  price: 1_000_000,

  // Per-variant downs
  downBankOnly: 150_000,
  downWithFamily: 200_000,

  bankType: "fixed", bankRate: 6.3, bankTermYears: 30,
  arm: { margin: 2.0, caps: { first: 2, periodic: 2, lifetime: 5 }, indexForecast: [3.5, 3.25, 3.0, 3.0, 3.0] },
  ioMonths: 0,
  pointsPct: 0.5, closingCosts: 12_000,

  // Family finance + tax on alt return
  family: { amount: 300_000, rate: 4.5, termYears: 30, mode: "amortized", altAnnualPct: 5, altTaxPct: 30, reinvestAnnualPct: 5 },

  taxPct: 1.2, taxInflationPct: 2.5,
  insuranceAnnual: 2_000, insuranceInflationPct: 3,
  hoaMonthly: 90, maintPctAnnual: 1.0, utilitiesMonthly: 350,
  escrow: true,
  pmi: { enabled: true, dropLTV: 0.78, pmiPctAnnual: 0.6 },
  prepay: { monthlyExtra: 0, lumpSums: [] },

  horizonYears: 30,
  discountRatePct: 5.0,
};

// Controls
function NumberInput({ label, value, onChange, step = 1, min, max, suffix }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-slate-600">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={value}
          step={step}
          min={min}
          max={max}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm focus:border-indigo-500 focus:outline-none"
        />
        {suffix && <span className="text-slate-500 text-xs">{suffix}</span>}
      </div>
    </label>
  );
}
function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="text-slate-600">{label}</span>
      <button
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 rounded-full transition ${checked ? "bg-indigo-600" : "bg-slate-300"}`}
      >
        <span className={`absolute top-0.5 ${checked ? "left-6" : "left-0.5"} h-5 w-5 rounded-full bg-white shadow transition`} />
      </button>
    </label>
  );
}
function KPI({ icon: Icon, label, value, hint, emphasis = false }) {
  return (
    <div className={`rounded-2xl border p-4 shadow-sm ${emphasis ? "border-indigo-300 bg-indigo-50" : "border-slate-200 bg-white"}`}>
      <div className="flex items-center gap-2 text-slate-500 text-xs"><Icon size={16} /> {label}</div>
      <div className="mt-1 font-semibold tabular-nums leading-tight break-all text-xl sm:text-2xl">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

// Helper: compute config for a scenario's chosen variant
function configForVariant(cfg, variant) {
  if (variant === "bank") {
    return { ...cfg, down: cfg.downBankOnly, family: { ...cfg.family, amount: 0 } };
  }
  // 'family'
  return { ...cfg, down: cfg.downWithFamily };
}

/* =============== App =============== */
export default function MortgageScenarioPro() {
  const [scenarios, setScenarios] = useState([
    { id: 1, name: "Baseline", cfg: preset, variant: "family" }, // 'bank' | 'family'
  ]);
  const [activeId, setActiveId] = useState(1);

  // Big chart mode: 'household' vs 'interest'
  const [chartMode, setChartMode] = useState("household");

  const active = scenarios.find(s => s.id === activeId) ?? scenarios[0];

  // Active scenario result (for small charts/KPIs), honors this scenario's own variant
  const activeCfg = configForVariant(active.cfg, active.variant);
  const result = useMemo(() => buildSchedule(activeCfg), [activeCfg]);

  // KPIs
  const monthlyNow = result.rows[0]?.totalMonthly ?? 0;
  const cumDebtInterest = result.rows.reduce((a, r) => a + r.bankInterest + r.famInterest, 0);
  const equity10 = result.rows[119]?.equity ?? 0;
  const cumFamilyInterest = result.cumFamilyInterest ?? 0;

  // Single-bar Monthly Mix (current month only)
  const nowMix = [{
    name: "Now",
    Bank: result.rows[0]?.bankPayment ?? 0,
    Family: result.rows[0]?.famPayment ?? 0,
    PMI: result.rows[0]?.pmi ?? 0,
    Escrow: result.rows[0]?.escrow ?? 0,
    Carry: (result.rows[0]?.hoa ?? 0) + (result.rows[0]?.maint ?? 0) + (result.rows[0]?.util ?? 0),
  }];

  // Amortization flow (active scenario, chosen variant)
  const principalVsInterest = result.rows.map(r => ({
    name: `M${r.m}`,
    Principal: +(r.bankPrincipal + r.famPrincipal).toFixed(2),
    Interest: +(r.bankInterest + r.famInterest).toFixed(2),
  }));

  // === Big chart: one line per scenario, respecting each scenario's own variant ===
  const compareLines = useMemo(() => {
    const palette = ["#6366f1","#22c55e","#ef4444","#0ea5e9","#f59e0b","#14b8a6","#a855f7","#e11d48"];
    return scenarios.map((s, idx) => {
      const cfg = configForVariant(s.cfg, s.variant);
      const res = buildSchedule(cfg);
      const series = [];
      for (let y = 1; y <= 30; y++) {
        const upto = res.rows.slice(0, y * 12);
        const value =
          chartMode === "household"
            ? upto.reduce((a, r) => a + r.totalMonthlyHousehold, 0)
            : upto.reduce((a, r) => a + r.bankInterest + r.famInterest, 0);
        series.push({ name: `Y${y}`, [s.name]: +value.toFixed(2) });
      }
      return { name: s.name, color: palette[idx % palette.length], series };
    });
  }, [scenarios, chartMode]);

  const mergedCompare = useMemo(() => {
    if (!compareLines.length) return [];
    const years = compareLines[0].series.map(s => s.name);
    return years.map((label, i) => {
      const row = { name: label };
      compareLines.forEach(line => Object.assign(row, line.series[i]));
      return row;
    });
  }, [compareLines]);

  // Scenario ops
  function addScenarioFrom(base) {
    const id = Math.max(...scenarios.map(s => s.id)) + 1;
    setScenarios([...scenarios, { id, name: `Scenario ${id}`, cfg: JSON.parse(JSON.stringify(base.cfg)), variant: base.variant }]);
    setActiveId(id);
  }
  function removeScenario(id) {
    const next = scenarios.filter(s => s.id !== id);
    setScenarios(next);
    if (!next.find(s => s.id === activeId) && next.length) setActiveId(next[0].id);
  }
  function updateScenarioCfg(id, patch) {
    setScenarios(scenarios.map(s => s.id === id ? { ...s, cfg: { ...s.cfg, ...patch } } : s));
  }
  function updateActiveCfg(patch) {
    updateScenarioCfg(active.id, patch);
  }
  function updateActiveFamily(patch) {
    updateActiveCfg({ family: { ...active.cfg.family, ...patch } });
  }
  function updateActivePMI(patch) {
    updateActiveCfg({ pmi: { ...active.cfg.pmi, ...patch } });
  }
  function updateActivePrepay(patch) {
    updateActiveCfg({ prepay: { ...active.cfg.prepay, ...patch } });
  }
  function setScenarioVariant(id, variant) {
    setScenarios(scenarios.map(s => s.id === id ? { ...s, variant } : s));
  }

  // CSV for active scenario (chosen variant)
  function exportCSV() {
    const header = ["Month","BankPayment","BankInterest","BankPrincipal","BankBalance","FamilyPayment","FamilyInterest","FamilyPrincipal","FamilyBalance","PMI","Tax","Insurance","HOA","Maintenance","Utilities","Escrow","TotalMonthly","HHMonthly","Equity"];
    const rows = result.rows.map(r => [
      r.m,r.bankPayment,r.bankInterest,r.bankPrincipal,r.bankBalance,
      r.famPayment,r.famInterest,r.famPrincipal,r.famBalance,
      r.pmi,r.tax,r.ins,r.hoa,r.maint,r.util,r.escrow,
      r.totalMonthly,r.totalMonthlyHousehold,r.equity
    ]);
    const csv = [header, ...rows].map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${(active.name || "Scenario").replace(/\s+/g,'_')}_schedule.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      {/* Top bar */}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2 text-lg font-semibold"><Wallet size={18}/> Mortgage Scenario Pro</div>
          <div className="flex items-center gap-2 text-sm">
            <button onClick={() => addScenarioFrom(active)} className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-3 py-2 font-medium text-white shadow-sm hover:bg-indigo-700"><Plus size={16}/> Add Scenario</button>
            <button onClick={exportCSV} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 hover:bg-slate-100"><Download size={16}/> Export CSV</button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        {/* Scenarios: select active + per-scenario variant buttons */}
        <div className="mb-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {scenarios.map(s => (
              <div key={s.id} className={`flex items-center gap-2 rounded-full border px-2 py-1 ${activeId===s.id ? "border-indigo-300 bg-indigo-50" : "border-slate-200 bg-white"}`}>
                <button onClick={() => setActiveId(s.id)} className="text-sm font-medium">{s.name}</button>
                <div className="flex rounded-full bg-slate-100 p-0.5">
                  <button
                    onClick={()=>setScenarioVariant(s.id,"bank")}
                    className={`px-2 py-0.5 text-xs rounded-full ${s.variant==="bank"?"bg-slate-900 text-white":"text-slate-700"}`}
                    title="Bank only"
                  >Bank</button>
                  <button
                    onClick={()=>setScenarioVariant(s.id,"family")}
                    className={`px-2 py-0.5 text-xs rounded-full ${s.variant==="family"?"bg-slate-900 text-white":"text-slate-700"}`}
                    title="With family"
                  >Family</button>
                </div>
                {scenarios.length>1 && (
                  <button onClick={() => removeScenario(s.id)} className="text-xs text-rose-600 hover:underline"><Trash2 size={14}/></button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Big chart mode toggle */}
        <div className="mb-4 flex items-center gap-2">
          <span className="text-sm text-slate-600">Big chart:</span>
          <button onClick={()=>setChartMode("household")} className={`rounded-full px-3 py-1 text-sm ${chartMode==="household"?"bg-slate-900 text-white":"bg-white border border-slate-200"}`}>Cumulative household cost</button>
          <button onClick={()=>setChartMode("interest")} className={`rounded-full px-3 py-1 text-sm ${chartMode==="interest"?"bg-slate-900 text-white":"bg-white border border-slate-200"}`}>Cumulative interest only</button>
        </div>

        {/* OVERBOX — Cumulative Interest paid to Family (active scenario, chosen variant) */}
        <div className="mb-4">
          <div className="rounded-2xl border border-indigo-300 bg-indigo-50 p-4 shadow-sm">
            <div className="flex items-center gap-2 text-indigo-700 text-xs"><TrendingUp size={16}/> Cumulative interest paid to family</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums leading-tight break-all text-indigo-900">
              ${Math.round(cumFamilyInterest).toLocaleString()}
            </div>
            <div className="mt-1 text-xs text-indigo-700">Based on family loan amount, rate, mode, term, and your current inputs.</div>
          </div>
        </div>

        {/* KPI header (active scenario, chosen variant) */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          <KPI icon={TrendingUp} label="Monthly payment (now)" value={`$${monthlyNow.toLocaleString()}`} />
          <KPI icon={TrendingUp} label="Total interest (all debt)" value={`$${Math.round(cumDebtInterest).toLocaleString()}`} />
          <KPI icon={TrendingUp} label="Equity @ 10 years" value={`$${Math.round(equity10).toLocaleString()}`} />
          <KPI icon={TrendingUp} label="Your net cost (today’s $)" value={`$${result.npv.toLocaleString()}`} hint={`Your IRR ${(result.irrAnnual*100).toFixed(2)}%`} />
          <KPI icon={TrendingUp} label="All-in family net cost (today’s $)" value={`$${result.npvHousehold.toLocaleString()}`} hint={`Household IRR ${(result.irrAnnualHousehold*100).toFixed(2)}%`} />
        </div>

        {/* Layout: Inputs (left) / Charts (right) */}
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Inputs */}
          <section className="lg:col-span-1 space-y-5">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium"><Settings size={16}/> Home & Costs</div>
              <div className="grid grid-cols-2 gap-3">
                <NumberInput label="Home price" value={active.cfg.price} onChange={(v)=>updateActiveCfg({price:v})} step={1000}/>
                <NumberInput label="Closing costs" value={active.cfg.closingCosts} onChange={(v)=>updateActiveCfg({closingCosts:v})} step={500}/>
                <NumberInput label="Points (%)" value={active.cfg.pointsPct} onChange={(v)=>updateActiveCfg({pointsPct:v})} step={0.125}/>
                <NumberInput label="Down (bank-only)" value={active.cfg.downBankOnly} onChange={(v)=>updateActiveCfg({downBankOnly:v})} step={1000}/>
                <NumberInput label="Down (with family)" value={active.cfg.downWithFamily} onChange={(v)=>updateActiveCfg({downWithFamily:v})} step={1000}/>
                <NumberInput label="Tax (%)" value={active.cfg.taxPct} onChange={(v)=>updateActiveCfg({taxPct:v})} step={0.05} suffix="yr"/>
                <NumberInput label="Tax drift (%)" value={active.cfg.taxInflationPct} onChange={(v)=>updateActiveCfg({taxInflationPct:v})} step={0.25} suffix="yr"/>
                <NumberInput label="Insurance (annual)" value={active.cfg.insuranceAnnual} onChange={(v)=>updateActiveCfg({insuranceAnnual:v})} step={100}/>
                <NumberInput label="Ins. drift (%)" value={active.cfg.insuranceInflationPct} onChange={(v)=>updateActiveCfg({insuranceInflationPct:v})} step={0.25} suffix="yr"/>
                <NumberInput label="HOA (mo)" value={active.cfg.hoaMonthly} onChange={(v)=>updateActiveCfg({hoaMonthly:v})} step={10}/>
                <NumberInput label="Maint. (%/yr)" value={active.cfg.maintPctAnnual} onChange={(v)=>updateActiveCfg({maintPctAnnual:v})} step={0.1}/>
                <NumberInput label="Utilities (mo)" value={active.cfg.utilitiesMonthly} onChange={(v)=>updateActiveCfg({utilitiesMonthly:v})} step={10}/>
                <Toggle label="Escrow taxes/ins" checked={active.cfg.escrow} onChange={(v)=>updateActiveCfg({escrow:v})}/>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium"><Info size={16}/> Bank Loan</div>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-600">Type</span>
                  <select value={active.cfg.bankType} onChange={(e)=>updateActiveCfg({bankType:e.target.value})} className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                    <option value="fixed">Fixed</option>
                    <option value="arm">ARM</option>
                    <option value="io">Interest-only</option>
                  </select>
                </label>
                <NumberInput label="Rate (%)" value={active.cfg.bankRate} onChange={(v)=>updateActiveCfg({bankRate:v})} step={0.125}/>
                <NumberInput label="Term (yrs)" value={active.cfg.bankTermYears} onChange={(v)=>updateActiveCfg({bankTermYears:v})} step={5}/>
                {active.cfg.bankType==="io" && <NumberInput label="IO months" value={active.cfg.ioMonths} onChange={(v)=>updateActiveCfg({ioMonths:v})} step={6}/>}
                {active.cfg.bankType==="arm" && (
                  <>
                    <NumberInput label="ARM margin (%)" value={active.cfg.arm.margin} onChange={(v)=>updateActiveCfg({arm:{...active.cfg.arm, margin:v}})} step={0.125}/>
                    <NumberInput label="1st cap (%)" value={active.cfg.arm.caps.first} onChange={(v)=>updateActiveCfg({arm:{...active.cfg.arm, caps:{...active.cfg.arm.caps, first:v}}})} step={0.25}/>
                    <NumberInput label="Periodic cap (%)" value={active.cfg.arm.caps.periodic} onChange={(v)=>updateActiveCfg({arm:{...active.cfg.arm, caps:{...active.cfg.arm.caps, periodic:v}}})} step={0.25}/>
                    <NumberInput label="Lifetime cap (%)" value={active.cfg.arm.caps.lifetime} onChange={(v)=>updateActiveCfg({arm:{...active.cfg.arm, caps:{...active.cfg.arm.caps, lifetime:v}}})} step={0.25}/>
                  </>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium"><Info size={16}/> Family Loan</div>
              <div className="grid grid-cols-2 gap-3">
                <NumberInput label="Amount" value={active.cfg.family.amount} onChange={(v)=>updateActiveFamily({amount:v})} step={1000}/>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-600">Mode</span>
                  <select value={active.cfg.family.mode} onChange={(e)=>updateActiveFamily({mode:e.target.value})} className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                    <option value="amortized">Amortized</option>
                    <option value="interest_only">Interest-only</option>
                  </select>
                </label>
                <NumberInput label="Rate (%)" value={active.cfg.family.rate} onChange={(v)=>updateActiveFamily({rate:v})} step={0.125}/>
                <NumberInput label="Term (yrs)" value={active.cfg.family.termYears} onChange={(v)=>updateActiveFamily({termYears:v})} step={5}/>
                <NumberInput label="Family alt return (%)" value={active.cfg.family.altAnnualPct} onChange={(v)=>updateActiveFamily({altAnnualPct:v})} step={0.25}/>
                <NumberInput label="Alt return tax (%)" value={active.cfg.family.altTaxPct} onChange={(v)=>updateActiveFamily({altTaxPct:v})} step={1}/>
                <NumberInput label="Reinvest return (%)" value={active.cfg.family.reinvestAnnualPct} onChange={(v)=>updateActiveFamily({reinvestAnnualPct:v})} step={0.25}/>
              </div>
              <div className="mt-2 text-xs text-slate-500">
                “Alt return” = what family earns if they don’t lend you the money (taxed). “Reinvest return” = what they earn by investing your repayments (treated as not taxed).
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium"><Info size={16}/> PMI & Prepay</div>
              <div className="grid grid-cols-2 gap-3">
                <Toggle label="PMI enabled" checked={active.cfg.pmi.enabled} onChange={(v)=>updateActivePMI({enabled:v})}/>
                <NumberInput label="PMI drop LTV" value={active.cfg.pmi.dropLTV} onChange={(v)=>updateActivePMI({dropLTV:v})} step={0.01}/>
                <NumberInput label="PMI % (annual)" value={active.cfg.pmi.pmiPctAnnual} onChange={(v)=>updateActivePMI({pmiPctAnnual:v})} step={0.05}/>
                <NumberInput label="Monthly extra" value={active.cfg.prepay.monthlyExtra} onChange={(v)=>updateActivePrepay({monthlyExtra:v})} step={50}/>
              </div>
              <div className="mt-2 text-xs text-slate-500">Add lump-sum prepayments by editing code or wire a small sub-form.</div>
            </div>
          </section>

          {/* Charts */}
          <section className="lg:col-span-2 space-y-6">
            {/* BIG: Compare scenarios (one line per scenario, per-scenario variant) */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-2 text-sm font-medium">
                {chartMode === "household" ? "Cumulative household cost — 30 years" : "Cumulative interest only — 30 years"} (each scenario uses its own Bank/Family selection)
              </div>
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={mergedCompare}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis tickFormatter={(v)=>`$${(v/1000).toFixed(0)}k`} />
                    <RTooltip formatter={(v)=>`$${Math.round(v).toLocaleString()}`} />
                    <RLegend />
                    {compareLines.map(line => (
                      <Line key={line.name} type="monotone" dataKey={line.name} stroke={line.color} strokeWidth={2} dot={false} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Smaller charts */}
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              {/* Single-bar Monthly Mix (Now) */}
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-2 text-sm font-medium">
                  Monthly payment mix — now ({active.variant==="bank"?"Bank only":"With family"})
                </div>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={nowMix} stackOffset="expand">
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" />
                      <YAxis tickFormatter={(v)=>`${Math.round(v*100)}%`} />
                      <RTooltip formatter={(v)=>`$${Math.round(v).toLocaleString()}`} />
                      <RLegend />
                      <Bar dataKey="Bank" stackId="a" fill="#6366f1" />
                      <Bar dataKey="Family" stackId="a" fill="#22c55e" />
                      <Bar dataKey="PMI" stackId="a" fill="#f59e0b" />
                      <Bar dataKey="Escrow" stackId="a" fill="#0ea5e9" />
                      <Bar dataKey="Carry" stackId="a" fill="#94a3b8" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Principal vs Interest over time */}
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-2 text-sm font-medium">
                  Amortization flow — principal vs interest ({active.variant==="bank"?"Bank only":"With family"})
                </div>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={principalVsInterest}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" hide />
                      <YAxis tickFormatter={(v)=>`$${(v/1000).toFixed(0)}k`} />
                      <RTooltip formatter={(v)=>`$${Math.round(v).toLocaleString()}`} />
                      <RLegend />
                      <Line type="monotone" dataKey="Principal" stroke="#22c55e" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="Interest" stroke="#ef4444" strokeWidth={2} dot={false} />
                      <ReferenceLine y={0} stroke="#64748b" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Net cost & return (active) */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-2 text-sm font-medium">Net cost (today’s $) & return — {active.variant==="bank"?"Bank only":"With family"} (active scenario)</div>
              <div className="grid grid-cols-2 gap-4">
                <KPI
                  icon={TrendingUp}
                  label="Your net cost (today’s $)"
                  value={`$${result.npv.toLocaleString()}`}
                  hint={`Your IRR ${(result.irrAnnual*100).toFixed(2)}%`}
                />
                <KPI
                  icon={TrendingUp}
                  label="All-in family net cost (today’s $)"
                  value={`$${result.npvHousehold.toLocaleString()}`}
                  hint={`Household IRR ${(result.irrAnnualHousehold*100).toFixed(2)}%`}
                />
              </div>
            </div>
          </section>
        </div>
      </main>

      <footer className="mx-auto max-w-7xl px-4 py-8 text-center text-xs text-slate-500">
        Each scenario uses its own Bank/Family selection. Big chart can show cumulative household cost or cumulative interest only. Family “alt return” is taxed; reinvest on repayments is not.
      </footer>
    </div>
  );
}
