import { useState, useEffect } from "react";

// ── Storage adapter ───────────────────────────────────────────────────────────
// Uses the Claude artifact storage API when present; otherwise localStorage.
// Same async interface either way, so the component code doesn't care.
const appStorage = (typeof window !== "undefined" && window.storage) ? window.storage : {
  async get(k)    { const v = localStorage.getItem(k); if (v === null) throw new Error("not found"); return { key: k, value: v }; },
  async set(k, v) { localStorage.setItem(k, v); return { key: k, value: v }; },
  async delete(k) { localStorage.removeItem(k); return { key: k, deleted: true }; },
};

const MIN_PLAYERS  = 2;
const MAX_PLAYERS  = 12;

// Try a chain of CORS proxies; returns Response or null


// ── Golf helpers ──────────────────────────────────────────────────────────────
function holeLabel(net, par) {
  if (net == null || !par) return null;
  const d = net - par;
  if (d <= -3) return { text: "Albatross 🦅🦅", mult: 4, color: "#a78bfa" };
  if (d === -2) return { text: "Eagle 🦅",       mult: 3, color: "#a78bfa" };
  if (d === -1) return { text: "Birdie 🐦",       mult: 2, color: "#60a5fa" };
  if (d === 0)  return { text: "Par",              mult: 1, color: "#e8f5e9" };
  if (d === 1)  return { text: "Bogey",            mult: 1, color: "#f87171" };
  if (d === 2)  return { text: "Double",           mult: 1, color: "#f87171" };
  return { text: `+${d}`, mult: 1, color: "#f87171" };
}
function pMult(net, par)  { return holeLabel(net, par)?.mult || 1; }
function vsParFmt(d)      {
  if (d === 0) return { text: "E",    color: "#e8f5e9" };
  if (d < 0)  return { text: `${d}`, color: "#4ade80" };
  return { text: `+${d}`, color: "#f87171" };
}

// How many handicap strokes does a player get on a given hole?
// hcap = player's full-round handicap (e.g. 18 for 18 holes)
// si   = stroke index of the hole (1 = hardest)
// totalHoles = 9 or 18
function hcapStrokes(hcap, si, totalHoles) {
  if (!hcap || hcap <= 0) return 0;
  const base = Math.floor(hcap / totalHoles);
  const rem  = hcap % totalHoles;
  return base + (si <= rem ? 1 : 0);
}

// ── Pure recalculate ──────────────────────────────────────────────────────────
// holes      = [{hole, par, si, dealer, bets, doubled, strokes}]
// names      = string[]
// handicaps  = number[]   (index = player index)
// totalHoles = 9 | 18
function recalculate(holes, names, handicaps, totalHoles) {
  const n    = names.length;
  const bals = new Array(n).fill(0);
  const log  = [];

  for (const h of holes) {
    const { hole, par, si, dealer, bets, doubled, strokes } = h;
    const nonDlrs = names.map((_, i) => i).filter(i => i !== dealer);

    // Net score for each player
    const net = i => (strokes[i] || par) - hcapStrokes(handicaps[i] || 0, si || hole, totalHoles || 18);

    const dNet = net(dealer);
    const dM   = pMult(dNet, par);
    const swings  = [];
    const outcomes = {};

    nonDlrs.forEach(i => {
      const pNet = net(i);
      const pm   = pMult(pNet, par);
      const base = (bets[i] || 0) * (doubled[i] ? 2 : 1);
      if (pNet < dNet) {
        const amt = base * pm;
        bals[i] += amt; bals[dealer] -= amt;
        outcomes[i] = "win";
        swings.push({ player: names[i], result: "win",  amount: amt, pMult: pm, dMult: 1,  gross: strokes[i]||par, netScore: pNet });
      } else if (pNet > dNet) {
        const amt = base * pm * dM;
        bals[dealer] += amt; bals[i] -= amt;
        outcomes[i] = "loss";
        swings.push({ player: names[i], result: "loss", amount: amt, pMult: pm, dMult: dM, gross: strokes[i]||par, netScore: pNet });
      } else {
        outcomes[i] = "push";
        swings.push({ player: names[i], result: "push", amount: 0,   pMult: 1,  dMult: 1,  gross: strokes[i]||par, netScore: pNet });
      }
    });

    const winners = nonDlrs.filter(i => outcomes[i] === "win");
    let nextDealer = dealer;
    if (winners.length > 0) {
      const minNet = Math.min(...winners.map(i => net(i)));
      nextDealer = winners.filter(i => net(i) === minNet)[0];
    }

    log.push({ hole, dealer, nextDealer, swings, dMult: dM, par, strokes, dNet, dGross: strokes[dealer]||par });
  }
  return { bals, log };
}

// ─────────────────────────────────────────────────────────────────────────────
export default function CasinoGolf() {

  // ── Setup state ────────────────────────────────────────────────────────────
  const [screen,       setScreen]      = useState("setup");
  const [gameView,     setGameView]    = useState("play");
  const [players,      setPlayers]     = useState(["", ""]);
  const [handicaps,    setHandicaps]   = useState([0, 0]);      // per player
  const [nameError,    setNameError]   = useState("");
  const [courseName,   setCourseName]  = useState("");
  const [holeCount,    setHoleCount]   = useState(18);
  const [parPerHole,   setParPerHole]  = useState(Array(20).fill(4));
  // Stroke index: default sequential (hole 1 = SI 1, hole 2 = SI 2, …)
  const [strokeIdx,    setStrokeIdx]   = useState(Array(20).fill(0).map((_,i)=>i+1));

  // ── Source of truth ────────────────────────────────────────────────────────
  const [completedHoles, setCompletedHoles] = useState([]);
  const [balances,       setBalances]       = useState([]);
  const [holeLog,        setHoleLog]        = useState([]);

  // ── Active hole ────────────────────────────────────────────────────────────
  const [hole,           setHole]           = useState(1);
  const [dealerIdx,      setDealerIdx]      = useState(0);
  const [maxBet,         setMaxBet]         = useState("");
  const [betInputs,      setBetInputs]      = useState({});
  const [bets,           setBets]           = useState({});
  const [doubled,        setDoubled]        = useState({});
  const [currentStrokes, setCurrentStrokes] = useState({});
  const [phase,          setPhase]          = useState("setMax");
  const [betError,       setBetError]       = useState("");
  const [strokeError,    setStrokeError]    = useState("");
  const [pendingWinners, setPendingWinners] = useState([]);
  const [pendingData,    setPendingData]    = useState(null);

  // ── Edit ───────────────────────────────────────────────────────────────────
  const [editingIdx,  setEditingIdx]  = useState(null);
  const [editStrokes, setEditStrokes] = useState({});
  const [editNotice,  setEditNotice]  = useState(null);

  // ── Persistent storage ─────────────────────────────────────────────────────
  const [resumeData,   setResumeData]   = useState(null);
  const [savedRounds,  setSavedRounds]  = useState([]);
  const [storageReady, setStorageReady] = useState(false);

  // ── Share ──────────────────────────────────────────────────────────────────
  const [shareToast, setShareToast] = useState(false);

  // ── Golf Course API ────────────────────────────────────────────────────────
  const [courseQuery,      setCourseQuery]      = useState("");
  const [courseResults,    setCourseResults]    = useState([]);
  const [courseSearching,  setCourseSearching]  = useState(false);
  const [courseSearchErr,  setCourseSearchErr]  = useState("");
  const [pickedCourse,     setPickedCourse]     = useState(null);  // search result row
  const [courseTees,       setCourseTees]       = useState([]);
  const [teeLoading,       setTeeLoading]       = useState(false);
  const [loadedCourse,     setLoadedCourse]     = useState(null);  // applied tee summary badge
  const [showManualPar,  setShowManualPar]   = useState(false);

  // ── Load from storage on mount ────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try { const r = await appStorage.get('casino-active');  if (r) setResumeData(JSON.parse(r.value));  } catch(e) {}
      try { const r = await appStorage.get('casino-history'); if (r) setSavedRounds(JSON.parse(r.value)); } catch(e) {}
      // Restore saved course config (may have been loaded on another device)
      try {
        const r = await appStorage.get('casino-course');
        if (r) {
          const c = JSON.parse(r.value);
          if (c.loadedCourse) {
            setCourseName(c.courseName || "");
            setParPerHole(c.parPerHole || Array(20).fill(4));
            setStrokeIdx(c.strokeIdx || Array(20).fill(0).map((_,i)=>i+1));
            setHoleCount(c.holeCount || 18);
            setLoadedCourse(c.loadedCourse);
          }
        }
      } catch(e) {}
      setStorageReady(true);
    }
    load();
  }, []);

  // ── Mobile optimisation ────────────────────────────────────────────────────
  useEffect(() => {
    const el = document.createElement('style');
    el.id = 'casino-mobile';
    el.textContent = [
      // Remove 300ms tap delay and blue flash on every tappable element
      '* { -webkit-tap-highlight-color: transparent !important; box-sizing: border-box; }',
      'button, a, [role="button"], input, select { touch-action: manipulation; }',
      // Prevent iOS from zooming into inputs (requires font-size >= 16px too)
      'input, select, textarea { font-size: 16px !important; }',
      // Prevent iOS Safari from auto-adjusting text size when rotating
      'body { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }',
      // Smooth momentum scrolling on iOS for overflow containers
      '.scroll-x { -webkit-overflow-scrolling: touch; overflow-x: auto; }',
      // Hide scrollbar on scorecard table (still scrollable)
      '.scroll-x::-webkit-scrollbar { display: none; }',
    ].join('\n');
    if (!document.getElementById('casino-mobile')) document.head.appendChild(el);
    return () => { try { document.head.removeChild(el); } catch(e) {} };
  }, []);


  async function saveActive(data)       { try { await appStorage.set('casino-active',  JSON.stringify(data)); } catch(e) {} }
  async function clearActive()          { try { await appStorage.delete('casino-active'); }                      catch(e) {} }
  async function saveToHistory(round) {
    try {
      let existing = [];
      try { const r = await appStorage.get('casino-history'); if (r) existing = JSON.parse(r.value); } catch(e) {}
      const updated = [{ id: Date.now(), date: new Date().toISOString(), ...round }, ...existing].slice(0, 20);
      setSavedRounds(updated);
      await appStorage.set('casino-history', JSON.stringify(updated));
    } catch(e) {}
  }

  function resumeRound(data) {
    setPlayers(data.players);
    setHandicaps(data.handicaps || data.players.map(() => 0));
    setCourseName(data.courseName);
    setHoleCount(data.holeCount);
    setParPerHole(data.parPerHole);
    setStrokeIdx(data.strokeIdx || Array(20).fill(0).map((_,i)=>i+1));
    setCompletedHoles(data.completedHoles);
    setBalances(data.balances);
    setHoleLog(data.holeLog);
    setHole(data.hole);
    setDealerIdx(data.dealerIdx);
    const par  = data.parPerHole[(data.hole||1)-1] || 4;
    const init = {}; data.players.forEach((_,i) => { init[i] = par; });
    setCurrentStrokes(init);
    setMaxBet(""); setBetInputs({}); setBets({}); setDoubled({});
    setPendingWinners([]); setPendingData(null);
    setBetError(""); setStrokeError(""); setPhase("setMax");
    setGameView("play"); setResumeData(null); setScreen("game");
  }

  function endRoundEarly() {
    saveToHistory({ courseName, players, handicaps, completedHoles, balances, holeCount, parPerHole, holesPlayed: completedHoles.length, endedEarly: true });
    clearActive();
    setScreen("ledger");
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const nonDealerIdxs = players.map((_,i) => i).filter(i => i !== dealerIdx);
  const currentPar    = parPerHole[hole-1] || 4;
  const currentSI     = strokeIdx[hole-1]  || hole;

  // Net score for active hole
  const netNow = (i) => (currentStrokes[i]||currentPar) - hcapStrokes(handicaps[i]||0, currentSI, holeCount);

  // ── Setup helpers ──────────────────────────────────────────────────────────
  function addPlayer() {
    if (players.length >= MAX_PLAYERS) return;
    setPlayers(p => [...p, ""]);
    setHandicaps(h => [...h, 0]);
  }
  function removePlayer(i) {
    if (players.length <= MIN_PLAYERS) return;
    setPlayers(p => p.filter((_,x) => x !== i));
    setHandicaps(h => h.filter((_,x) => x !== i));
  }
  function updatePlayer(i, v)  { const n=[...players];   n[i]=v; setPlayers(n);   setNameError(""); }
  function updateHandicap(i,v) { const h=[...handicaps]; h[i]=Math.max(0,Math.min(54,v)); setHandicaps(h); }
  function updateSI(hi, v)     { const n=[...strokeIdx];  n[hi]=Math.max(1,Math.min(holeCount,v)); setStrokeIdx(n); }
  function updatePar(hi, v)     { const n=[...parPerHole]; n[hi]=v; setParPerHole(n); }

  function startGame() {
    const trimmed = players.map(n => n.trim());
    if (trimmed.some(n => !n))                                                    { setNameError("All player names are required."); return; }
    if (new Set(trimmed.map(n => n.toLowerCase())).size < trimmed.length)         { setNameError("Names must be unique."); return; }
    setBalances(new Array(players.length).fill(0));
    setHoleLog([]); setCompletedHoles([]);
    setHole(1); setDealerIdx(0);
    setGameView("play");
    const par  = parPerHole[0] || 4;
    const init = {}; players.forEach((_,i) => { init[i] = par; });
    setCurrentStrokes(init);
    setMaxBet(""); setBetInputs({}); setBets({}); setDoubled({});
    setPendingWinners([]); setPendingData(null);
    setBetError(""); setStrokeError(""); setPhase("setMax");
    clearActive();
    setScreen("game");
  }

  // ── Bet phases ─────────────────────────────────────────────────────────────
  function confirmMaxBet() {
    const val = parseFloat(maxBet);
    if (isNaN(val) || val < 0) { setBetError("Enter a valid max bet ($0 or more)."); return; }
    const init = {}; nonDealerIdxs.forEach(i => { init[i] = String(val); });
    setBetInputs(init); setBetError(""); setPhase("setBets");
  }

  function confirmBets() {
    const max = parseFloat(maxBet);
    for (const i of nonDealerIdxs) {
      const raw = betInputs[i];
      const v   = (raw === "" || raw == null) ? 0 : parseFloat(raw);
      if (isNaN(v) || v < 0 || v > max) { setBetError(`${players[i]}: must be $0–$${max.toFixed(2)}.`); return; }
    }
    const confirmed = {};
    nonDealerIdxs.forEach(i => {
      const raw = betInputs[i];
      confirmed[i] = (raw === "" || raw == null) ? 0 : (parseFloat(raw)||0);
    });
    setBets(confirmed); setBetError(""); setPhase("double");
  }

  function toggleDouble(i)  { setDoubled(d => ({ ...d, [i]: !d[i] })); }
  function baseFinalBet(i)  { return (bets[i]||0) * (doubled[i] ? 2 : 1); }

  // ── Stroke entry ───────────────────────────────────────────────────────────
  function adjustStroke(i, delta) {
    setCurrentStrokes(s => ({ ...s, [i]: Math.max(1, (s[i]||currentPar)+delta) }));
    setStrokeError("");
  }

  function submitStrokes() {
    for (const i of [...nonDealerIdxs, dealerIdx]) {
      if (!currentStrokes[i] || currentStrokes[i] < 1) { setStrokeError("Enter strokes for all players."); return; }
    }
    setStrokeError("");
    const hData = { hole, par: currentPar, si: currentSI, dealer: dealerIdx, bets: {...bets}, doubled: {...doubled}, strokes: {...currentStrokes} };
    const newCompleted = [...completedHoles, hData];

    // Use NET scores for winner determination
    const dNet = netNow(dealerIdx);
    const outcomes = {};
    nonDealerIdxs.forEach(i => {
      const pn = netNow(i);
      outcomes[i] = pn < dNet ? "win" : pn > dNet ? "loss" : "push";
    });
    const winners  = nonDealerIdxs.filter(i => outcomes[i] === "win");
    const minNet   = winners.length ? Math.min(...winners.map(i => netNow(i))) : null;
    const tiedLow  = minNet != null ? winners.filter(i => netNow(i) === minNet) : [];

    if (tiedLow.length > 1) {
      setPendingData({ newCompleted }); setPendingWinners(tiedLow); setPhase("pickDealer");
    } else {
      finalize(newCompleted, tiedLow.length === 1 ? tiedLow[0] : dealerIdx);
    }
  }

  function finalize(newCompleted, nextDealerIdx) {
    const { bals, log } = recalculate(newCompleted, players, handicaps, holeCount);
    setCompletedHoles(newCompleted); setBalances(bals); setHoleLog(log);
    if (hole >= holeCount) {
      clearActive();
      saveToHistory({ courseName, players, handicaps, completedHoles: newCompleted, balances: bals, holeCount, parPerHole, strokeIdx, holesPlayed: newCompleted.length, endedEarly: false });
      setScreen("ledger"); return;
    }
    const nextHole = hole + 1;
    const par  = parPerHole[nextHole-1] || 4;
    const init = {}; players.forEach((_,i) => { init[i] = par; });
    setHole(nextHole); setDealerIdx(nextDealerIdx); setCurrentStrokes(init);
    setMaxBet(""); setBetInputs({}); setBets({}); setDoubled({});
    setPendingWinners([]); setPendingData(null);
    setBetError(""); setStrokeError(""); setPhase("setMax");
    saveActive({ players, handicaps, courseName, holeCount, parPerHole, strokeIdx, completedHoles: newCompleted, hole: nextHole, dealerIdx: nextDealerIdx, balances: bals, holeLog: log });
  }

  // ── Edit ───────────────────────────────────────────────────────────────────
  function startEdit(idx) {
    setEditingIdx(idx); setEditStrokes({ ...completedHoles[idx].strokes });
    setEditNotice(null); setGameView("edit");
  }
  function adjustEditStroke(i, delta) {
    setEditStrokes(s => ({ ...s, [i]: Math.max(1, (s[i]||4)+delta) }));
  }
  function confirmEdit() {
    const h       = completedHoles[editingIdx];
    const oldBals = [...balances];
    const updated = completedHoles.map((c,idx) => idx===editingIdx ? {...c, strokes:{...editStrokes}} : c);
    const { bals, log } = recalculate(updated, players, handicaps, holeCount);
    setEditNotice({ hole: h.hole, diffs: players.map((name,i) => ({ name, diff: bals[i]-oldBals[i] })).filter(d => Math.abs(d.diff)>0.005) });
    setCompletedHoles(updated); setBalances(bals); setHoleLog(log);
    setEditingIdx(null); setEditStrokes({}); setGameView("scorecard");
    saveActive({ players, handicaps, courseName, holeCount, parPerHole, strokeIdx, completedHoles: updated, hole, dealerIdx, balances: bals, holeLog: log });
  }

  // ── Share results ──────────────────────────────────────────────────────────
  function buildShareText() {
    const lines = [];
    const date  = new Date().toLocaleDateString(undefined, { month:"short", day:"numeric", year:"numeric" });
    lines.push(`🃏 CASINO GOLF${courseName ? ` — ${courseName}` : ""}`);
    lines.push(`📅 ${date} · ${completedHoles.length} of ${holeCount} holes`);
    if (handicaps.some(h => h > 0)) {
      lines.push(`♿ Handicaps: ${players.map((p,i) => `${p} (${handicaps[i]})`).join(", ")}`);
    }
    lines.push("");
    lines.push("🏆 STANDINGS");
    const ranked = players.map((_,i)=>i).sort((a,b)=>balances[b]-balances[a]);
    ranked.forEach((i, rank) => {
      const bal = balances[i];
      const sign = bal >= 0 ? "+" : "";
      lines.push(`  ${rank+1}. ${players[i].padEnd(14)} ${sign}$${Math.abs(bal).toFixed(2)}`);
    });
    const settlements = computeSettlements(balances);
    if (settlements.length > 0) {
      lines.push("");
      lines.push("💸 WHO PAYS WHO");
      settlements.forEach(s => {
        lines.push(`  ${players[s.from]} → ${players[s.to]}  $${Math.abs(s.amount).toFixed(2)}`);
      });
    }
    // Notable holes (birdies / eagles)
    const highlights = [];
    holeLog.forEach(h => {
      h.swings.forEach(sw => {
        if (sw.pMult >= 2 && sw.result === "win")
          highlights.push(`  Hole ${h.hole}: ${sw.player} net ${holeLabel(sw.netScore, h.par)?.text || ""} (+$${sw.amount.toFixed(2)})`);
        if (h.dMult >= 2)
          highlights.push(`  Hole ${h.hole}: ${players[h.dealer]} net ${holeLabel(h.dNet, h.par)?.text || ""} (dealer)`);
      });
    });
    if (highlights.length > 0) {
      lines.push("");
      lines.push("⭐ HIGHLIGHTS");
      [...new Set(highlights)].slice(0, 5).forEach(l => lines.push(l));
    }
    return lines.join("\n");
  }

  async function shareResults() {
    const text = buildShareText();
    try {
      if (navigator.share) { await navigator.share({ title: "Casino Golf Results", text }); return; }
    } catch(e) {}
    try {
      await navigator.clipboard.writeText(text);
      setShareToast(true);
      setTimeout(() => setShareToast(false), 2500);
    } catch(e) {
      setShareToast(true); // still show toast even if clipboard fails — last resort
      setTimeout(() => setShareToast(false), 2500);
    }
  }

  // ── Golf Course API functions ──────────────────────────────────────────────


  async function searchCourses() {
    if (!courseQuery.trim()) return;
    setCourseSearching(true); setCourseSearchErr(""); setCourseResults([]); setPickedCourse(null); setCourseTees([]);
    try {
      const res  = await fetch(`/api/golf?path=search&q=${encodeURIComponent(courseQuery.trim())}`);
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const list = data.courses || [];
      setCourseResults(list);
      if (!list.length) setCourseSearchErr("No courses found. Try a different or shorter name.");
    } catch(e) {
      setCourseSearchErr(`Search failed: ${e.message}. You can set par manually on the setup screen.`);
    } finally {
      setCourseSearching(false);
    }
  }

  async function loadCourseTees(course) {
    setPickedCourse(course); setTeeLoading(true); setCourseSearchErr(""); setCourseTees([]);
    try {
      const res  = await fetch(`/api/golf?path=course&id=${encodeURIComponent(course.id)}`);
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const c    = data.course || data;
      const all  = [
        ...(c.tees?.male   || []).map(t => ({ ...t, gender: "M" })),
        ...(c.tees?.female || []).map(t => ({ ...t, gender: "F" })),
      ];
      setCourseTees(all);
      if (!all.length) setCourseSearchErr("No tee data available for this course.");
    } catch(e) {
      setCourseSearchErr(`Failed to load tees: ${e.message}`);
    } finally {
      setTeeLoading(false);
    }
  }

  function applyTee(tee) {
    const holes  = tee.holes || [];
    const newPar = Array(20).fill(4);
    const newSI  = Array(20).fill(0).map((_,i) => i + 1);
    holes.forEach((h, idx) => {
      if (idx < 20) { newPar[idx] = h.par || 4; newSI[idx] = h.handicap || (idx + 1); }
    });
    setParPerHole(newPar);
    setStrokeIdx(newSI);
    setHoleCount(holes.length <= 9 ? 9 : 18);
    const base  = pickedCourse?.club_name || "Course";
    const cName = pickedCourse?.course_name && pickedCourse.course_name !== pickedCourse.club_name
      ? `${base} — ${pickedCourse.course_name}` : base;
    setCourseName(cName);
    const courseInfo = { name: cName, tee: tee.tee_name, gender: tee.gender, yards: tee.total_yards, rating: tee.course_rating, slope: tee.slope_rating, par: tee.par_total, holes: holes.length };
    setLoadedCourse(courseInfo);
    setShowManualPar(false);
    // Persist course config — syncs across devices, so a course searched on
    // desktop is ready and waiting on the phone.
    (async () => {
      try {
        await appStorage.set('casino-course', JSON.stringify({
          courseName: cName, parPerHole: newPar, strokeIdx: newSI,
          holeCount: holes.length <= 9 ? 9 : 18, loadedCourse: courseInfo,
          savedAt: new Date().toISOString(),
        }));
      } catch(e) {}
    })();
    setScreen("setup");
  }

  const TEE_COLORS = { Black:"#1a1a1a", Blue:"#2563eb", White:"#e8f5e9", Gold:"#d97706", Yellow:"#d97706", Red:"#dc2626", Green:"#16a34a", Silver:"#9ca3af", Bronze:"#92400e" };
  function teeColor(name) { return TEE_COLORS[name] || "#6dbf7e"; }

  // ── Helpers ────────────────────────────────────────────────────────────────
  const fmt    = n => n >= 0 ? `+$${Math.abs(n).toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
  const fmtAbs = n => `$${Math.abs(n).toFixed(2)}`;
  function playerTotGross(pi) { return completedHoles.reduce((s,h) => s+(h.strokes[pi]||0), 0); }
  function playerTotNet(pi)   { return completedHoles.reduce((s,h) => s+(h.strokes[pi]||0)-hcapStrokes(handicaps[pi]||0, h.si||h.hole, holeCount), 0); }
  function playerTotVsPar(pi) { return playerTotNet(pi) - completedHoles.reduce((s,h)=>s+h.par,0); }

  function computeSettlements(bals) {
    const entries = bals.map((b,i) => ({ idx:i, bal:b })).sort((a,b) => a.bal-b.bal);
    const temp = entries.map(e => e.bal);
    const out  = [];
    let lo=0, hi=entries.length-1;
    while (lo < hi) {
      const pay = Math.min(-temp[lo], temp[hi]);
      if (pay > 0.005) out.push({ from: entries[lo].idx, to: entries[hi].idx, amount: pay });
      temp[lo]+=pay; temp[hi]-=pay;
      if (Math.abs(temp[lo])<0.005) lo++;
      if (Math.abs(temp[hi])<0.005) hi--;
    }
    return out;
  }
  const RES = { win:{e:"✅",c:"#4ade80"}, push:{e:"🤝",c:"#fbbf24"}, loss:{e:"❌",c:"#f87171"} };

  // ── COURSE SEARCH SCREEN ───────────────────────────────────────────────────
  if (screen === "courseSearch") {
    return (
      <div style={S.root}>
        <div style={S.topBar}>
          <button style={S.iconBtn} onClick={()=>setScreen("setup")}>← Setup</button>
          <span style={S.topTitle}>🔍 Find a Course</span>
          <span style={{width:56}}/>
        </div>

        {/* Search bar */}
        <div style={S.card}>
          <p style={S.phaseTitle}>Search Golf Courses</p>
          <p style={S.phaseDesc}>Enter a course or club name — we'll load the scorecard and tees automatically.</p>
          <div style={{display:"flex",gap:8}}>
            <input style={{...S.input,flex:1}} placeholder="e.g. Pebble Beach, TPC Sawgrass…"
              autoComplete="off" autoCorrect="off" autoCapitalize="words"
              value={courseQuery}
              onChange={e=>{setCourseQuery(e.target.value);setCourseSearchErr("");}}
              onKeyDown={e=>e.key==="Enter"&&searchCourses()}/>
            <button style={{...S.primaryBtn,marginTop:0,width:"auto",padding:"10px 18px",fontSize:14,whiteSpace:"nowrap"}}
              onClick={searchCourses} disabled={courseSearching}>
              {courseSearching ? "…" : "Search"}
            </button>
          </div>
          {courseSearching && <p style={{fontSize:12,color:"#6dbf7e",marginTop:8}}>
            {courseSearchErr || "Searching…"}
          </p>}
          {!courseSearching && courseSearchErr && <p style={S.err}>{courseSearchErr}</p>}
        </div>

        {/* Results */}
        {courseResults.length > 0 && !pickedCourse && (
          <div style={S.card}>
            <p style={S.sLabel}>{courseResults.length} RESULT{courseResults.length!==1?"S":""}</p>
            {courseResults.map(c=>(
              <button key={c.id} style={S.courseResultBtn} onClick={()=>loadCourseTees(c)}>
                <div>
                  <div style={S.courseResultName}>{c.club_name}</div>
                  {c.course_name!==c.club_name&&<div style={{fontSize:12,color:"#6dbf7e"}}>{c.course_name}</div>}
                  <div style={S.courseResultLoc}>{[c.location?.city,c.location?.state,c.location?.country].filter(Boolean).join(", ")}</div>
                </div>
                <span style={{color:"#ffd700",fontSize:18}}>›</span>
              </button>
            ))}
          </div>
        )}

        {/* Tee loading */}
        {teeLoading && (
          <div style={{...S.card,textAlign:"center",color:"#6dbf7e",fontSize:13}}>Loading tees…</div>
        )}

        {/* Tee selection */}
        {pickedCourse && courseTees.length > 0 && (
          <div style={S.card}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
              <button style={S.discardBtn} onClick={()=>{setPickedCourse(null);setCourseTees([]);}}>← Back</button>
              <span style={{...S.sLabel,margin:0}}>{pickedCourse.club_name}</span>
            </div>
            <p style={{...S.phaseDesc,marginBottom:12}}>Select the tees you're playing:</p>
            {courseTees.map((t,i)=>{
              const tc = teeColor(t.tee_name);
              const isMens = t.gender==="M";
              return (
                <div key={i} style={S.teeCard}>
                  <div style={{display:"flex",alignItems:"center",gap:10,flex:1}}>
                    <div style={{width:14,height:14,borderRadius:"50%",backgroundColor:tc,border:"2px solid rgba(255,255,255,0.3)",flexShrink:0}}/>
                    <div>
                      <div style={{fontWeight:700,fontSize:15,color:"#e8f5e9"}}>
                        {t.tee_name} <span style={{fontSize:11,color:"#6dbf7e"}}>{isMens?"Men's":"Women's"}</span>
                      </div>
                      <div style={{fontSize:11,color:"#6dbf7e",fontFamily:"monospace",marginTop:2}}>
                        Par {t.par_total} · {t.total_yards?.toLocaleString()} yds · Rating {t.course_rating} · Slope {t.slope_rating}
                      </div>
                      <div style={{fontSize:10,color:"#4a7a5a",marginTop:1}}>{t.number_of_holes} holes</div>
                    </div>
                  </div>
                  <button style={S.applyTeeBtn} onClick={()=>applyTee(t)}>Use ›</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ── SETUP ──────────────────────────────────────────────────────────────────
  if (screen === "setup") {
    if (!storageReady) return (
      <div style={{...S.root,display:"flex",alignItems:"center",justifyContent:"center"}}>
        <div style={{color:"#6dbf7e",fontSize:14,letterSpacing:"0.1em"}}>Loading…</div>
      </div>
    );
    const anyHcap   = handicaps.some(h=>h>0);

    return (
      <div style={S.root}>
        <div style={S.header}>
          <div style={S.chipIcon}>🃏</div>
          <h1 style={S.title}>CASINO</h1>
          <p style={S.subtitle}>Golf Betting Game</p>
        </div>

        {resumeData && (
          <div style={S.resumeCard}>
            <div style={S.resumeIcon}>🔄</div>
            <div style={{flex:1}}>
              <div style={S.resumeTitle}>Round in Progress</div>
              <div style={S.resumeMeta}>{resumeData.courseName||"Unnamed course"} · Hole {resumeData.hole} of {resumeData.holeCount}</div>
              <div style={S.resumePlayers}>{resumeData.players.join(", ")}</div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              <button style={S.resumeBtn} onClick={()=>resumeRound(resumeData)}>Resume</button>
              <button style={S.discardBtn} onClick={()=>{ clearActive(); setResumeData(null); }}>Discard</button>
            </div>
          </div>
        )}

        <div style={S.card}>
          <div style={S.cardHead}>
            <p style={{...S.sLabel,margin:0}}>COURSE</p>
            <button style={S.searchCourseBtn} onClick={()=>{setCourseResults([]);setPickedCourse(null);setCourseTees([]);setCourseSearchErr("");setScreen("courseSearch");}}>
              🔍 Search Course
            </button>
          </div>

          {/* Loaded course badge */}
          {loadedCourse && (
            <div style={S.loadedBadge}>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:13,color:"#4ade80"}}>✅ {loadedCourse.name}</div>
                <div style={{fontSize:11,color:"#6dbf7e",marginTop:2,fontFamily:"monospace"}}>
                  {loadedCourse.tee} Tees ({loadedCourse.gender==="M"?"Men's":"Women's"}) · Par {loadedCourse.par} · {loadedCourse.yards?.toLocaleString()} yds · Rating {loadedCourse.rating} · Slope {loadedCourse.slope}
                </div>
                <div style={{fontSize:10,color:"#4a7a5a",marginTop:1}}>Par and stroke index loaded automatically ✓</div>
              </div>
              <button style={S.clearCourseBtn} onClick={()=>{setLoadedCourse(null);setCourseName("");setParPerHole(Array(20).fill(4));setStrokeIdx(Array(20).fill(0).map((_,i)=>i+1));setShowManualPar(false);(async()=>{try{await appStorage.delete('casino-course');}catch(e){}})();}}>✕</button>
            </div>
          )}

          {/* Manual course name (only if no loaded course) */}
          {!loadedCourse && (
            <div style={S.row}>
              <span style={S.fieldIcon}>⛳</span>
              <input style={{...S.input,flex:1}} placeholder="Course name (optional)"
                value={courseName} onChange={e=>setCourseName(e.target.value)}/>
            </div>
          )}

          <div style={S.row}>
            <span style={S.fieldIcon}>🏌️</span>
            <span style={S.iLabel}>Holes</span>
            {[9,18].map(n=>(
              <button key={n} style={holeCount===n?S.segOn:S.segOff} onClick={()=>setHoleCount(n)}>{n}</button>
            ))}
          </div>
        </div>


        {/* Manual par entry — shown when no course loaded, or toggled manually */}
        {(!loadedCourse || showManualPar) && (
          <div style={S.card}>
            <div style={S.cardHead}>
              <p style={{...S.sLabel,margin:0}}>
                PAR PER HOLE
                <span style={{color:"#6dbf7e",fontWeight:400,marginLeft:8}}>
                  {loadedCourse ? "(from course search)" : "(set manually)"}
                </span>
              </p>
              <span style={S.gold}>{parPerHole.slice(0,holeCount).reduce((a,b)=>a+b,0)} total</span>
            </div>
            {loadedCourse && (
              <p style={{fontSize:11,color:"#6dbf7e",marginBottom:10}}>
                Override individual holes if the scorecard has an error.
              </p>
            )}
            <div style={S.parGrid}>
              {Array.from({length:holeCount},(_,i)=>i).map(hi=>(
                <div key={hi} style={S.parCell}>
                  <span style={S.parNum}>{hi+1}</span>
                  <div style={S.parBtnRow}>
                    {[3,4,5].map(p=>(
                      <button key={p}
                        style={parPerHole[hi]===p ? S.parBtnOn : S.parBtnOff}
                        onClick={()=>updatePar(hi,p)}>{p}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {loadedCourse && !showManualPar && (
          <button
            style={{...S.discardBtn,margin:"8px 14px 0",display:"block",textAlign:"center",width:"calc(100% - 28px)",padding:"10px"}}
            onClick={()=>setShowManualPar(true)}>
            ✏️ Override par per hole
          </button>
        )}

        <div style={S.card}>
          <div style={S.cardHead}>
            <p style={{...S.sLabel,margin:0}}>PLAYERS ({players.length}/{MAX_PLAYERS})</p>
            {players.length<MAX_PLAYERS && <button style={S.addBtn} onClick={addPlayer}>+ Add</button>}
          </div>

          {/* Handicap explainer */}
          <div style={S.hcapNote}>
            ♿ Enter each player's <strong>{holeCount}-hole handicap</strong> (0 = scratch).
            Net scores determine Casino outcomes — birdies and eagles calculated on net score.
            Stroke index defaults to sequential (hardest = hole 1).
          </div>

          {players.map((name,i)=>(
            <div key={i} style={{marginBottom:12}}>
              <div style={S.row}>
                <span style={S.pNum}>{i===0?"🃏":i+1}</span>
                <input style={{...S.input,flex:1}}
                  placeholder={i===0?"Dealer (Hole 1)":`Player ${i+1}`}
                  value={name} onChange={e=>updatePlayer(i,e.target.value)}/>
                {players.length>MIN_PLAYERS &&
                  <button style={S.rmBtn} onClick={()=>removePlayer(i)}>✕</button>}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8,paddingLeft:30}}>
                <span style={{fontSize:12,color:"#6dbf7e",width:70}}>Handicap</span>
                <div style={S.hcapStepper}>
                  <button style={S.hcapBtn} onClick={()=>updateHandicap(i,handicaps[i]-1)}>−</button>
                  <span style={S.hcapVal}>{handicaps[i]||0}</span>
                  <button style={S.hcapBtn} onClick={()=>updateHandicap(i,handicaps[i]+1)}>+</button>
                </div>
                {handicaps[i]>0 && (
                  <span style={{fontSize:11,color:"#6dbf7e",fontFamily:"monospace"}}>
                    ~{hcapStrokes(handicaps[i], 1, holeCount)}-{hcapStrokes(handicaps[i], holeCount, holeCount)} strokes/hole
                  </span>
                )}
              </div>
            </div>
          ))}
          {nameError && <p style={S.err}>{nameError}</p>}
        </div>

        <div style={S.card}>
          <p style={S.ruleTitle}>Rules</p>
          <ul style={S.rules}>
            <li>Dealer sets max bet · $0 bet = sit that hole out</li>
            <li><strong>Net</strong> birdie 🐦 ×2 · eagle 🦅 ×3 · albatross ×4 (auto from net score vs par)</li>
            <li>Lower net score beats dealer → wins bet. Equal → push. Higher → loses</li>
            <li>Dealer net under par → multiplier applies to all losses</li>
            <li>Low net score winner becomes next dealer automatically</li>
          </ul>
        </div>

        {savedRounds.length>0 && (
          <div style={S.card}>
            <p style={S.sLabel}>PAST ROUNDS</p>
            {savedRounds.map((r,i)=>{
              const dt     = new Date(r.date);
              const dtStr  = dt.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})+" · "+dt.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"});
              const ranked = r.players.map((_,pi)=>pi).sort((a,b)=>(r.balances[b]||0)-(r.balances[a]||0));
              return (
                <div key={r.id} style={{...S.histRow,borderBottom:i<savedRounds.length-1?"1px solid #1e4d2b":"none"}}>
                  <div style={{flex:1}}>
                    <div style={S.histCourse}>
                      {r.courseName||"Unnamed course"}
                      {r.endedEarly && <span style={S.earlyChip}>{r.holesPlayed} holes</span>}
                    </div>
                    <div style={S.histDate}>{dtStr}</div>
                    <div style={S.histPlayers}>
                      {ranked.slice(0,3).map(pi=>{
                        const bal=r.balances[pi]||0;
                        return (
                          <span key={pi} style={{marginRight:10}}>
                            {r.players[pi]}{(r.handicaps||[])[pi]>0?` (${r.handicaps[pi]})`:""}<span style={{marginLeft:3,color:bal>=0?"#4ade80":"#f87171",fontFamily:"monospace",fontSize:11}}>{bal>=0?"+":""}{bal.toFixed(2)}</span>
                          </span>
                        );
                      })}
                      {ranked.length>3&&<span style={{color:"#6dbf7e",fontSize:11}}>+{ranked.length-3} more</span>}
                    </div>
                  </div>
                </div>
              );
            })}
            <button style={{...S.discardBtn,marginTop:12,width:"100%"}}
              onClick={async()=>{ setSavedRounds([]); try{await appStorage.delete('casino-history');}catch(e){} }}>
              Clear History
            </button>
          </div>
        )}

        <div style={{padding:"0 14px 8px"}}>
          <button style={S.primaryBtn} onClick={startGame}>Tee It Up</button>
        </div>
      </div>
    );
  }

  // ── SCORECARD VIEW ─────────────────────────────────────────────────────────
  if (screen==="game" && gameView==="scorecard") {
    return (
      <div style={S.root}>
        <div style={S.topBar}>
          <button style={S.iconBtn} onClick={()=>{setGameView("play");setEditNotice(null);}}>← Play</button>
          <span style={S.topTitle}>{courseName||"Scorecard"} · Hole {hole}</span>
          <button style={{...S.iconBtn,color:"#ffd700"}} onClick={shareResults}>
            {shareToast ? "✓ Copied!" : "📤 Share"}
          </button>
        </div>

        {editNotice && (
          <div style={S.noticeBanner}>
            <strong>Hole {editNotice.hole} recalculated.</strong>
            {editNotice.diffs.map((d,i)=>(
              <span key={i} style={{marginLeft:8,color:d.diff>0?"#4ade80":"#f87171"}}>
                {d.name} {d.diff>0?"+":""}{d.diff.toFixed(2)}
              </span>
            ))}
          </div>
        )}

        {completedHoles.length===0
          ? <div style={{...S.card,color:"#6dbf7e",fontSize:13}}>No holes completed yet.</div>
          : (
          <div style={S.card}>
            <div className="scroll-x" style={{overflowX:"auto"}}>
              <table style={S.tbl}>
                <thead>
                  <tr>
                    <th style={S.th}>Hole</th>
                    <th style={S.th}>Par</th>
                    {players.map((p,i)=>(
                      <th key={i} style={S.th}>
                        {p.substring(0,7)}{handicaps[i]>0&&<div style={{fontSize:9,color:"#6dbf7e"}}>HCP {handicaps[i]}</div>}
                      </th>
                    ))}
                    <th style={S.th}/>
                  </tr>
                </thead>
                <tbody>
                  {completedHoles.map((h,idx)=>(
                    <tr key={idx} style={{backgroundColor:idx%2===0?"#0a1a0f":"#0d2218"}}>
                      <td style={S.td}>{h.hole}</td>
                      <td style={S.td}>{h.par}</td>
                      {players.map((_,pi)=>{
                        const gross = h.strokes[pi]||0;
                        const hs    = hcapStrokes(handicaps[pi]||0, h.si||h.hole, holeCount);
                        const net   = gross - hs;
                        const lab   = holeLabel(net, h.par);
                        const sf    = vsParFmt(net-h.par);
                        return (
                          <td key={pi} style={S.td}>
                            <div style={{fontWeight:700}}>{gross}{hs>0&&<span style={{fontSize:10,color:"#6dbf7e"}}> ({net})</span>}</div>
                            <div style={{fontSize:10,color:sf.color}}>{sf.text}</div>
                            {lab&&lab.mult>1&&<div style={{fontSize:9,color:lab.color}}>{lab.text.split(" ")[0]}</div>}
                          </td>
                        );
                      })}
                      <td style={S.td}><button style={S.editBtn} onClick={()=>startEdit(idx)}>✏️</button></td>
                    </tr>
                  ))}
                  <tr style={{backgroundColor:"#1a3d10",fontWeight:700}}>
                    <td style={S.td}>TOT</td>
                    <td style={S.td}>{parPerHole.slice(0,completedHoles.length).reduce((a,b)=>a+b,0)}</td>
                    {players.map((_,pi)=>{
                      const gross=playerTotGross(pi); const net=playerTotNet(pi);
                      const sf=vsParFmt(playerTotVsPar(pi));
                      return (
                        <td key={pi} style={S.td}>
                          <div>{gross}{handicaps[pi]>0&&<span style={{fontSize:10,color:"#6dbf7e"}}> ({net})</span>}</div>
                          <div style={{fontSize:10,color:sf.color}}>{sf.text}</div>
                        </td>
                      );
                    })}
                    <td style={S.td}/>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div style={S.card}>
          <p style={S.sLabel}>MONEY</p>
          {players.map((_,i)=>i).sort((a,b)=>balances[b]-balances[a]).map(i=>(
            <div key={i} style={{...S.standRow,padding:"8px 0"}}>
              <span style={{...S.standName,fontSize:14}}>{players[i]}</span>
              <span style={{fontSize:14,fontWeight:700,fontFamily:"monospace",color:balances[i]>=0?"#4ade80":"#f87171"}}>{fmt(balances[i])}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── EDIT VIEW ──────────────────────────────────────────────────────────────
  if (screen==="game" && gameView==="edit" && editingIdx!==null) {
    const h = completedHoles[editingIdx];
    return (
      <div style={S.root}>
        <div style={S.topBar}>
          <button style={S.iconBtn} onClick={()=>{setEditingIdx(null);setEditStrokes({});setGameView("scorecard");}}>✕ Cancel</button>
          <span style={S.topTitle}>Edit Hole {h.hole} (Par {h.par})</span>
          <span style={{width:72}}/>
        </div>
        <div style={S.card}>
          <p style={S.phaseTitle}>✏️ Edit Strokes — Hole {h.hole}</p>
          <p style={S.phaseDesc}>Adjust gross scores. Net = gross minus handicap strokes. Bets locked in.</p>
          {players.map((_,i)=>{
            const gross = editStrokes[i] || h.par;
            const hs    = hcapStrokes(handicaps[i]||0, h.si||h.hole, holeCount);
            const net   = gross - hs;
            const lab   = holeLabel(net, h.par);
            const isDlr = i===h.dealer;
            return (
              <div key={i} style={S.strokeRow}>
                <div style={{flex:1}}>
                  <div style={S.strokeName}>
                    {players[i]}{isDlr&&<span style={S.dealerChip}>DEALER</span>}
                    {!isDlr&&(h.bets[i]||0)===0&&<span style={S.sittingChip}>$0</span>}
                  </div>
                  <div style={{fontSize:11,color:"#6dbf7e",fontFamily:"monospace",marginTop:2}}>
                    {hs>0 ? `gross ${gross} − ${hs} hcap = net ${net}` : `gross ${gross} (scratch)`}
                  </div>
                  {lab&&<div style={{fontSize:12,color:lab.color,marginTop:2}}>
                    {lab.text}{lab.mult>1&&<span style={{...S.multBadge,marginLeft:5}}>×{lab.mult}</span>}
                  </div>}
                </div>
                <div style={S.stepper}>
                  <button style={S.stepBtn} onClick={()=>adjustEditStroke(i,-1)}>−</button>
                  <span style={S.stepVal}>{gross}</span>
                  <button style={S.stepBtn} onClick={()=>adjustEditStroke(i,1)}>+</button>
                </div>
              </div>
            );
          })}
          {(()=>{
            const preview = completedHoles.map((c,idx) => idx===editingIdx ? {...c,strokes:{...editStrokes}} : c);
            const {bals:newB} = recalculate(preview, players, handicaps, holeCount);
            const diffs = players.map((name,i)=>({name,diff:newB[i]-balances[i]})).filter(d=>Math.abs(d.diff)>0.005);
            if (!diffs.length) return null;
            return (
              <div style={S.previewBox}>
                <p style={S.previewTitle}>Impact of Change</p>
                {diffs.map((d,i)=>(
                  <div key={i} style={{...S.previewLine,color:d.diff>0?"#4ade80":"#f87171"}}>
                    {d.name}: {d.diff>0?"+":""}{d.diff.toFixed(2)}
                  </div>
                ))}
              </div>
            );
          })()}
          <button style={S.primaryBtn} onClick={confirmEdit}>Save Changes</button>
        </div>
      </div>
    );
  }

  // ── LEDGER ─────────────────────────────────────────────────────────────────
  if (screen==="ledger") {
    const settlements = computeSettlements(balances);
    const ranked      = players.map((_,i)=>i).sort((a,b)=>balances[b]-balances[a]);
    const anyHcap     = handicaps.some(h=>h>0);
    return (
      <div style={S.root}>
        <div style={S.header}>
          <div style={S.chipIcon}>🏆</div>
          <h1 style={S.title}>FINAL LEDGER</h1>
          <p style={S.subtitle}>{courseName||"Round Complete"} · {completedHoles.length} holes</p>
        </div>

        {/* Share button */}
        <div style={{padding:"14px 14px 0"}}>
          <button style={{...S.primaryBtn,marginTop:0,backgroundColor: shareToast?"#4ade80":"#ffd700"}} onClick={shareResults}>
            {shareToast ? "✓ Copied to clipboard!" : "📤 Share Results"}
          </button>
        </div>

        <div style={S.card}>
          <p style={S.sLabel}>STANDINGS{anyHcap?" (NET SCORES)":""}</p>
          {ranked.map((i,rank)=>(
            <div key={i} style={S.standRow}>
              <span style={S.standRank}>{rank+1}</span>
              <div style={{flex:1}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={S.standName}>{players[i]}</span>
                  {handicaps[i]>0&&<span style={{fontSize:11,color:"#6dbf7e"}}>HCP {handicaps[i]}</span>}
                </div>
                <div style={{fontSize:11,color:vsParFmt(playerTotVsPar(i)).color}}>
                  {vsParFmt(playerTotVsPar(i)).text} net · {playerTotGross(i)} gross
                </div>
              </div>
              <span style={{...S.standBal,color:balances[i]>=0?"#4ade80":"#f87171"}}>{fmt(balances[i])}</span>
            </div>
          ))}
        </div>

        {settlements.length>0&&(
          <div style={S.card}>
            <p style={S.sLabel}>WHO PAYS WHO</p>
            {settlements.map((s,i)=>(
              <div key={i} style={S.settleRow}>
                <span style={S.settleName}>{players[s.from]}</span>
                <span style={S.settleArrow}>→</span>
                <span style={S.settleName}>{players[s.to]}</span>
                <span style={S.settleAmt}>{fmtAbs(s.amount)}</span>
              </div>
            ))}
          </div>
        )}

        <div style={S.card}>
          <p style={S.sLabel}>SCORECARD {anyHcap?"(gross / net)":""}</p>
          <div className="scroll-x" style={{overflowX:"auto"}}>
            <table style={S.tbl}>
              <thead>
                <tr>
                  <th style={S.th}>Hole</th>
                  <th style={S.th}>Par</th>
                  {players.map((p,i)=>(
                    <th key={i} style={S.th}>{p.substring(0,6)}{anyHcap&&<div style={{fontSize:9,color:"#6dbf7e"}}>{handicaps[i]>0?`HCP${handicaps[i]}`:"SCR"}</div>}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {completedHoles.map((h,idx)=>(
                  <tr key={idx} style={{backgroundColor:idx%2===0?"#0a1a0f":"#0d2218"}}>
                    <td style={S.td}>{h.hole}</td>
                    <td style={S.td}>{h.par}</td>
                    {players.map((_,pi)=>{
                      const gross=h.strokes[pi]||0;
                      const hs   =hcapStrokes(handicaps[pi]||0, h.si||h.hole, holeCount);
                      const net  =gross-hs;
                      const lab  =holeLabel(net, h.par);
                      const sf   =vsParFmt(net-h.par);
                      return (
                        <td key={pi} style={S.td}>
                          <div style={{fontWeight:700}}>{gross}{hs>0&&<span style={{fontSize:9,color:"#6dbf7e"}}>/{net}</span>}</div>
                          <div style={{fontSize:9,color:sf.color}}>{sf.text}</div>
                          {lab&&lab.mult>1&&<div style={{fontSize:8,color:lab.color}}>{lab.text.split(" ")[0]}</div>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr style={{backgroundColor:"#1a3d10",fontWeight:700}}>
                  <td style={S.td}>TOT</td>
                  <td style={S.td}>{parPerHole.slice(0,holeCount).reduce((a,b)=>a+b,0)}</td>
                  {players.map((_,pi)=>{
                    const g=playerTotGross(pi), n=playerTotNet(pi), sf=vsParFmt(playerTotVsPar(pi));
                    return <td key={pi} style={S.td}><div>{g}{handicaps[pi]>0&&<span style={{fontSize:9,color:"#6dbf7e"}}>/{n}</span>}</div><div style={{fontSize:9,color:sf.color}}>{sf.text}</div></td>;
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {holeLog.length>0&&(
          <div style={S.card}>
            <p style={S.sLabel}>HOLE LOG</p>
            {holeLog.map((h,i)=>{
              const ch=completedHoles[i];
              const dGross=ch?ch.strokes[h.dealer]:null;
              const dHs=ch?hcapStrokes(handicaps[h.dealer]||0, ch.si||ch.hole, holeCount):0;
              const dNet=dGross!=null?dGross-dHs:null;
              const dLab=dNet!=null?holeLabel(dNet, h.par):null;
              return (
                <div key={i} style={S.holeLogRow}>
                  <div style={S.holeLogHead}>
                    <span style={S.holeLogNum}>Hole {h.hole}</span>
                    <span style={S.holeLogD}>{players[h.dealer]}{dLab&&dLab.mult>1?` ${dLab.text}`:""}</span>
                    {h.nextDealer!==h.dealer
                      ?<span style={{...S.holeLogBadge,color:"#ffd700"}}>→ {players[h.nextDealer]}</span>
                      :<span style={{...S.holeLogBadge,color:"#6dbf7e"}}>stays</span>}
                  </div>
                  {h.swings.map((sw,j)=>{
                    const cfg=RES[sw.result];
                    const mult=sw.pMult*(sw.result==="loss"?sw.dMult:1);
                    const text=sw.result==="push"?`${sw.player} pushed`
                      :sw.result==="win"?`${sw.player} wins $${sw.amount.toFixed(2)}${mult>1?` (×${mult})`:""}` 
                      :`${players[h.dealer]} takes $${sw.amount.toFixed(2)} from ${sw.player}${mult>1?` (×${mult})`:""}`
                    return <div key={j} style={{...S.holeLogSwing,color:cfg.c}}>{cfg.e} {text}</div>;
                  })}
                </div>
              );
            })}
          </div>
        )}

        <div style={{padding:"0 14px 8px"}}>
          <button style={S.primaryBtn} onClick={()=>{ setScreen("setup"); setHole(1); setDealerIdx(0); setBalances([]); setHoleLog([]); setCompletedHoles([]); }}>
            New Round
          </button>
        </div>
      </div>
    );
  }

  // ── GAME (play view) ───────────────────────────────────────────────────────
  const maxVal = parseFloat(maxBet)||0;
  return (
    <div style={S.root}>
      <div style={S.topBar}>
        <div>
          <div style={S.holeChip}>HOLE {hole}</div>
          {courseName&&<div style={{fontSize:9,color:"#6dbf7e",textAlign:"center",marginTop:1}}>{courseName}</div>}
        </div>
        <div style={S.dealerTag}>
          <span style={S.dlrLabel}>DEALER</span>
          <span style={S.dlrName}>{players[dealerIdx]}</span>
          <span style={{fontSize:9,color:"#6dbf7e"}}>Par {currentPar}</span>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:4,alignItems:"flex-end"}}>
          <button style={S.iconBtn} onClick={()=>{setEditNotice(null);setGameView("scorecard");}}>
            📊{completedHoles.length>0&&<span style={S.badge}>{completedHoles.length}</span>}
          </button>
          <button style={{...S.iconBtn,fontSize:10}} onClick={endRoundEarly}>End</button>
        </div>
      </div>
      <div style={S.progressBar}><div style={{...S.progressFill,width:`${((hole-1)/holeCount)*100}%`}}/></div>
      <div style={S.miniBar}>
        {players.map((name,i)=>(
          <div key={i} style={S.miniBal}>
            <span style={S.miniName}>{name.substring(0,6)}</span>
            <span style={{...S.miniVal,color:balances[i]>=0?"#4ade80":"#f87171"}}>{fmt(balances[i])}</span>
          </div>
        ))}
      </div>

      {/* SET MAX BET */}
      {phase==="setMax"&&(
        <div style={S.card}>
          <p style={S.phaseTitle}>📋 Set the Max Bet</p>
          <p style={S.phaseDesc}><strong>{players[dealerIdx]}</strong>, you're the dealer. Hole {hole} · Par {currentPar} · SI {currentSI}</p>
          <div style={S.row}>
            <span style={S.dlrSign}>$</span>
            <input style={{...S.input,flex:1}} type="number" min="0" step="0.5" inputMode="decimal" placeholder="e.g. 5 (or 0 to skip)"
              value={maxBet} onChange={e=>{setMaxBet(e.target.value);setBetError("");}}/>
          </div>
          {betError&&<p style={S.err}>{betError}</p>}
          <button style={S.primaryBtn} onClick={confirmMaxBet}>Set Max Bet</button>
        </div>
      )}

      {/* SET BETS */}
      {phase==="setBets"&&(
        <div style={S.card}>
          <p style={S.phaseTitle}>💰 Place Your Bets</p>
          <p style={S.phaseDesc}>Max: <strong>${maxVal.toFixed(2)}</strong>. Enter $0 to sit out.</p>
          {nonDealerIdxs.map(i=>(
            <div key={i} style={S.row}>
              <label style={S.iLabel}>{players[i]}{handicaps[i]>0&&<span style={{fontSize:10,color:"#6dbf7e"}}> ({handicaps[i]})</span>}</label>
              <span style={S.dlrSign}>$</span>
              <input style={{...S.input,flex:1}} type="number" min="0" max={maxVal} step="0.5" inputMode="decimal"
                placeholder="0" value={betInputs[i]??""}
                onChange={e=>{setBetInputs(b=>({...b,[i]:e.target.value}));setBetError("");}}/>
            </div>
          ))}
          {betError&&<p style={S.err}>{betError}</p>}
          <button style={S.primaryBtn} onClick={confirmBets}>Lock Bets</button>
        </div>
      )}

      {/* DOUBLE */}
      {phase==="double"&&(
        <div style={S.card}>
          <p style={S.phaseTitle}>🏌️ Double Down?</p>
          <p style={S.phaseDesc}>After seeing your tee shot, you can double your bet.</p>
          {nonDealerIdxs.map(i=>(
            <div key={i} style={S.dblRow}>
              <div>
                <span style={S.dblName}>{players[i]}</span>
                <span style={S.dblOrig}>${(bets[i]||0).toFixed(2)}{doubled[i]?` → $${((bets[i]||0)*2).toFixed(2)}`:""}</span>
              </div>
              {(bets[i]||0)>0
                ?<button style={doubled[i]?S.dblBtnOn:S.dblBtnOff} onClick={()=>toggleDouble(i)}>{doubled[i]?"✓ Doubled!":"Double"}</button>
                :<span style={{fontSize:11,color:"#6b7280"}}>sitting out</span>}
            </div>
          ))}
          <button style={S.primaryBtn} onClick={()=>setPhase("strokes")}>Enter Strokes →</button>
        </div>
      )}

      {/* STROKES */}
      {phase==="strokes"&&(
        <div style={S.card}>
          <p style={S.phaseTitle}>⛳ Hole {hole} Strokes <span style={{color:"#6dbf7e",fontSize:14}}>Par {currentPar} · SI {currentSI}</span></p>
          <p style={S.phaseDesc}>Enter gross scores. Net = gross minus handicap strokes.</p>

          {[dealerIdx,...nonDealerIdxs].map(i=>{
            const gross = currentStrokes[i]||currentPar;
            const hs    = hcapStrokes(handicaps[i]||0, currentSI, holeCount);
            const net   = gross - hs;
            const lab   = holeLabel(net, currentPar);
            const isD   = i===dealerIdx;
            const base  = baseFinalBet(i);
            return (
              <div key={i} style={S.strokeRow}>
                <div style={{flex:1}}>
                  <div style={S.strokeName}>
                    {players[i]}{isD&&<span style={S.dealerChip}>DEALER</span>}
                    {!isD&&(bets[i]||0)===0&&<span style={S.sittingChip}>$0</span>}
                  </div>
                  <div style={{fontSize:11,color:"#6dbf7e",fontFamily:"monospace",marginTop:2}}>
                    {hs>0 ? `gross ${gross} − ${hs} hcap = net ${net}` : `gross ${gross} (scratch)`}
                  </div>
                  {lab&&(
                    <div style={{display:"flex",gap:5,alignItems:"center",marginTop:3}}>
                      <span style={{fontSize:12,color:lab.color}}>{lab.text}</span>
                      {lab.mult>1&&<span style={S.multBadge}>×{lab.mult}</span>}
                      {!isD&&base>0&&lab.mult>1&&(
                        <span style={{fontSize:11,color:"#6dbf7e",fontFamily:"monospace"}}>${base.toFixed(2)}→${(base*lab.mult).toFixed(2)}</span>
                      )}
                    </div>
                  )}
                </div>
                <div style={S.stepper}>
                  <button style={S.stepBtn} onClick={()=>adjustStroke(i,-1)}>−</button>
                  <span style={S.stepVal}>{gross}</span>
                  <button style={S.stepBtn} onClick={()=>adjustStroke(i,1)}>+</button>
                </div>
              </div>
            );
          })}

          {(()=>{
            const dNet  = netNow(dealerIdx);
            const dM    = pMult(dNet, currentPar);
            const ready = nonDealerIdxs.every(i=>currentStrokes[i]);
            if (!ready || !currentStrokes[dealerIdx]) return null;
            const lines = nonDealerIdxs.map(i=>{
              const pn=netNow(i), pm=pMult(pn,currentPar), base=baseFinalBet(i);
              if (base===0) return {c:"#6b7280",t:`${players[i]} — sitting out ($0)`};
              if (pn<dNet) { const amt=base*pm; return {c:"#4ade80",t:`${players[i]} wins $${amt.toFixed(2)}${pm>1?` (×${pm})`:""}` }; }
              if (pn>dNet) { const amt=base*pm*dM; return {c:"#f87171",t:`${players[dealerIdx]} takes $${amt.toFixed(2)} from ${players[i]}${pm*dM>1?` (×${pm*dM})`:""}`}; }
              return {c:"#fbbf24",t:`${players[i]} pushes`};
            });
            const winners=nonDealerIdxs.filter(i=>netNow(i)<dNet);
            const notice=winners.length===0?`🃏 ${players[dealerIdx]} stays dealer`
              :winners.length===1?`🃏 ${players[winners[0]]} becomes dealer`
              :`⚠️ Tied net — you'll pick the low scorer`;
            return (
              <div style={S.previewBox}>
                <p style={S.previewTitle}>Money Preview</p>
                {lines.map((l,i)=><div key={i} style={{...S.previewLine,color:l.c}}>{l.t}</div>)}
                <div style={{...S.previewLine,color:"#b2d8b9",marginTop:4}}>{notice}</div>
              </div>
            );
          })()}

          {strokeError&&<p style={S.err}>{strokeError}</p>}
          <button style={S.primaryBtn} onClick={submitStrokes}>Confirm & Next Hole →</button>
        </div>
      )}

      {/* PICK DEALER — tied net low score */}
      {phase==="pickDealer"&&(
        <div style={S.card}>
          <p style={S.phaseTitle}>🏆 Tied Net Low Score</p>
          <p style={S.phaseDesc}>Multiple players tied on net. Tap the one with the lowest gross score — they become dealer.</p>
          <div style={S.pickGrid}>
            {pendingWinners.map(i=>(
              <button key={i} style={S.pickBtn}
                onClick={()=>{ const {newCompleted}=pendingData; finalize(newCompleted,i); }}>
                <span style={{fontSize:18}}>🏅</span>
                <div>
                  <span style={{fontWeight:700,display:"block"}}>{players[i]}</span>
                  <span style={{fontSize:12,color:"#6dbf7e"}}>
                    gross {currentStrokes[i]} · net {netNow(i)}
                    {handicaps[i]>0&&` (HCP ${handicaps[i]})`}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const S = {
  root: { minHeight:"100svh",backgroundColor:"#0a1a0f",color:"#e8f5e9",fontFamily:"'Georgia',serif",paddingBottom:"max(48px, env(safe-area-inset-bottom))",maxWidth:520,margin:"0 auto" },
  header: { textAlign:"center",padding:"36px 24px 18px",background:"linear-gradient(180deg,#0d2d14 0%,#0a1a0f 100%)",borderBottom:"1px solid #1e4d2b" },
  chipIcon: { fontSize:36,marginBottom:6 },
  title: { margin:0,fontSize:40,letterSpacing:"0.25em",fontWeight:700,color:"#ffd700",textShadow:"0 0 20px rgba(255,215,0,0.4)" },
  subtitle: { margin:"4px 0 0",fontSize:12,letterSpacing:"0.15em",color:"#6dbf7e",textTransform:"uppercase" },
  card: { margin:"14px 14px 0",backgroundColor:"#0f2a18",border:"1px solid #1e4d2b",borderRadius:12,padding:"18px 16px" },
  cardHead: { display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12 },
  sLabel: { margin:"0 0 10px",fontSize:10,letterSpacing:"0.2em",color:"#6dbf7e",textTransform:"uppercase",fontFamily:"monospace" },
  ruleTitle: { margin:"0 0 8px",fontSize:10,letterSpacing:"0.15em",color:"#6dbf7e",textTransform:"uppercase" },
  rules: { margin:0,paddingLeft:16,fontSize:13,lineHeight:1.9,color:"#b2d8b9" },
  gold: { fontSize:12,color:"#ffd700",fontFamily:"monospace" },
  fieldIcon: { fontSize:16,flexShrink:0 },
  segOn:  { padding:"6px 14px",backgroundColor:"#1a3d25",border:"1px solid #ffd700",color:"#ffd700",borderRadius:6,fontSize:14,cursor:"pointer",fontWeight:700 },
  segOff: { padding:"6px 14px",backgroundColor:"#0a1a0f",border:"1px solid #2d6a3f",color:"#6dbf7e",borderRadius:6,fontSize:14,cursor:"pointer" },
  hcapNote: { fontSize:12,color:"#6dbf7e",lineHeight:1.6,marginBottom:14,backgroundColor:"#0a1a0f",border:"1px solid #1e4d2b",borderRadius:8,padding:"10px 12px" },
  hcapStepper: { display:"flex",alignItems:"center",border:"1px solid #2d6a3f",borderRadius:7,overflow:"hidden" },
  hcapBtn: { backgroundColor:"#0a1a0f",border:"none",color:"#ffd700",fontSize:16,fontWeight:700,padding:"10px 14px",cursor:"pointer",lineHeight:1,minHeight:44,minWidth:44,display:"flex",alignItems:"center",justifyContent:"center" },
  hcapVal: { fontSize:15,fontWeight:700,color:"#e8f5e9",minWidth:30,textAlign:"center",fontFamily:"monospace" },
  addBtn: { backgroundColor:"transparent",border:"1px solid #ffd700",color:"#ffd700",borderRadius:6,padding:"4px 10px",fontSize:12,fontWeight:700,cursor:"pointer" },
  row: { display:"flex",alignItems:"center",gap:8,marginBottom:10 },
  pNum: { fontSize:14,color:"#6dbf7e",width:22,textAlign:"center",flexShrink:0 },
  iLabel: { fontSize:13,color:"#b2d8b9",width:80,flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" },
  dlrSign: { color:"#ffd700",fontSize:16,fontWeight:700 },
  input: { backgroundColor:"#0a1a0f",border:"1px solid #2d6a3f",borderRadius:8,color:"#e8f5e9",fontSize:16,padding:"10px 12px",outline:"none",width:"100%",boxSizing:"border-box",WebkitAppearance:"none",appearance:"none" },
  rmBtn: { backgroundColor:"transparent",border:"1px solid #4d1e1e",color:"#f87171",borderRadius:6,padding:"4px 8px",fontSize:11,cursor:"pointer",flexShrink:0 },
  err: { color:"#f87171",fontSize:13,margin:"8px 0 4px" },
  primaryBtn: { display:"block",width:"100%",marginTop:16,padding:"16px",backgroundColor:"#ffd700",color:"#0a1a0f",border:"none",borderRadius:10,fontSize:16,fontWeight:700,cursor:"pointer",fontFamily:"'Georgia',serif",transition:"background 0.2s",touchAction:"manipulation",minHeight:52 },
  // Resume + history
  resumeCard: { margin:"14px 14px 0",backgroundColor:"#0d2a1a",border:"2px solid #ffd700",borderRadius:12,padding:"16px",display:"flex",alignItems:"flex-start",gap:12 },
  resumeIcon: { fontSize:24,flexShrink:0,marginTop:2 },
  resumeTitle: { fontSize:15,fontWeight:700,color:"#ffd700",marginBottom:3 },
  resumeMeta: { fontSize:12,color:"#6dbf7e",marginBottom:2 },
  resumePlayers: { fontSize:11,color:"#b2d8b9" },
  resumeBtn: { backgroundColor:"#ffd700",border:"none",color:"#0a1a0f",borderRadius:7,padding:"7px 14px",fontSize:13,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap" },
  discardBtn: { backgroundColor:"transparent",border:"1px solid #4d1e1e",color:"#f87171",borderRadius:7,padding:"6px 10px",fontSize:12,cursor:"pointer",whiteSpace:"nowrap" },
  histRow: { paddingBottom:12,marginBottom:12,paddingTop:4 },
  histCourse: { fontSize:14,fontWeight:700,color:"#e8f5e9",marginBottom:2 },
  histDate: { fontSize:11,color:"#6dbf7e",marginBottom:5 },
  histPlayers: { fontSize:12,color:"#b2d8b9" },
  earlyChip: { marginLeft:7,fontSize:10,color:"#fbbf24",backgroundColor:"#2a220a",border:"1px solid #fbbf24",borderRadius:4,padding:"1px 5px" },
  // Top bar
  topBar: { display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 14px",backgroundColor:"#0d2d14",borderBottom:"1px solid #1e4d2b" },
  topTitle: { fontSize:13,fontWeight:700,color:"#ffd700" },
  iconBtn: { backgroundColor:"transparent",border:"1px solid #2d6a3f",color:"#6dbf7e",borderRadius:6,padding:"11px 14px",fontSize:13,cursor:"pointer",position:"relative",minHeight:44,minWidth:44,display:"inline-flex",alignItems:"center",justifyContent:"center" },
  badge: { position:"absolute",top:-5,right:-5,backgroundColor:"#ffd700",color:"#0a1a0f",borderRadius:8,fontSize:9,fontWeight:700,padding:"1px 4px",minWidth:14,textAlign:"center" },
  holeChip: { backgroundColor:"#ffd700",color:"#0a1a0f",borderRadius:20,padding:"4px 12px",fontSize:13,fontWeight:700,letterSpacing:"0.1em",display:"inline-block" },
  dealerTag: { display:"flex",flexDirection:"column",alignItems:"center" },
  dlrLabel: { fontSize:9,letterSpacing:"0.2em",color:"#6dbf7e",textTransform:"uppercase" },
  dlrName: { fontSize:14,fontWeight:700,color:"#ffd700" },
  progressBar: { height:3,backgroundColor:"#1e4d2b" },
  progressFill: { height:"100%",backgroundColor:"#ffd700",transition:"width 0.4s ease" },
  miniBar: { display:"flex",justifyContent:"space-around",flexWrap:"wrap",padding:"7px 10px",backgroundColor:"#0d2d14",borderBottom:"1px solid #1e4d2b",gap:4 },
  miniBal: { display:"flex",flexDirection:"column",alignItems:"center",gap:1,minWidth:46 },
  miniName: { fontSize:8,color:"#6dbf7e",textTransform:"uppercase" },
  miniVal: { fontSize:11,fontWeight:700,fontFamily:"monospace" },
  phaseTitle: { margin:"0 0 6px",fontSize:16,fontWeight:700,color:"#ffd700" },
  phaseDesc: { margin:"0 0 14px",fontSize:13,color:"#b2d8b9",lineHeight:1.5 },
  dblRow: { display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:"1px solid #1e4d2b" },
  dblName: { fontSize:15,fontWeight:700,color:"#e8f5e9",display:"block" },
  dblOrig: { fontSize:12,color:"#6dbf7e",fontFamily:"monospace",display:"block",marginTop:2 },
  dblBtnOff: { backgroundColor:"transparent",border:"1px solid #ffd700",color:"#ffd700",borderRadius:8,padding:"8px 12px",fontSize:13,fontWeight:700,cursor:"pointer" },
  dblBtnOn:  { backgroundColor:"#ffd700",border:"1px solid #ffd700",color:"#0a1a0f",borderRadius:8,padding:"8px 12px",fontSize:13,fontWeight:700,cursor:"pointer" },
  strokeRow: { display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 0",borderBottom:"1px solid #1e4d2b" },
  strokeName: { fontSize:15,fontWeight:700,color:"#e8f5e9" },
  dealerChip: { fontSize:9,letterSpacing:"0.12em",color:"#ffd700",textTransform:"uppercase",backgroundColor:"#1a3d10",border:"1px solid #ffd700",borderRadius:4,padding:"1px 5px",marginLeft:6 },
  sittingChip: { fontSize:9,color:"#6dbf7e",backgroundColor:"#0a1a0f",border:"1px solid #2d6a3f",borderRadius:4,padding:"1px 5px",marginLeft:6 },
  multBadge: { backgroundColor:"#1a3d25",border:"1px solid #4ade80",color:"#4ade80",borderRadius:4,padding:"1px 6px",fontSize:11,fontWeight:700 },
  stepper: { display:"flex",alignItems:"center",border:"1px solid #2d6a3f",borderRadius:8,overflow:"hidden" },
  stepBtn: { backgroundColor:"#0a1a0f",border:"none",color:"#ffd700",fontSize:18,fontWeight:700,padding:"13px 18px",cursor:"pointer",lineHeight:1,minWidth:44,minHeight:44,display:"flex",alignItems:"center",justifyContent:"center" },
  stepVal: { fontSize:20,fontWeight:700,color:"#e8f5e9",minWidth:44,textAlign:"center",fontFamily:"monospace",lineHeight:"44px" },
  previewBox: { marginTop:14,backgroundColor:"#0a1a0f",borderRadius:8,padding:"10px 12px",border:"1px solid #1e4d2b" },
  previewTitle: { margin:"0 0 6px",fontSize:10,letterSpacing:"0.15em",color:"#6dbf7e",textTransform:"uppercase" },
  previewLine: { fontSize:12,fontFamily:"monospace",marginBottom:3 },
  pickGrid: { display:"flex",flexDirection:"column",gap:10,marginTop:4 },
  pickBtn: { display:"flex",alignItems:"center",gap:12,padding:"14px 16px",backgroundColor:"#0a1a0f",border:"2px solid #ffd700",color:"#e8f5e9",borderRadius:10,cursor:"pointer" },
  parGrid:   { display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8 },
  parCell:   { backgroundColor:"#0a1a0f",border:"1px solid #1e4d2b",borderRadius:8,padding:"8px 6px",textAlign:"center" },
  parNum:    { display:"block",fontSize:11,color:"#6dbf7e",marginBottom:5,fontFamily:"monospace" },
  parBtnRow: { display:"flex",gap:3,justifyContent:"center" },
  parBtnOn:  { padding:"6px 8px",backgroundColor:"#1a3d25",border:"1px solid #ffd700",color:"#ffd700",borderRadius:4,fontSize:13,cursor:"pointer",fontWeight:700,minWidth:36,minHeight:36 },
  parBtnOff: { padding:"6px 8px",backgroundColor:"#0f2a18",border:"1px solid #2d6a3f",color:"#6dbf7e",borderRadius:4,fontSize:13,cursor:"pointer",minWidth:36,minHeight:36 },
  // Course search
  searchCourseBtn: { backgroundColor:"#1a3d25",border:"1px solid #ffd700",color:"#ffd700",borderRadius:7,padding:"5px 12px",fontSize:12,fontWeight:700,cursor:"pointer" },
  loadedBadge: { display:"flex",alignItems:"flex-start",gap:10,backgroundColor:"#0a2a12",border:"1px solid #4ade80",borderRadius:8,padding:"10px 12px",marginBottom:12 },
  clearCourseBtn: { backgroundColor:"transparent",border:"none",color:"#6dbf7e",fontSize:16,cursor:"pointer",flexShrink:0,padding:"0 2px" },
  courseResultBtn: { display:"flex",alignItems:"center",justifyContent:"space-between",width:"100%",backgroundColor:"#0a1a0f",border:"1px solid #1e4d2b",borderRadius:8,padding:"12px 14px",marginBottom:8,cursor:"pointer",textAlign:"left" },
  courseResultName: { fontSize:14,fontWeight:700,color:"#e8f5e9",marginBottom:2 },
  courseResultLoc: { fontSize:11,color:"#6dbf7e",marginTop:3 },
  teeCard: { display:"flex",alignItems:"center",gap:10,backgroundColor:"#0a1a0f",border:"1px solid #2d6a3f",borderRadius:8,padding:"12px 14px",marginBottom:8 },
  applyTeeBtn: { backgroundColor:"#ffd700",border:"none",color:"#0a1a0f",borderRadius:7,padding:"8px 14px",fontSize:14,fontWeight:700,cursor:"pointer",flexShrink:0 },
  noticeBanner: { backgroundColor:"#1a3d10",border:"1px solid #4ade80",padding:"10px 14px",fontSize:13,color:"#b2d8b9" },
  editBtn: { backgroundColor:"transparent",border:"1px solid #2d6a3f",color:"#6dbf7e",borderRadius:6,padding:"4px 8px",fontSize:14,cursor:"pointer" },
  tbl: { width:"100%",borderCollapse:"collapse",fontSize:13,minWidth:260 },
  th:  { padding:"6px 8px",textAlign:"center",color:"#6dbf7e",fontSize:10,letterSpacing:"0.1em",textTransform:"uppercase",borderBottom:"1px solid #1e4d2b",whiteSpace:"nowrap" },
  td:  { padding:"6px 8px",textAlign:"center",verticalAlign:"middle",borderBottom:"1px solid #1e4d2b" },
  standRow: { display:"flex",alignItems:"center",padding:"10px 0",borderBottom:"1px solid #1e4d2b",gap:10 },
  standRank: { fontSize:18,fontWeight:700,color:"#ffd700",width:22,textAlign:"center" },
  standName: { flex:1,fontSize:16,fontWeight:700 },
  standBal: { fontSize:17,fontWeight:700,fontFamily:"monospace" },
  settleRow: { display:"flex",alignItems:"center",padding:"10px 0",borderBottom:"1px solid #1e4d2b",gap:8 },
  settleName: { flex:1,fontSize:14,color:"#e8f5e9" },
  settleArrow: { color:"#f87171",fontSize:16,flexShrink:0 },
  settleAmt: { fontSize:16,fontWeight:700,color:"#f87171",fontFamily:"monospace",flexShrink:0 },
  holeLogRow: { padding:"8px 0",borderBottom:"1px solid #1e4d2b" },
  holeLogHead: { display:"flex",gap:8,marginBottom:4,alignItems:"center",flexWrap:"wrap" },
  holeLogNum: { fontSize:12,fontWeight:700,color:"#ffd700",fontFamily:"monospace" },
  holeLogD: { fontSize:11,color:"#6dbf7e" },
  holeLogBadge: { fontSize:11,marginLeft:"auto" },
  holeLogSwing: { fontSize:12,fontFamily:"monospace",paddingLeft:8,marginBottom:2 },
};
