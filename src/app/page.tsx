'use client';

// Linea Multi-Claim Web App — client-side only (enhanced UI + per-wallet stats + manual ops + stop/reset + export CSV)
// - Keys stay in the browser
// - Optional custom RPC (defaults to Linea public RPC)
// - Auto-claims at the official window open (UTC)
// - Per-wallet live phase badges (Checking, Claiming, Token, Sending, Retrying, Gas Insufficient, RPC Error, etc.)
// - Overall progress with gradient bar and counts
// - Pause / Resume run, Stop, Reset
// - Adjustable concurrency (parallel workers) + RPC interval (rate-limit)
// - Multiple CEX deposit addresses (round-robin)
// - Global aggregates (claimed & sent) + per-wallet counts and token symbol
// - Export logs as CSV
// - Manual Claim / Manual Deposit (independent of concurrency/pause)

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  getContract,
  http,
  defineChain,
  formatUnits
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import Image from "next/image";
import type { Abi, Address } from "viem";

// viem client tipleri (istersen kullanabilirsin)
type Public = ReturnType<typeof createPublicClient>;
type Wallet = ReturnType<typeof createWalletClient>;

// Sadece kullandığımız read fonksiyonlarını içeren minimal arayüzler
type AirdropContract = {
  read: {
    TOKEN: () => Promise<Address>;
    hasClaimed: (args: [Address]) => Promise<boolean>;
  };
};

type ERC20Token = {
  read: {
    decimals: () => Promise<number>;
    symbol: () => Promise<string>;
    balanceOf: (args: [Address]) => Promise<bigint>;
  };
};

// ===== CONFIG (adjust if needed) =====
const AIRDROP_ADDRESS = "0x87bAa1694381aE3eCaE2660d97fe60404080Eb64"; // Official Linea airdrop
const DEFAULT_RPC = "https://rpc.linea.build";
const CLAIM_WINDOW_START_UTC = Date.parse("2025-09-10T15:00:00Z");
const CLAIM_WINDOW_END_UTC   = Date.parse("2025-12-09T23:59:59Z");

// Minimal ERC-20 ABI
const ERC20_ABI = [
  { type: 'function', stateMutability:'view', name:'decimals', inputs:[], outputs:[{type:'uint8',name:''}] },
  { type: 'function', stateMutability:'view', name:'symbol',   inputs:[], outputs:[{type:'string',name:''}] },
  { type: 'function', stateMutability:'view', name:'balanceOf',inputs:[{type:'address',name:'a'}], outputs:[{type:'uint256',name:''}] },
  { type: 'function', stateMutability:'nonpayable', name:'transfer', inputs:[{type:'address',name:'to'},{type:'uint256',name:'amount'}], outputs:[{type:'bool',name:''}] },
];

// Airdrop ABI (truncated ok if functions covered)
const AIRDROP_ABI = [{"inputs":[{"internalType":"address","name":"_token","type":"address"},{"internalType":"address","name":"_ownerAddress","type":"address"},{"internalType":"uint256","name":"_claimEnd","type":"uint256"},{"internalType":"address","name":"_primaryFactorAddress","type":"address"},{"internalType":"address","name":"_primaryConditionalMultiplierAddress","type":"address"},{"internalType":"address","name":"_secondaryFactorAddress","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},{"inputs":[],"name":"AlreadyClaimed","type":"error"},{"inputs":[],"name":"ClaimAmountIsZero","type":"error"},{"inputs":[],"name":"ClaimFinished","type":"error"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"user","type":"address"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"}],"name":"Claimed","type":"event"},{"inputs":[],"name":"TOKEN","outputs":[{"internalType":"contract IERC20","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"user","type":"address"}],"name":"hasClaimed","outputs":[{"internalType":"bool","name":"claimed","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"claim","outputs":[],"stateMutability":"nonpayable","type":"function"}];

// Linea chain (explicit)
const linea = defineChain({
  id: 59144,
  name: 'Linea',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT_RPC] } },
});

// ===== UI helpers =====
const nowUtc = () => Date.now();
const sleep = (ms:number) => new Promise(r=>setTimeout(r, ms));
const msToHMS = (ms:number) => {
  const s=Math.max(0,Math.floor(ms/1000));
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
  return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${sec.toString().padStart(2,'0')}`;
};
const shortAddr = (a:string) => a ? `${a.slice(0,6)}…${a.slice(-4)}` : '';
const splitList = (raw:string) => (raw||'').split(/[\n,;\s]+/).map(s=>s.trim()).filter(Boolean);

const PHASE_TO_BADGE = {
  idle:    "bg-blue-950/30 text-blue-200 border-blue-900",
  checking:"bg-blue-950/30 text-blue-200 border-blue-900",
  claiming:"bg-violet-950/30 text-violet-200 border-violet-900",
  token:   "bg-cyan-950/30 text-cyan-200 border-cyan-900",
  sending: "bg-emerald-950/30 text-emerald-200 border-emerald-900",
  retry:   "bg-amber-950/30 text-amber-200 border-amber-900",
  gas:     "bg-yellow-950/30 text-yellow-200 border-yellow-900",
  rpc:     "bg-orange-950/30 text-orange-200 border-orange-900",
  noalloc: "bg-slate-950/30 text-slate-200 border-slate-900",
  closed:  "bg-slate-950/30 text-slate-200 border-slate-900",
  done:    "bg-emerald-950/30 text-emerald-200 border-emerald-900",
  fail:    "bg-rose-950/30 text-rose-200 border-rose-900",
};

const Badge: React.FC<{children:React.ReactNode; phase:keyof typeof PHASE_TO_BADGE}> = ({children, phase}) => (
  <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${PHASE_TO_BADGE[phase] || PHASE_TO_BADGE.idle}`}>{children}</span>
);

const IconDone  = () => (<span className="text-emerald-500">✓</span>);
const IconRetry = () => (<span className="text-amber-500">⟳</span>);
const IconFail  = () => (<span className="text-rose-500">✗</span>);

// ===== Types =====
type Row = {
  pk: string;
  address: string;
  dest: string;                // matched CEX deposit
  phase: keyof typeof PHASE_TO_BADGE;
  status: "idle"|"checking"|"claiming"|"post"|"sending"|"retry"|"rpc"|"done"|"fail";
  note: string;
  txs: string[];
  history: string[];
  // stats
  tokenAddr?: `0x${string}`;
  tokenSymbol?: string;
  tokenDecimals?: number;
  beforeBal?: bigint;          // read before claim
  afterBal?: bigint;           // read after claim
  claimedAmount?: bigint;      // computed delta
  sentAmount?: bigint;         // sum of successful sends
  claimTries: number;          // number of claim attempts
  sendTries: number;           // number of send attempts
  lastError?: string;
};

type GlobalStats = {
  tokenSymbol?: string;
  tokenDecimals?: number;
  totalClaimed: bigint;        // sum of claimedAmount
  totalSent: bigint;           // sum of sentAmount
};

// ===== Component =====
export default function App() {
  // Inputs
  const [rpcUrl, setRpcUrl] = useState<string>(typeof window!=="undefined" ? (localStorage.getItem('rpcUrl') || '') : '');
  const [depositRaw, setDepositRaw] = useState<string>(typeof window!=="undefined" ? (localStorage.getItem('depositRaw') || '') : '');
  const [privateKeysRaw, setPrivateKeysRaw] = useState<string>(typeof window!=="undefined" ? (localStorage.getItem('privateKeysRaw') || '') : '');
  const [concurrency, setConcurrency] = useState<number>(typeof window!=="undefined" ? Number(localStorage.getItem('concurrency') || '3') : 3);
  const [rpcIntervalMs, setRpcIntervalMs] = useState<number>(typeof window!=="undefined" ? Number(localStorage.getItem('rpcIntervalMs') || '250') : 250);

  // Runtime
  const [rows, setRows] = useState<Row[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [countdown, setCountdown] = useState(Math.max(0, CLAIM_WINDOW_START_UTC - nowUtc()));
  const [stopped, setStopped] = useState(false); // for Stop
  const stopRef = useRef(false);
  stopRef.current = stopped;

  // Global totals
  const [g, setG] = useState<GlobalStats>({ totalClaimed: 0n, totalSent: 0n });

  const effectiveRpc = (rpcUrl?.trim() || DEFAULT_RPC);

  // Persist inputs
  useEffect(()=>{ const t=setInterval(()=> setCountdown(Math.max(0, CLAIM_WINDOW_START_UTC - nowUtc())),1000); return ()=>clearInterval(t); },[]);
  useEffect(()=> localStorage.setItem('rpcUrl', rpcUrl), [rpcUrl]);
  useEffect(()=> localStorage.setItem('depositRaw', depositRaw), [depositRaw]);
  useEffect(()=> localStorage.setItem('privateKeysRaw', privateKeysRaw), [privateKeysRaw]);
  useEffect(()=> localStorage.setItem('concurrency', String(concurrency)), [concurrency]);
  useEffect(()=> localStorage.setItem('rpcIntervalMs', String(rpcIntervalMs)), [rpcIntervalMs]);

  // Parse inputs
  const parsed = useMemo(() => {
    const pkStrings = splitList(privateKeysRaw);
    const wallets = pkStrings.map((raw) => {
      const normalized = raw.startsWith('0x') ? raw : ('0x' + raw);
      if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) return null;
      try {
        const acc = privateKeyToAccount(normalized as `0x${string}`);
        return { pk: normalized, address: acc.address };
      } catch { return null; }
    }).filter(Boolean) as {pk:string,address:string}[];

    const deposits = splitList(depositRaw).filter(s=>/^0x[0-9a-fA-F]{40}$/.test(s));

    return { wallets, deposits };
  }, [privateKeysRaw, depositRaw]);

  // Build rows with round-robin deposit assignment
  useEffect(()=>{
    const ds = parsed.deposits.length ? parsed.deposits : [];
    const list: Row[] = parsed.wallets.map((w, i) => ({
      pk: w.pk,
      address: w.address,
      dest: ds.length ? ds[i % ds.length] : '',
      phase: 'idle',
      status: 'idle',
      note: '',
      txs: [],
      history: [],
      claimTries: 0,
      sendTries: 0,
      sentAmount: 0n,
      claimedAmount: 0n,
    }));
    setRows(list);
    // reset globals on input change
    setG({ tokenSymbol: undefined, tokenDecimals: undefined, totalClaimed: 0n, totalSent: 0n });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed.wallets.length, parsed.deposits.join(',')]);

  // Helpers to mutate a row
  const setPhase = (addr:string, phase:Row['phase'], status?:Row['status'], note?:string, patch?:Partial<Row>) => {
    setRows(prev => prev.map(r => r.address===addr ? ({
      ...r,
      ...patch,
      phase,
      status: status ?? r.status,
      note: note ?? r.note,
      history: phase ? [...r.history, `${new Date().toISOString()} :: ${phase}`] : r.history,
    }) : r));
  };
  const markTx = (addr:string, hash:string) =>
    setRows(prev => prev.map(r => r.address===addr ? ({...r, txs:[...r.txs, hash]}) : r));

  // Classify errors
  function classifyError(e:any): {phase:Row['phase']; message:string} {
    const msg = (e?.shortMessage || e?.message || String(e) || '').toLowerCase();
    if (msg.includes('insufficient funds') || msg.includes('insufficient balance')) return { phase:'gas', message:'Insufficient gas (ETH on Linea)' };
    if (msg.includes('nonce too low') || msg.includes('replacement')) return { phase:'retry', message:'Nonce/replacement issue — retrying' };
    if (msg.includes('429') || msg.includes('rate') || msg.includes('limit') || msg.includes('timeout') || msg.includes('fetch failed') || msg.includes('network error')) return { phase:'rpc', message:'RPC error' };
    if (msg.includes('claimfinished')) return { phase:'closed', message:'Claim window closed' };
    if (msg.includes('claimamountiszero')) return { phase:'noalloc', message:'No allocation for this wallet' };
    if (msg.includes('alreadyclaimed')) return { phase:'done', message:'Already claimed' };
    return { phase:'fail', message: e?.shortMessage || e?.message || 'Unknown error' };
  }

  // Central rate-limited call wrapper
  const rateGate = async () => { if (rpcIntervalMs > 0) await sleep(rpcIntervalMs); };

  // Per-wallet operations (can be used by workers or manual buttons)
  async function readTokenAndBalances(publicClient:any, walletClient:any, accountAddr:`0x${string}`, row:Row) {
    await rateGate();
    const airdrop = getContract({
      address: AIRDROP_ADDRESS as Address,
      abi: AIRDROP_ABI as Abi,
      client: { public: publicClient, wallet: walletClient },
    }) as unknown as AirdropContract;
    
    const tokenAddr = await airdrop.read.TOKEN();
    
    const token = getContract({
      address: tokenAddr as Address,
      abi: ERC20_ABI as Abi,
      client: { public: publicClient, wallet: walletClient },
    }) as unknown as ERC20Token;

    await rateGate();
    const [decimals, symbol] = await Promise.all([
      token.read.decimals(),
      token.read.symbol().catch(()=> 'TOKEN'),
    ]);

    await rateGate();
    const beforeBal = await token.read.balanceOf([accountAddr]);

    setPhase(row.address, 'token', 'post', `Token: ${symbol} (decimals ${decimals})`, {
      tokenAddr, tokenSymbol: String(symbol), tokenDecimals: Number(decimals), beforeBal
    });

    return { tokenAddr, decimals, symbol: String(symbol), beforeBal, token };
  }

  async function attemptClaim(row:Row, publicClient:any, walletClient:any, accountAddr:`0x${string}`) {
    const airdrop = getContract({
      address: AIRDROP_ADDRESS as Address,
      abi: AIRDROP_ABI as Abi,
      client: { public: publicClient, wallet: walletClient },
    }) as unknown as AirdropContract;
    // quick check
    try {
      setPhase(row.address, 'checking', 'checking', 'Checking claim status…');
      await rateGate();
      const already = await airdrop.read.hasClaimed([accountAddr as Address]);
      if (already) { setPhase(row.address, 'done', 'done', 'Already claimed'); return { already: true }; }
    } catch (e:any) {
      const { phase, message } = classifyError(e);
      setPhase(row.address, phase, phase==='fail'?'fail':'retry', `hasClaimed: ${message}`);
      if (phase==='rpc' || phase==='retry') throw e;
      return { already: false, error: message };
    }

    // claim with backoff (higher attempts)
    for (let attempt=1; attempt<=7; attempt++) {
      if (stopRef.current) throw new Error('Stopped');
      try {
        setRows(prev => prev.map(r => r.address===row.address ? ({...r, claimTries: r.claimTries+1}) : r));
        setPhase(row.address, 'claiming', 'claiming', `claim() attempt ${attempt}…`);
        await rateGate();
        const hash = await walletClient.writeContract({ address: AIRDROP_ADDRESS, abi: AIRDROP_ABI, functionName: 'claim', args: [] });
        await publicClient.waitForTransactionReceipt({ hash });
        markTx(row.address, hash);
        return { already:false, hash };
      } catch (e:any) {
        const { phase, message } = classifyError(e);
        if (['done','closed','noalloc'].includes(phase)) { setPhase(row.address, phase, phase==='done'?'done':'fail', message); return { already:false, error: message }; }
        if (attempt===7) { setPhase(row.address, 'fail', 'fail', `claim failed: ${message}`); return { already:false, error: message }; }
        setPhase(row.address, phase==='rpc'?'rpc':'retry', 'retry', `claim: ${message} — retrying…`);
        await sleep(1000 * Math.pow(2, attempt)); // exponential backoff
      }
    }
    return { already:false, error:'unreachable' };
  }

  async function sendAll(row:Row, publicClient:any, walletClient:any, token:any, tokenAddr:`0x${string}`, decimals:number, symbol:string, dest:string) {
    if (!dest) { setPhase(row.address, 'fail', 'fail', 'No CEX deposit address'); return; }

    await rateGate();
    const bal: bigint = await token.read.balanceOf([walletClient.account!.address as `0x${string}`]);
    if (bal === 0n) { setPhase(row.address, 'done', 'done', 'Balance 0 after claim'); return; }

    for (let attempt=1; attempt<=6; attempt++) {
      if (stopRef.current) throw new Error('Stopped');
      try {
        setRows(prev => prev.map(r => r.address===row.address ? ({...r, sendTries: r.sendTries+1}) : r));
        setPhase(row.address, 'sending', 'sending', `Sending ${formatUnits(bal, decimals)} ${symbol} → ${shortAddr(dest)} (try ${attempt})`);
        await rateGate();
        const h = await walletClient.writeContract({ address: tokenAddr, abi: ERC20_ABI, functionName: 'transfer', args: [dest, bal] });
        await publicClient.waitForTransactionReceipt({ hash: h });
        markTx(row.address, h);
        setRows(prev => prev.map(r => r.address===row.address ? ({...r, sentAmount: (r.sentAmount ?? 0n) + bal }) : r));
        setPhase(row.address, 'done', 'done', 'Transfer complete ✅');
        return;
      } catch (e:any) {
        const { phase, message } = classifyError(e);
        if (attempt===6) { setPhase(row.address, phase==='gas'?'gas':'fail', 'fail', `transfer: ${message}`, { lastError: message }); return; }
        setPhase(row.address, phase==='rpc'?'rpc':'retry', 'retry', `transfer: ${message} — retrying…`, { lastError: message });
        await sleep(1000 * Math.pow(2, attempt));
      }
    }
  }

  async function processWallet(row:Row, publicClient:any, dest:string) {
    const account = privateKeyToAccount(row.pk as `0x${string}`);
    const walletClient = createWalletClient({ account, chain: linea, transport: http(effectiveRpc) });

    // Read token and BEFORE balance (safe to call even pre-claim)
    let tokenAddr: `0x${string}` | undefined;
    let token: any;
    let decimals = 18;
    let symbol = 'TOKEN';

    try {
      const info = await readTokenAndBalances(publicClient, walletClient, account.address, row);
      tokenAddr = info.tokenAddr;
      token = info.token;
      decimals = Number(info.decimals);
      symbol = info.symbol;
      setG(prev => ({ ...prev, tokenSymbol: symbol, tokenDecimals: decimals }));
    } catch (e:any) {
      const { phase, message } = classifyError(e);
      setPhase(row.address, phase==='rpc'?'rpc':'fail', 'fail', `token pre-read: ${message}`, { lastError: message });
      if (phase==='rpc') throw e;
      return;
    }

    // Claim
    const claimRes = await attemptClaim(row, publicClient, walletClient, account.address);
    if (claimRes.error && !/already claimed/i.test(claimRes.error)) return;

    // AFTER balance (to compute claimed delta)
    try {
      await rateGate();
      const afterBal: bigint = await token.read.balanceOf([account.address]);
      setRows(prev => prev.map(r => r.address===row.address ? ({...r, afterBal, claimedAmount: (afterBal - (r.beforeBal ?? 0n) < 0n ? 0n : afterBal - (r.beforeBal ?? 0n)) }) : r));
      const delta = (afterBal - (row.beforeBal ?? 0n)) < 0n ? 0n : (afterBal - (row.beforeBal ?? 0n));
      if (delta > 0n) setG(prev => ({ ...prev, tokenSymbol: symbol, tokenDecimals: decimals, totalClaimed: prev.totalClaimed + delta }));
    } catch (e:any) {
      const { phase, message } = classifyError(e);
      setPhase(row.address, phase==='rpc'?'rpc':'fail', 'fail', `post-claim read: ${message}`, { lastError: message });
      if (phase==='rpc') throw e;
      return;
    }

    // Send all to CEX
    await sendAll(row, publicClient, walletClient, token, tokenAddr!, decimals, symbol, dest);
    // Update global totalSent
    setG(prev => {
      const rowNow = rows.find(r => r.address === row.address);
      const add = rowNow?.sentAmount ?? 0n;
      return { ...prev, tokenSymbol: symbol, tokenDecimals: decimals, totalSent: prev.totalSent + add };
    });
  }

  // Start run with worker pool
  async function startRun() {
    if (!parsed.deposits.length) { alert('Enter at least one CEX deposit address (0x...).'); return; }
    if (!parsed.wallets.length) { alert('Enter at least one valid private key (0x + 64 hex).'); return; }

    setIsRunning(true);
    setIsPaused(false);
    setStopped(false);
    const publicClient = createPublicClient({ chain: linea, transport: http(effectiveRpc) });

    // Wait until official start
    while (nowUtc() < CLAIM_WINDOW_START_UTC && !stopRef.current) { await sleep(500); }
    if (stopRef.current) { setIsRunning(false); return; }
    if (nowUtc() > CLAIM_WINDOW_END_UTC) { alert('Claim window appears closed.'); setIsRunning(false); return; }

    let index = 0;
    const maxWorkers = Math.max(1, Math.min(20, Number(concurrency)||1));
    const snapshotRows = () => rows; // closure reads state, fine for simple queue
    const nextTask = () => {
      const rs = snapshotRows();
      while (index < rs.length) {
        const r = rs[index++];
        // skip completed/failed
        if (!r) break;
        if (['done'].includes(r.status)) continue;
        return r;
      }
      return null;
    };

    const worker = async () => {
      const pc = publicClient;
      while (!stopRef.current) {
        while (isPaused && !stopRef.current) { await sleep(250); }
        if (stopRef.current) break;
        const task = nextTask();
        if (!task) break;
        const dest = task.dest || parsed.deposits[(index-1) % parsed.deposits.length];
        try { await processWallet(task, pc, dest); }
        catch { /* handled inside with retry phases */ }
      }
    };

    await Promise.all(Array.from({length: maxWorkers}, worker));
    setIsRunning(false);
  }

  // Pause / Resume
  function togglePause(){ setIsPaused(p=>!p); }

  // Stop (hard stop workers; keep statuses)
  function stopAll() { setStopped(true); setIsRunning(false); setIsPaused(false); }

  // Reset (clear queue statuses, keep inputs)
  function resetQueue() {
    setStopped(false);
    setIsRunning(false);
    setIsPaused(false);
    setRows(prev => prev.map(r => ({
      ...r,
      phase:'idle', status:'idle', note:'',
      txs:[], history:[],
      claimTries:0, sendTries:0, lastError: undefined,
      beforeBal: undefined, afterBal: undefined,
      claimedAmount: 0n, sentAmount: 0n,
    })));
    setG({ tokenSymbol: g.tokenSymbol, tokenDecimals: g.tokenDecimals, totalClaimed: 0n, totalSent: 0n });
  }

  // Manual operations (independent of concurrency/pause)
  async function manualClaim(addr:string) {
    const row = rows.find(r=>r.address===addr);
    if (!row) return;
    const account = privateKeyToAccount(row.pk as `0x${string}`);
    const publicClient = createPublicClient({ chain: linea, transport: http(effectiveRpc) });
    const walletClient = createWalletClient({ account, chain: linea, transport: http(effectiveRpc) });

    try {
      // ensure token info & before balance
      let tokenAddr = row.tokenAddr as `0x${string}` | undefined;
      let token:any = undefined;
      let decimals = row.tokenDecimals ?? 18;
      let symbol = row.tokenSymbol ?? 'TOKEN';
      if (!tokenAddr) {
        const info = await readTokenAndBalances(publicClient, walletClient, account.address, row);
        tokenAddr = info.tokenAddr;
        token = info.token;
        decimals = Number(info.decimals);
        symbol = info.symbol;
        setG(prev => ({ ...prev, tokenSymbol: symbol, tokenDecimals: decimals }));
      } else {
        token = getContract({
          address: tokenAddr as Address,
          abi: ERC20_ABI as Abi,
          client: { public: publicClient, wallet: walletClient },
        }) as unknown as ERC20Token;      }

      const res = await attemptClaim(row, publicClient, walletClient, account.address);
      if (res.error && !/already claimed/i.test(res.error)) return;

      await rateGate();
      const afterBal: bigint = await token.read.balanceOf([account.address]);
      const beforeBal = rows.find(r=>r.address===addr)?.beforeBal ?? 0n;
      const delta = afterBal - beforeBal > 0n ? (afterBal - beforeBal) : 0n;
      setRows(prev => prev.map(r => r.address===addr ? ({...r, afterBal, claimedAmount: delta }) : r));
      if (delta > 0n) setG(prev => ({ ...prev, totalClaimed: prev.totalClaimed + delta }));
    } catch (e:any) {
      const { phase, message } = classifyError(e);
      setPhase(addr, phase==='rpc'?'rpc':'fail', 'fail', `manual claim: ${message}`, { lastError: message });
    }
  }

  async function manualDeposit(addr:string) {
    const row = rows.find(r=>r.address===addr);
    if (!row) return;
    const dest = row.dest;
    const account = privateKeyToAccount(row.pk as `0x${string}`);
    const publicClient = createPublicClient({ chain: linea, transport: http(effectiveRpc) });
    const walletClient = createWalletClient({ account, chain: linea, transport: http(effectiveRpc) });

    try {
      // ensure token info ready
      let tokenAddr = row.tokenAddr as `0x${string}` | undefined;
      let token:any = undefined;
      let decimals = row.tokenDecimals ?? 18;
      let symbol = row.tokenSymbol ?? 'TOKEN';

      if (!tokenAddr) {
        const info = await readTokenAndBalances(publicClient, walletClient, account.address, row);
        tokenAddr = info.tokenAddr;
        token = info.token;
        decimals = Number(info.decimals);
        symbol = info.symbol;
        setG(prev => ({ ...prev, tokenSymbol: symbol, tokenDecimals: decimals }));
      } else {
        token = getContract({
          address: tokenAddr as Address,
          abi: ERC20_ABI as Abi,
          client: { public: publicClient, wallet: walletClient },
        }) as unknown as ERC20Token;      }

      await sendAll(row, publicClient, walletClient, token, tokenAddr!, decimals, symbol, dest);
      // global sent update
      const freshRow = rows.find(r=>r.address===addr);
      const add = freshRow?.sentAmount ?? 0n;
      setG(prev => ({ ...prev, totalSent: prev.totalSent + add }));
    } catch (e:any) {
      const { phase, message } = classifyError(e);
      setPhase(addr, phase==='rpc'?'rpc':'fail', 'fail', `manual deposit: ${message}`, { lastError: message });
    }
  }

  // Wallet-level retry buttons
  const retryClaim = (addr:string) => manualClaim(addr);
  const retryDeposit = (addr:string) => manualDeposit(addr);

  // Export CSV
  function exportCSV() {
    const headers = [
      "address","dest","phase","status","note",
      "tokenSymbol","tokenDecimals","beforeBal","afterBal","claimedAmount","sentAmount",
      "claimTries","sendTries","txs","history","lastError"
    ];
    const lines = [headers.join(",")];

    for (const r of rows) {
      const row = [
        r.address,
        r.dest,
        r.phase,
        r.status,
        JSON.stringify(r.note||""),
        r.tokenSymbol||"",
        r.tokenDecimals?.toString()||"",
        (r.beforeBal??0n).toString(),
        (r.afterBal??0n).toString(),
        (r.claimedAmount??0n).toString(),
        (r.sentAmount??0n).toString(),
        r.claimTries.toString(),
        r.sendTries.toString(),
        JSON.stringify(r.txs||[]),
        JSON.stringify(r.history||[]),
        JSON.stringify(r.lastError||""),
      ];
      lines.push(row.map(x=>String(x)).join(","));
    }

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `linea-multi-claim-logs-${new Date().toISOString()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // UI helpers
  function statusIcon(s:string){
    if(s==='done') return <IconDone/>;
    if(['retry','claiming','sending','checking','post','rpc'].includes(s)) return <IconRetry/>;
    if(s==='fail' || s==='gas') return <IconFail/>;
    return <span>•</span>;
  }
  const completed = rows.filter(r=>r.status==='done').length;
  const processing = rows.filter(r=>['retry','claiming','sending','checking','post','rpc'].includes(r.status)).length;
  const failed = rows.filter(r=>r.status==='fail').length;

  const fmt = (x:bigint) => {
    if (!g.tokenDecimals) return x.toString();
    try { return formatUnits(x, g.tokenDecimals); } catch { return x.toString(); }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-950 via-slate-950 to-blue-950 text-neutral-100 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <header className="flex items-center justify-between bg-blue-950/60 border border-blue-900 rounded-2xl px-4 py-3 backdrop-blur shadow-xl">
          <h1 className="text-xl md:text-2xl font-bold tracking-tight flex items-center gap-2">
            <Image src="/stealthypepe-logo.png" alt="logo" width={28} height={28} className="rounded" />
            LINEA Multi-Claim Dashboard
          </h1>
          <div className="flex items-center gap-2">
            {/* X / Twitter link with logo */}
            <a
              href="https://x.com/StealthyPepe"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-blue-200 hover:text-white"
              title="@StealthyPepe on X"
            >
              {/* X logo (SVG) */}
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M18.244 2H21l-6.54 7.47L22 22h-6.98l-4.55-5.95L4.98 22H2l6.99-7.98L2 2h7.02l4.22 5.6L18.244 2zm-1.22 18h1.93L8.09 4H6.16l10.865 16z"/>
              </svg>
              <span className="text-sm font-medium">@StealthyPepe</span>
            </a>
  
            <button onClick={exportCSV} className="text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-xl px-3 py-1.5">
              Export CSV
            </button>
            {!isRunning ? (
              <button onClick={startRun} className="text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl px-3 py-1.5">
                Start
              </button>
            ) : (
              <>
                <button onClick={togglePause} className="text-sm bg-amber-500 hover:bg-amber-400 text-white rounded-xl px-3 py-1.5">
                  {isPaused ? 'Resume' : 'Pause'}
                </button>
                <button onClick={stopAll} className="text-sm bg-rose-500 hover:bg-rose-400 text-white rounded-xl px-3 py-1.5">
                  Stop
                </button>
              </>
            )}
            <button onClick={resetQueue} className="text-sm bg-blue-950/40 hover:bg-blue-900/50 text-blue-100 border border-blue-900 rounded-xl px-3 py-1.5">
              Reset
            </button>
          </div>
        </header>
  
        {/* Global aggregates */}
        <div className="grid md:grid-cols-3 gap-4">
          <div className="bg-[#0f1a2b]/80 border border-blue-900 rounded-2xl p-4 shadow-lg">
            <div className="text-xs uppercase text-blue-200/70">Token Name</div>
            <div className="text-lg font-semibold">{g.tokenSymbol ?? '—'}</div>
          </div>
          <div className="bg-[#0f1a2b]/80 border border-blue-900 rounded-2xl p-4 shadow-lg">
            <div className="text-xs uppercase text-blue-200/70">Claimed (global)</div>
            <div className="text-lg font-semibold">
              {g.tokenSymbol ? `${fmt(g.totalClaimed)} ${g.tokenSymbol}` : '—'}
            </div>
          </div>
          <div className="bg-[#0f1a2b]/80 border border-blue-900 rounded-2xl p-4 shadow-lg">
            <div className="text-xs uppercase text-blue-200/70">Sent to CEX (global)</div>
            <div className="text-lg font-semibold">
              {g.tokenSymbol ? `${fmt(g.totalSent)} ${g.tokenSymbol}` : '—'}
            </div>
          </div>
        </div>
  
        {/* Controls */}
        <div className="bg-[#0f1a2b]/80 border border-blue-900 rounded-2xl p-5 shadow-lg">
          <div className="grid lg:grid-cols-3 gap-5">
            <div>
              <label className="block text-sm text-blue-200/80">RPC (optional)</label>
              <input
                value={rpcUrl}
                onChange={(e) => setRpcUrl(e.target.value)}
                placeholder={DEFAULT_RPC}
                className="w-full bg-blue-950/40 border border-blue-800 rounded-xl px-3 py-2 text-blue-100 placeholder:text-blue-300/50 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-blue-200/70 mt-1">Leave blank to use Linea public RPC.</p>
            </div>
  
            <div>
              <label className="block text-sm text-blue-200/80">Concurrency</label>
              <input
                type="number"
                min={1}
                max={20}
                value={concurrency}
                onChange={(e) => setConcurrency(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                className="w-full bg-blue-950/40 border border-blue-800 rounded-xl px-3 py-2 text-blue-100 placeholder:text-blue-300/50 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-blue-200/70 mt-1">Parallel wallets processed at once.</p>
            </div>
  
            <div>
              <label className="block text-sm text-blue-200/80">RPC interval (ms)</label>
              <input
                type="number"
                min={0}
                value={rpcIntervalMs}
                onChange={(e) => setRpcIntervalMs(Math.max(0, Number(e.target.value) || 0))}
                className="w-full bg-blue-950/40 border border-blue-800 rounded-xl px-3 py-2 text-blue-100 placeholder:text-blue-300/50 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-blue-200/70 mt-1">Rate-limit between RPC calls (helps avoid 429/timeout).</p>
            </div>
          </div>
  
          <div className="grid lg:grid-cols-2 gap-5 mt-5">
            <div>
              <label className="block text-sm text-blue-200/80">CEX Deposit Address(es)</label>
              <textarea
                value={depositRaw}
                onChange={(e) => setDepositRaw(e.target.value)}
                rows={3}
                className="w-full bg-blue-950/40 border border-blue-800 rounded-xl px-3 py-2 text-blue-100 placeholder:text-blue-300/50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="One per line or comma-separated (0x...)"
              />
              <p className="text-xs text-blue-200/70 mt-1">If multiple, wallets are distributed round-robin.</p>
            </div>
            <div>
              <label className="block text-sm text-blue-200/80">Private Keys</label>
              <textarea
                value={privateKeysRaw}
                onChange={(e) => setPrivateKeysRaw(e.target.value)}
                rows={3}
                className="w-full bg-blue-950/40 border border-blue-800 rounded-xl px-3 py-2 text-blue-100 placeholder:text-blue-300/50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="0x + 64 hex chars, e.g. 0x0123...abcd"
              />
            </div>
          </div>
  
          <div className="text-sm text-blue-200/80 mt-4 flex flex-wrap items-center gap-4">
            <div>Starts (UTC): <b>2025-09-10 15:00:00</b></div>
            <div>Countdown: <b>{msToHMS(countdown)}</b></div>
            <div className="text-xs text-amber-300/80">
              Note: Many small deposits to a CEX quickly can trigger risk controls; consider pacing.
            </div>
          </div>
        </div>
  
        {/* Progress */}
        <div className="bg-[#0f1a2b]/80 border border-blue-900 rounded-2xl p-5 shadow-lg">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Wallet Status</h2>
            <div className="text-xs text-blue-200/80 flex items-center gap-3">
              <span className="flex items-center gap-1 text-emerald-300"><IconDone/> Done</span>
              <span className="flex items-center gap-1 text-amber-300"><IconRetry/> Processing</span>
              <span className="flex items-center gap-1 text-rose-300"><IconFail/> Failed</span>
            </div>
          </div>
  
          {/* Overall progress */}
          <div className="mb-4">
            <div className="flex justify-between text-xs text-blue-200/70 mb-1">
              <span>Overall Progress</span>
              <span>{completed} of {rows.length} completed</span>
            </div>
            <div className="w-full h-2 rounded bg-blue-950/40 overflow-hidden">
              <div
                className="h-2 bg-gradient-to-r from-blue-500 to-blue-400"
                style={{ width: rows.length ? `${(completed / rows.length) * 100}%` : '0%' }}
              />
            </div>
            <div className="flex justify-around text-xs mt-1">
              <span className="text-emerald-300">{completed} Completed</span>
              <span className="text-amber-300">{processing} Processing</span>
              <span className="text-rose-300">{failed} Failed</span>
            </div>
          </div>
  
          {/* Wallet list */}
          <div className="max-h-[520px] overflow-auto divide-y divide-blue-900/70">
            {rows.length === 0 && (
              <div className="text-center text-blue-200/70 py-10">
                <div className="text-4xl mb-2">⚠️</div>
                <p className="text-sm">No wallets configured yet</p>
                <p className="text-xs">Add private keys to get started</p>
              </div>
            )}
  
            {rows.map((r, i) => (
              <div key={r.address + "-" + i} className="py-3 flex items-start gap-3">
                <div className="mt-1">{statusIcon(r.status)}</div>
                <div className="min-w-0 w-full">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono text-sm break-all">{r.address}</div>
                    <div className="flex items-center gap-2">
                      {r.dest && <span className="text-xs text-blue-200/70">→ {shortAddr(r.dest)}</span>}
                      <Badge phase={r.phase}>{r.phase}</Badge>
                    </div>
                  </div>
  
                  {/* extra per-wallet stats line */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-blue-200/80 mt-1">
                    <span>Claim tries: <b>{r.claimTries}</b></span>
                    <span>Send tries: <b>{r.sendTries}</b></span>
                    {r.tokenSymbol && <span>Token: <b>{r.tokenSymbol}</b></span>}
                    {typeof r.claimedAmount === 'bigint' && g.tokenDecimals !== undefined && (r.claimedAmount! > 0n) && (
                      <span>Claimed: <b>{formatUnits(r.claimedAmount!, g.tokenDecimals!)} {g.tokenSymbol}</b></span>
                    )}
                    {typeof r.sentAmount === 'bigint' && g.tokenDecimals !== undefined && (r.sentAmount! > 0n) && (
                      <span>Sent: <b>{formatUnits(r.sentAmount!, g.tokenDecimals!)} {g.tokenSymbol}</b></span>
                    )}
                  </div>
  
                  <div className="text-xs text-blue-200/70 mt-0.5">{r.note || '—'}</div>
  
                  {/* Actions */}
                  <div className="flex flex-wrap gap-2 mt-2">
                    <button
                      onClick={() => manualClaim(r.address)}
                      className="text-xs bg-blue-950/40 hover:bg-blue-900/50 text-blue-100 border border-blue-900 rounded-lg px-2 py-1"
                    >
                      Manual Claim
                    </button>
                    <button
                      onClick={() => manualDeposit(r.address)}
                      className="text-xs bg-blue-950/40 hover:bg-blue-900/50 text-blue-100 border border-blue-900 rounded-lg px-2 py-1"
                    >
                      Manual Deposit
                    </button>
                    <button
                      onClick={() => retryClaim(r.address)}
                      className="text-xs bg-blue-950/40 hover:bg-blue-900/50 text-blue-100 border border-blue-900 rounded-lg px-2 py-1"
                    >
                      Retry Claim
                    </button>
                    <button
                      onClick={() => retryDeposit(r.address)}
                      className="text-xs bg-blue-950/40 hover:bg-blue-900/50 text-blue-100 border border-blue-900 rounded-lg px-2 py-1"
                    >
                      Retry Deposit
                    </button>
                  </div>
  
                  {/* TXs */}
                  {r.txs?.length > 0 && (
                    <div className="text-xs text-blue-200/80 mt-1 space-y-0.5">
                      {r.txs.map((h, idx) => (
                        <div key={h + idx} className="truncate">
                          tx:{" "}
                          <a
                            className="underline text-blue-300 hover:text-blue-200"
                            href={`https://lineascan.build/tx/${h}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {h}
                          </a>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
  
        {/* Footer */}
        <div className="text-xs text-blue-200/70">
          <p>
            Contract address:{" "}
            <a
              className="underline text-blue-300 hover:text-blue-200"
              href={`https://lineascan.build/address/${AIRDROP_ADDRESS}`}
              target="_blank"
              rel="noreferrer"
            >
              {AIRDROP_ADDRESS}
            </a>
          </p>
          <p>Privacy: Keys remain in your browser only; never sent to any server.</p>
        </div>
      </div>
    </div>
  );
  
}
