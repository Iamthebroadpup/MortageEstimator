import React, { useMemo, useState } from "react";
import { Download, Plus, Trash2, TrendingUp, Wallet, Settings, Info } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, Legend as RLegend,
  LineChart, Line, ResponsiveContainer, ReferenceLine,
  Area, AreaChart
} from "recharts";

/**
 * Mortgage Scenario Pro — compact single-file build
 */

// ---------- Utility math helpers ----------
const toMonthlyRate = (annualPct) => annualPct / 100 / 12;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// IRR via Newton-Raphson
function irr(cashflows, guess = 0.05) {
  let rate = guess;
  for (let i = 0; i < 100; i++) {
    let npv = 0, d = 0;
    for (let t = 0; t < cashflows.length; t++) {
      const denom = Math.pow(1 + rate, t);
      npv += cashflows[t] / denom;
      d   -= t * cashflows[t] / (denom * (1 + rate));
    }
    const newRate = rate - npv / d;
    if (!isFinite(newRate)) break;
    if (Math.abs(newRate - rate) < 1e-7) return newRate;
    rate = newRate;
  }
  return rate;
}

function npv(discountRateAnnualPct, cashflowsMonthly) {
  const r = discountRateAnnualPct / 100 / 12;
  return cashflowsMonthly.reduce((acc, cf, t) => acc + cf / Math.pow(1 + r, t), 0);
}

// Amortized payment
function pmt(principal, annualRatePct, termMonths) {
  const r = toMonthlyRate(annualRatePct);
  if (r === 0) return principal / termMonths;
  return (principal * r) / (1 - Math.pow(1 + r, -termMonths));
}

// ---------- Core calculation engine ----------
function buildSchedule({
  price,
  down,
  bankType, // "fixed" | "arm" | "io"
  bankRate, // % for fixed or initial for arm/io
  bankTermYears,
  arm: { margin = 2.0, caps = { first: 2, periodic: 2, lifetime: 5 }, indexForecast = [] } = {},
  ioMonths = 0, // interest-only months for IO loans
  pointsPct = 0,
  closingCosts = 0,
  family: { amount: famAmt = 0, rate: famRate = 4.5, termYears: famYears = 30, mode = "amortized" } = {},
  taxPct = 1.2, taxInflationPct = 2.5,
  insuranceAnnual = 2000, insuranceInflationPct = 3,
  hoaMonthly = 0, maintPctAnnual = 1, utilitiesMonthly = 0,
  escrow = true,
  pmi: { enabled: pmiEnabled = true, dropLTV = 0.78, pmiPctAnnual = 0.6 } = {},
  prepay: { monthlyExtra = 0, lumpSums = [] } = {},
  investTracks = [
    { key: "spx_est", label: "S&P Estimate", annualPct: 6.5 },
    { key: "spx_hist", label: "S&P Historical", annualPct: 10.0 },
    { key: "cd6", label: "CD/T-bill", annualPct: 5.5 },
  ],
  horizonYears = 30,
  discountRatePct = 5.0,
  rentVsBuy: { monthlyRent = 0, rentInflationPct = 3 } = {},
}) {
  const termMonths = bankTermYears * 12;
  const horizonMonths = horizonYears * 12;
  const principalBankFull = price - down;
  const principalBank = Math.max(principalBankFull - famAmt, 0);

  // Points cost (paid up front)
  const pointsCost = principalBank * (pointsPct / 100);
  const cashToClose = down + closingCosts + pointsCost;

  // PMI logic
  const initLTV = principalBank / price;
  const pmiMonthlyBase = pmiEnabled && initLTV > 0.8 ? (principalBank * (pmiPctAnnual / 100)) / 12 : 0;

  // Property tax & insurance with drift
  const taxMonthly0 = (taxPct / 100) * price / 12;
  const insMonthly0 = insuranceAnnual / 12;

  // Family loan
  const famTermMonths = famYears * 12;
  const famMonthly = famAmt > 0
    ? (mode === "interest_only" ? (famAmt * toMonthlyRate(famRate)) : pmt(famAmt, famRate, famTermMonths))
    : 0;

  // Bank loan model
  const bankMonthlyFixed = bankType === "fixed" ? pmt(principalBank, bankRate, termMonths) : 0;

  const rows = [];
  let bal = principalBank;
  let famBal = famAmt;
  let cumInterestBank = 0, cumInterestFam = 0;
  let equity = down; // starter equity
  let currentRate = bankRate; // for ARM
  let pmiActive = pmiMonthlyBase > 0;

  // Build index path for ARM resets (yearly)
  const indexPath = new Array(bankTermYears).fill(0).map((_, i) => indexForecast[i] ?? indexForecast[indexForecast.length - 1] ?? 0);
  const armCeiling = bankRate + caps.lifetime;

  for (let m = 1; m <= Math.min(horizonMonths, 720); m++) {
    const year = Math.ceil(m / 12);

    // Update tax/insurance drift annually
    const taxMonthly = taxMonthly0 * Math.pow(1 + taxInflationPct / 100, year - 1);
    const insMonthly  = insMonthly0 * Math.pow(1 + insuranceInflationPct / 100, year - 1);

    // Bank payment
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

      // Prepayments
      let prepayThisMonth = monthlyExtra;
      const lumps = lumpSums.filter(ls => ls.month === m).reduce((s, ls) => s + ls.amount, 0);
      prepayThisMonth += lumps;

      const principalReduction = Math.min(bankPrincipalPaid + prepayThisMonth, bal);
      bal -= principalReduction;
      cumInterestBank += bankInterest;
    }

    // PMI drop check
    if (pmiActive) {
      const ltv = bal / price;
      if (ltv <= dropLTV || bal <= 0) pmiActive = false;
    }
    const pmiMonthly = pmiActive ? pmiMonthlyBase : 0;

    // Family loan accrual
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
      cumInterestFam += famInterest;
    }

    const escrowItems = escrow ? (taxMonthly + insMonthly) : 0;
    const carryingCosts = hoaMonthly + utilitiesMonthly + (price * (maintPctAnnual / 100) / 12);

    const totalMonthlyOut = (bankPayment || 0) + famPayment + (pmiMonthly || 0) + escrowItems + carryingCosts;

    equity = price - bal - famBal; // approximate equity ignoring selling costs

    rows.push({
      m,
      year,
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
      totalMonthly: +totalMonthlyOut.toFixed(2),
      equity: +equity.toFixed(2),
      pmiActive,
    });
  }

  // Investment track fed with savings vs full-bank-only reference
  const bankFullMonthly = pmt(principalBankFull, bankRate, termMonths);
  const actualDebtMonthly = rows.map(r => (r.bankPayment || 0) + r.famPayment);
  const refDebtMonthly = new Array(rows.length).fill(bankFullMonthly);
  const monthlySavings = refDebtMonthly.map((v, i) => Math.max(v - actualDebtMonthly[i], 0));

  const investResults = [
    { key: "spx_est", label: "S&P Estimate", annualPct: 6.5 },
    { key: "spx_hist", label: "S&P Historical", annualPct: 10.0 },
    { key: "cd6", label: "CD/T-bill", annualPct: 5.5 },
  ].map(track => {
    let bal = 0;
    const r = toMonthlyRate(track.annualPct);
    for (let i = 0; i < monthlySavings.length; i++) {
      bal = bal * (1 + r) + monthlySavings[i];
    }
    const contributed = monthlySavings.reduce((a, b) => a + b, 0);
    const profit = bal - contributed;
    return { key: track.key, label: track.label, final: +bal.toFixed(2), profit: +profit.toFixed(2) };
  });

  // NPV/IRR
  const cashflows = [];
  cashflows.push(-cashToClose);
  rows.forEach(r => cashflows.push(-r.totalMonthly));
  const terminalEquity = rows[rows.length - 1]?.equity ?? 0;
  cashflows[cashflows.length - 1] += terminalEquity;

  const irrMonthly = irr(cashflows, 0.005);
  const irrAnnual = (1 + irrMonthly) ** 12 - 1;
  const npvVal = npv(discountRatePct, cashflows);

  // ---- FIX: compute rent path iteratively (avoid TDZ/self-reference)
  const rentPath = [];
  const rentGrowth = 1 + rentInflationPct / 100 / 12;
  for (let i = 0; i < rows.length; i++) {
    rentPath[i] = (i === 0) ? monthlyRent : rentPath[i - 1] * rentGrowth;
  }

  const principalOut = rows.map(r => r.bankPrincipal + r.famPrincipal);
  const ownerLikeRent = rows.map((r, i) => r.totalMonthly - principalOut[i]);
  const rentVsBuyDelta = ownerLikeRent.map((v, i) => v - rentPath[i]); // positive => owning costs more

  return {
    rows,
    pointsCost,
    cashToClose,
    investResults,
    irrAnnual: +irrAnnual.toFixed(4),
    npv: +npvVal.toFixed(2),
    monthlySavings: monthlySavings.map(v => +v.toFixed(2)),
    rentVsBuyDelta: rentVsBuyDelta.map(v => +v.toFixed(2)),
    principalBank, principalBankFull,
  };
}

// ---------- UI ----------
const preset = {
  price: 1000000, down: 200000,
  bankType: "fixed", bankRate: 6.3, bankTermYears: 30,
  arm: { margin: 2.0, caps: { first: 2, periodic: 2, lifetime: 5 }, indexForecast: [3.5, 3.25, 3.0, 3.0, 3.0] },
  ioMonths: 0,
  pointsPct: 0.5, closingCosts: 12000,
  family: { amount: 300000, rate: 4.5, termYears: 30, mode: "amortized" },
  taxPct: 1.2, taxInflationPct: 2.5,
  insuranceAnnual: 2000, insuranceInflationPct: 3,
  hoaMonthly: 90, maintPctAnnual: 1.0, utilitiesMonthly: 350,
  escrow: true,
  pmi: { enabled: true, dropLTV: 0.78, pmiPctAnnual: 0.6 },
  prepay: { monthlyExtra: 0, lumpSums: [] },
  investTracks: [
    { key: "spx_est", label: "S&P Estimate", annualPct: 6.5 },
    { key: "spx_hist", label: "S&P Historical", annualPct: 10.0 },
    { key: "cd6", label: "CD/T-bill", annualPct: 5.5 },
  ],
  horizonYears: 30,
  discountRatePct: 5.0,
  rentVsBuy: { monthlyRent: 3500, rentInflationPct: 3 },
};

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
        <span
          className={`absolute top-0.5 ${checked ? "left-6" : "left-0.5"} h-5 w-5 rounded-full bg-white shadow transition`}
        />
      </button>
    </label>
  );
}

function KPI({ icon: Icon, label, value, hint }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 text-slate-500 text-xs"><Icon size={16} /> {label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export default function MortgageScenarioPro() {
  const [scenarios, setScenarios] = useState([{ id: 1, name: "Baseline", cfg: preset }]);
  const [activeId, setActiveId] = useState(1);

  const active = scenarios.find(s => s.id === activeId) ?? scenarios[0];

  const result = useMemo(() => buildSchedule(active.cfg), [active]);

  // Derived KPIs
  const monthlyNow = result.rows[0]?.totalMonthly ?? 0;
  const monthlyYear5 = result.rows[59]?.totalMonthly ?? monthlyNow;
  const cumBankInt = result.rows.reduce((a, r) => a + r.bankInterest, 0);
  const cumFamInt = result.rows.reduce((a, r) => a + r.famInterest, 0);
  const equity10 = result.rows[119]?.equity ?? 0;

  // Chart data
  const monthlyMix = [
    { name: "Now", Bank: result.rows[0]?.bankPayment ?? 0, Family: result.rows[0]?.famPayment ?? 0, PMI: result.rows[0]?.pmi ?? 0, Escrow: result.rows[0]?.escrow ?? 0, Carry: (result.rows[0]?.hoa ?? 0) + (result.rows[0]?.maint ?? 0) + (result.rows[0]?.util ?? 0) },
    { name: "Year 5", Bank: result.rows[59]?.bankPayment ?? 0, Family: result.rows[59]?.famPayment ?? 0, PMI: result.rows[59]?.pmi ?? 0, Escrow: result.rows[59]?.escrow ?? 0, Carry: (result.rows[59]?.hoa ?? 0) + (result.rows[59]?.maint ?? 0) + (result.rows[59]?.util ?? 0) },
    { name: "Year 10", Bank: result.rows[119]?.bankPayment ?? 0, Family: result.rows[119]?.famPayment ?? 0, PMI: result.rows[119]?.pmi ?? 0, Escrow: result.rows[119]?.escrow ?? 0, Carry: (result.rows[119]?.hoa ?? 0) + (result.rows[119]?.maint ?? 0) + (result.rows[119]?.util ?? 0) },
  ];

  const interestLine = [
    { name: "Now", Bank: result.rows[0]?.bankInterest ?? 0, Family: result.rows[0]?.famInterest ?? 0 },
    { name: "Y1", Bank: result.rows.slice(0,12).reduce((a,r)=>a+r.bankInterest,0), Family: result.rows.slice(0,12).reduce((a,r)=>a+r.famInterest,0) },
    { name: "Y5", Bank: result.rows.slice(0,60).reduce((a,r)=>a+r.bankInterest,0), Family: result.rows.slice(0,60).reduce((a,r)=>a+r.famInterest,0) },
    { name: "Y10", Bank: result.rows.slice(0,120).reduce((a,r)=>a+r.bankInterest,0), Family: result.rows.slice(0,120).reduce((a,r)=>a+r.famInterest,0) },
  ];

  const savingsAccum = result.monthlySavings.reduce((arr, v, i) => {
    const prev = i === 0 ? 0 : arr[i-1].val;
    arr.push({ name: `M${i+1}`, val: prev + v });
    return arr;
  }, []);

  const rentVsBuy = result.rentVsBuyDelta.map((v, i) => ({ name: `M${i+1}`, delta: v }));

  function addScenarioFrom(activeCfg) {
    const id = Math.max(...scenarios.map(s => s.id)) + 1;
    setScenarios([...scenarios, { id, name: `Scenario ${id}`, cfg: JSON.parse(JSON.stringify(activeCfg)) }]);
    setActiveId(id);
  }

  function removeScenario(id) {
    const next = scenarios.filter(s => s.id !== id);
    setScenarios(next);
    if (!next.find(s => s.id === activeId) && next.length) setActiveId(next[0].id);
  }

  function updateActive(partial) {
    setScenarios(scenarios.map(s => s.id === activeId ? { ...s, cfg: { ...s.cfg, ...partial } } : s));
  }

  function exportCSV() {
    const header = [
      "Month","BankPayment","BankInterest","BankPrincipal","BankBalance","FamilyPayment","FamilyInterest","FamilyPrincipal","FamilyBalance","PMI","Tax","Insurance","HOA","Maintenance","Utilities","Escrow","TotalMonthly","Equity"
    ];
    const rows = result.rows.map(r => [
      r.m,r.bankPayment,r.bankInterest,r.bankPrincipal,r.bankBalance,r.famPayment,r.famInterest,r.famPrincipal,r.famBalance,r.pmi,r.tax,r.ins,r.hoa,r.maint,r.util,r.escrow,r.totalMonthly,r.equity
    ]);
    const csv = [header, ...rows].map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${active.name.replace(/\s+/g,'_')}_schedule.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const cfg = active.cfg;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2 text-lg font-semibold"><Wallet size={18}/> Mortgage Scenario Pro</div>
          <div className="flex items-center gap-2 text-sm">
            <button onClick={() => addScenarioFrom(cfg)} className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-3 py-2 font-medium text-white shadow-sm hover:bg-indigo-700"><Plus size={16}/> Add Scenario</button>
            <button onClick={exportCSV} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 hover:bg-slate-100"><Download size={16}/> Export CSV</button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        {/* Scenario tabs */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {scenarios.map(s => (
            <button key={s.id} onClick={() => setActiveId(s.id)} className={`rounded-full px-3 py-1 text-sm ${activeId===s.id?"bg-indigo-600 text-white":"bg-white border border-slate-200"}`}>{s.name}</button>
          ))}
          {scenarios.length>1 && (
            <button onClick={() => removeScenario(activeId)} className="ml-2 inline-flex items-center gap-1 text-xs text-rose-600 hover:underline"><Trash2 size={14}/> Remove current</button>
          )}
        </div>

        {/* KPI header */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <KPI icon={TrendingUp} label="Monthly now" value={`$${monthlyNow.toLocaleString()}`} />
          <KPI icon={TrendingUp} label="Monthly @ 5y" value={`$${monthlyYear5.toLocaleString()}`} />
          <KPI icon={TrendingUp} label="Cum. Interest (Bank)" value={`$${Math.round(cumBankInt).toLocaleString()}`} />
          <KPI icon={TrendingUp} label="Equity @ 10y" value={`$${Math.round(equity10).toLocaleString()}`} />
        </div>

        {/* Layout: left inputs, right charts */}
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <section className="lg:col-span-1 space-y-5">
            {/* Home & Costs */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium"><Settings size={16}/> Home & Costs</div>
              <div className="grid grid-cols-2 gap-3">
                <NumberInput label="Home price" value={cfg.price} onChange={(v)=>updateActive({price:v})} step={1000}/>
                <NumberInput label="Down payment" value={cfg.down} onChange={(v)=>updateActive({down:v})} step={1000}/>
                <NumberInput label="Closing costs" value={cfg.closingCosts} onChange={(v)=>updateActive({closingCosts:v})} step={500}/>
                <NumberInput label="Points (%)" value={cfg.pointsPct} onChange={(v)=>updateActive({pointsPct:v})} step={0.125}/>
                <NumberInput label="Tax (%)" value={cfg.taxPct} onChange={(v)=>updateActive({taxPct:v})} step={0.05} suffix="yr"/>
                <NumberInput label="Tax drift (%)" value={cfg.taxInflationPct} onChange={(v)=>updateActive({taxInflationPct:v})} step={0.25} suffix="yr"/>
                <NumberInput label="Insurance (annual)" value={cfg.insuranceAnnual} onChange={(v)=>updateActive({insuranceAnnual:v})} step={100}/>
                <NumberInput label="Ins. drift (%)" value={cfg.insuranceInflationPct} onChange={(v)=>updateActive({insuranceInflationPct:v})} step={0.25} suffix="yr"/>
                <NumberInput label="HOA (mo)" value={cfg.hoaMonthly} onChange={(v)=>updateActive({hoaMonthly:v})} step={10}/>
                <NumberInput label="Maint. (%/yr)" value={cfg.maintPctAnnual} onChange={(v)=>updateActive({maintPctAnnual:v})} step={0.1}/>
                <NumberInput label="Utilities (mo)" value={cfg.utilitiesMonthly} onChange={(v)=>updateActive({utilitiesMonthly:v})} step={10}/>
                <Toggle label="Escrow taxes/ins" checked={cfg.escrow} onChange={(v)=>updateActive({escrow:v})}/>
              </div>
            </div>

            {/* Bank Loan */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium"><Info size={16}/> Bank Loan</div>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-600">Type</span>
                  <select value={cfg.bankType} onChange={(e)=>updateActive({bankType:e.target.value})} className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                    <option value="fixed">Fixed</option>
                    <option value="arm">ARM</option>
                    <option value="io">Interest-only</option>
                  </select>
                </label>
                <NumberInput label="Rate (%)" value={cfg.bankRate} onChange={(v)=>updateActive({bankRate:v})} step={0.125}/>
                <NumberInput label="Term (yrs)" value={cfg.bankTermYears} onChange={(v)=>updateActive({bankTermYears:v})} step={5}/>
                {cfg.bankType==="io" && (
                  <NumberInput label="IO months" value={cfg.ioMonths} onChange={(v)=>updateActive({ioMonths:v})} step={6}/>
                )}
                {cfg.bankType==="arm" && (
                  <>
                    <NumberInput label="ARM margin (%)" value={cfg.arm.margin} onChange={(v)=>updateActive({arm:{...cfg.arm, margin:v}})} step={0.125}/>
                    <NumberInput label="1st cap (%)" value={cfg.arm.caps.first} onChange={(v)=>updateActive({arm:{...cfg.arm, caps:{...cfg.arm.caps, first:v}}})} step={0.25}/>
                    <NumberInput label="Periodic cap (%)" value={cfg.arm.caps.periodic} onChange={(v)=>updateActive({arm:{...cfg.arm, caps:{...cfg.arm.caps, periodic:v}}})} step={0.25}/>
                    <NumberInput label="Lifetime cap (%)" value={cfg.arm.caps.lifetime} onChange={(v)=>updateActive({arm:{...cfg.arm, caps:{...cfg.arm.caps, lifetime:v}}})} step={0.25}/>
                  </>
                )}
              </div>
            </div>

            {/* Family Loan */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-centered gap-2 text-sm font-medium"><Info size={16}/> Family Loan</div>
              <div className="grid grid-cols-2 gap-3">
                <NumberInput label="Amount" value={cfg.family.amount} onChange={(v)=>updateActive({family:{...cfg.family, amount:v}})} step={1000}/>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-600">Mode</span>
                  <select value={cfg.family.mode} onChange={(e)=>updateActive({family:{...cfg.family, mode:e.target.value}})} className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                    <option value="amortized">Amortized</option>
                    <option value="interest_only">Interest-only</option>
                  </select>
                </label>
                <NumberInput label="Rate (%)" value={cfg.family.rate} onChange={(v)=>updateActive({family:{...cfg.family, rate:v}})} step={0.125}/>
                <NumberInput label="Term (yrs)" value={cfg.family.termYears} onChange={(v)=>updateActive({family:{...cfg.family, termYears:v}})} step={5}/>
              </div>
            </div>

            {/* PMI & Prepay */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium"><Info size={16}/> PMI & Prepay</div>
              <div className="grid grid-cols-2 gap-3">
                <Toggle label="PMI enabled" checked={cfg.pmi.enabled} onChange={(v)=>updateActive({pmi:{...cfg.pmi, enabled:v}})}/>
                <NumberInput label="PMI drop LTV" value={cfg.pmi.dropLTV} onChange={(v)=>updateActive({pmi:{...cfg.pmi, dropLTV:v}})} step={0.01}/>
                <NumberInput label="PMI % (annual)" value={cfg.pmi.pmiPctAnnual} onChange={(v)=>updateActive({pmi:{...cfg.pmi, pmiPctAnnual:v}})} step={0.05}/>
                <NumberInput label="Monthly extra" value={cfg.prepay.monthlyExtra} onChange={(v)=>updateActive({prepay:{...cfg.prepay, monthlyExtra:v}})} step={50}/>
              </div>
              <div className="mt-2 text-xs text-slate-500">Add lump-sum prepayments by editing code or wire up a small sub-form if needed.</div>
            </div>

            {/* Investing & Rent vs Buy */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium"><Info size={16}/> Investing & Rent vs Buy</div>
              <div className="grid grid-cols-2 gap-3">
                <NumberInput label="Discount rate (NPV %)" value={cfg.discountRatePct} onChange={(v)=>updateActive({discountRatePct:v})} step={0.25}/>
                <NumberInput label="Horizon (yrs)" value={cfg.horizonYears} onChange={(v)=>updateActive({horizonYears:v})} step={5}/>
                <NumberInput label="Rent (mo)" value={cfg.rentVsBuy.monthlyRent} onChange={(v)=>updateActive({rentVsBuy:{...cfg.rentVsBuy, monthlyRent:v}})} step={50}/>
                <NumberInput label="Rent drift (%)" value={cfg.rentVsBuy.rentInflationPct} onChange={(v)=>updateActive({rentVsBuy:{...cfg.rentVsBuy, rentInflationPct:v}})} step={0.25}/>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-3">
                {result.investResults.map(ir => (
                  <KPI key={ir.key} icon={TrendingUp} label={ir.label} value={`$${ir.final.toLocaleString()}`} hint={`Profit $${ir.profit.toLocaleString()}`}/>
                ))}
              </div>
              <div className="mt-3 text-xs text-slate-500">Savings stream = (full-bank-only payment) − (actual bank+family payment). Compounded monthly.</div>
            </div>
          </section>

          <section className="lg:col-span-2 space-y-6">
            {/* Monthly Payment Mix */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-2 text-sm font-medium">Monthly Payment Mix (Now / 5y / 10y)</div>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={monthlyMix} stackOffset="expand">
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

            {/* Two small charts */}
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-2 text-sm font-medium">Cumulative Interest (Bank vs Family)</div>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={interestLine}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" />
                      <YAxis tickFormatter={(v)=>`$${(v/1000).toFixed(0)}k`} />
                      <RTooltip formatter={(v)=>`$${Math.round(v).toLocaleString()}`} />
                      <RLegend />
                      <Line type="monotone" dataKey="Bank" stroke="#6366f1" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="Family" stroke="#22c55e" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-2 text-sm font-medium">Savings Accumulation vs Full-Bank Baseline</div>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={savingsAccum}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" hide />
                      <YAxis tickFormatter={(v)=>`$${(v/1000).toFixed(0)}k`} />
                      <RTooltip formatter={(v)=>`$${Math.round(v).toLocaleString()}`} />
                      <Area type="monotone" dataKey="val" stroke="#0ea5e9" fill="#bae6fd" />
                      <ReferenceLine y={0} stroke="#64748b" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Rent vs Buy */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-1 flex items-center justify-between">
                <div className="text-sm font-medium">Rent vs Buy — Monthly Delta</div>
                <div className="text-xs text-slate-500">positive = owning costs more this month (ex-principal)</div>
              </div>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={rentVsBuy}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" hide />
                    <YAxis tickFormatter={(v)=>`$${(v/1000).toFixed(0)}k`} />
                    <RTooltip formatter={(v)=>`$${Math.round(v).toLocaleString()}`} />
                    <Line type="monotone" dataKey="delta" stroke="#ef4444" strokeWidth={2} dot={false} />
                    <ReferenceLine y={0} stroke="#22c55e" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* NPV / IRR */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-2 text-sm font-medium">NPV / IRR (Owner cashflows incl. equity terminal value)</div>
              <div className="grid grid-cols-2 gap-4">
                <KPI icon={TrendingUp} label="NPV (disc rate)" value={`$${result.npv.toLocaleString()}`} hint={`@ ${cfg.discountRatePct}%`} />
                <KPI icon={TrendingUp} label="IRR (annualized)" value={`${(result.irrAnnual*100).toFixed(2)}%`} hint="Based on monthly flows" />
              </div>
            </div>
          </section>
        </div>
      </main>

      <footer className="mx-auto max-w-7xl px-4 py-8 text-center text-xs text-slate-500">
        Built for fast scenario exploration. Assumptions are simplified; consult a pro for decisions.
      </footer>
    </div>
  );
}
