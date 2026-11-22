#!/usr/bin/env node
/* 매집 계기반 — 주봉 5·20 크로스 / 월봉 15WMA 돌파 감시
 *
 * 판정 로직은 앱(index.html)의 wmaAt·toWeekly·toMonthly·judge 를 그대로 옮긴 것이다.
 * 한 글자라도 달라지면 화면과 알림이 어긋나므로, 앱을 고치면 이 파일도 같이 고친다.
 *
 * 환경변수: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * 종목 목록: data/watchlist.json   상태: data/alert-state.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT   = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WATCH  = path.join(ROOT, 'data', 'watchlist.json');
const STATE  = path.join(ROOT, 'data', 'alert-state.json');
const TOKEN  = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT   = process.env.TELEGRAM_CHAT_ID   || '';
const DRY    = process.argv.includes('--dry-run');

/* ---------- 앱과 동일한 판정 로직 (index.html에서 이식) ---------- */
function wmaAt(a, n, off) {
  const end = a.length - off; if (end < n) return null;
  const s = a.slice(end - n, end); let num = 0, den = 0;
  s.forEach((v, i) => { const w = i + 1; num += v * w; den += w; });
  return num / den;
}
function toWeekly(bars) {
  const out = []; let key = null;
  bars.forEach(b => {
    const d = new Date(b.t);
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    m.setUTCDate(m.getUTCDate() - ((m.getUTCDay() + 6) % 7));
    const k = m.toISOString().slice(0, 10);
    if (k === key) out[out.length - 1] = b.c; else { out.push(b.c); key = k; }
  });
  return out;
}
function toMonthly(bars) {
  const out = []; let key = null;
  bars.forEach(b => { const d = new Date(b.t);
    const k = d.getUTCFullYear() + '-' + d.getUTCMonth();
    if (k === key) out[out.length - 1] = b.c; else { out.push(b.c); key = k; } });
  return out;
}
function judge(d, w, m, mOpen) {
  const d5 = wmaAt(d,5,0), d5p = wmaAt(d,5,1), d20 = wmaAt(d,20,0),
        d60 = wmaAt(d,60,0), d60p = wmaAt(d,60,1);
  const w5 = wmaAt(w,5,0), w5p = wmaAt(w,5,1), w20 = wmaAt(w,20,0), w20p = wmaAt(w,20,1);
  if ([d5,d5p,d20,d60,d60p,w5,w5p,w20,w20p].some(v => v === null)) return null;
  m = m || [];
  const m15 = wmaAt(m,15,0), m15p = wmaAt(m,15,1);
  const mC = m.length ? m[m.length-1] : null, mCp = m.length > 1 ? m[m.length-2] : null;
  const hasM = (m15 !== null && m15p !== null && mC !== null && mCp !== null);
  const mGoldRaw = hasM && mCp <= m15p && mC > m15, mDead = hasM && mCp >= m15p && mC < m15;
  const mGold = mGoldRaw && !mOpen;
  const mUp = hasM && mC > m15;
  const jung = d5 > d20 && d20 > d60, yeok = d5 < d20 && d20 < d60;
  const dGold = d5p <= d60p && d5 > d60, dDead = d5p >= d60p && d5 < d60;
  const wGold = w5p <= w20p && w5 > w20, wDead = w5p >= w20p && w5 < w20;
  const wUp = w5 > w20;
  let v, s;
  if (mGold) { v = '강력 매수'; s = 'ok'; }
  else if (mGoldRaw && mOpen) { v = '돌파 잠정'; s = 'buy2'; }
  else if (jung && wUp) { v = '강력 매수'; s = 'ok'; }
  else if (dGold || wGold) { v = '매수'; s = 'ok'; }
  else if (mDead) { v = '매도'; s = 'alarm'; }
  else if (yeok && !wUp) { v = '매도'; s = 'alarm'; }
  else if (dDead || wDead) { v = '매도 검토'; s = 'warn'; }
  else { v = '관망'; s = 'dim'; }
  return { d5,d20,d60,w5,w20,jung,yeok,dGold,dDead,wGold,wDead,wUp,
    hasM,mGold,mDead,mUp,verdict:v,state:s,mGoldRaw,mOpen,
    mx: !hasM ? '데이터 부족' : (mGoldRaw ? (mOpen ? '돌파(미마감)' : '상승 돌파')
        : (mDead ? '하향 이탈' : (mUp ? '15WMA 상회' : '15WMA 하회'))),
    arr: jung ? '정배열' : (yeok ? '역배열' : '혼조'),
    dx: dGold ? '골든크로스' : (dDead ? '데드크로스' : (d5 > d60 ? '5>60 유지' : '5<60 유지')),
    wx: wGold ? '골든크로스' : (wDead ? '데드크로스' : (wUp ? '5>20 유지' : '5<20 유지')) };
}
export { wmaAt, toWeekly, toMonthly, judge };

/* ---------- 시세 조달 ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function bars(sym) {
  // 코인도 주식도 Yahoo 한 곳에서 받는다. 러너가 미국에 있어 Binance는 막힐 수 있다.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5y&interval=1d`;
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      if (!res?.timestamp) throw new Error('데이터 없음');
      const cl = res.indicators.quote[0].close, out = [];
      res.timestamp.forEach((t, k) => { if (cl[k] != null) out.push({ t: t * 1000, c: cl[k] }); });
      if (out.length < 70) throw new Error('데이터 부족 ' + out.length + '일');
      return out;
    } catch (e) { last = e; await sleep(1500 * (i + 1)); }
  }
  throw last;
}

/* ---------- 텔레그램 ---------- */
async function tg(text) {
  if (DRY) { console.log('[DRY-RUN] 전송 안 함:\n' + text); return true; }
  if (!TOKEN || !CHAT) { console.error('토큰 또는 채팅 ID가 없습니다.'); return false; }
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  if (!r.ok) { console.error('텔레그램 전송 실패 HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200)); return false; }
  return true;
}

/* ---------- 본체 ---------- */
const readJson = async (p, dflt) => { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return dflt; } };

async function main() {
  const wl = await readJson(WATCH, null);
  if (!wl) { console.error('watchlist.json 을 읽을 수 없습니다.'); process.exit(1); }
  const prev = await readJson(STATE, {});
  const next = {}, hits = [], failed = [];

  const list = [
    ...(wl.coins  || []).map(s => ({ sym: s, yf: `${s}-USD`, kind: '코인' })),
    ...(wl.stocks || []).map(s => ({ sym: s, yf: s,          kind: '주식' })),
  ];
  if (!list.length) { console.error('watchlist 가 비었습니다.'); process.exit(1); }

  for (const it of list) {
    try {
      const d = await bars(it.yf);
      const lastT = new Date(d[d.length - 1].t), now = new Date();
      const mOpen = lastT.getUTCFullYear() === now.getUTCFullYear() && lastT.getUTCMonth() === now.getUTCMonth();
      const j = judge(d.map(x => x.c), toWeekly(d), toMonthly(d), mOpen);
      if (!j) { failed.push(`${it.sym} (데이터 부족)`); continue; }

      const px = d[d.length - 1].c;
      const cur = { wx: j.wx, mx: j.mx };
      next[it.sym] = cur;
      const was = prev[it.sym];

      // 상태가 바뀐 그 순간에만 알린다. 같은 상태가 이어지면 침묵한다.
      if (was && was.wx !== cur.wx && (j.wGold || j.wDead))
        hits.push({ sym: it.sym, kind: it.kind, px, type: j.wGold ? '주봉 골든크로스' : '주봉 데드크로스',
                    up: j.wGold, detail: `주봉 WMA5 ${j.w5.toFixed(2)} / WMA20 ${j.w20.toFixed(2)}`, verdict: j.verdict });
      if (was && was.mx !== cur.mx && (j.mGoldRaw || j.mDead))
        hits.push({ sym: it.sym, kind: it.kind, px, type: j.mDead ? '월봉 15WMA 하향 이탈'
                      : (j.mOpen ? '월봉 15WMA 돌파 (미마감)' : '월봉 15WMA 상승 돌파'),
                    up: !j.mDead, detail: j.mOpen ? '진행 중인 달 기준 · 월말 마감으로 확정' : '월봉 마감 확정',
                    verdict: j.verdict });

      console.log(`${it.sym.padEnd(6)} ${String(Math.round(px)).padStart(8)}  주봉 ${j.wx.padEnd(8)}  월봉 ${j.mx}`
        + (was ? '' : '  (첫 기록 — 알림 없음)'));
    } catch (e) {
      failed.push(`${it.sym} (${e.message})`);
      if (prev[it.sym]) next[it.sym] = prev[it.sym];   // 조달 실패 시 직전 상태 유지
      console.error(`${it.sym.padEnd(6)} 조달 실패 — ${e.message}`);
    }
    await sleep(1200);
  }

  const kst = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  if (hits.length) {
    const body = hits.map(h =>
      `${h.up ? '🟢' : '🔴'} <b>${h.sym}</b> · ${h.type}\n`
      + `    ${h.px >= 100 ? Math.round(h.px).toLocaleString('en-US') : h.px.toPrecision(4)} · 종합 <b>${h.verdict}</b>\n`
      + `    <i>${h.detail}</i>`).join('\n\n');
    await tg(`<b>매집 계기반 · 추세 신호</b>\n${kst} KST\n\n${body}`);
  } else {
    console.log('변경된 신호 없음 — 전송하지 않음');
  }

  // 조달 실패는 반드시 알린다. 조용히 죽으면 "신호가 없다"로 오해한다.
  if (failed.length)
    await tg(`<b>⚠ 매집 계기반 · 시세 조달 실패</b>\n${kst} KST\n\n${failed.join('\n')}\n\n`
      + `<i>해당 종목은 이번 회차에 검사되지 않았습니다.</i>`);

  await fs.writeFile(STATE, JSON.stringify(next, null, 2) + '\n');
  console.log(`\n검사 ${list.length}종목 · 신호 ${hits.length}건 · 실패 ${failed.length}건`);
  if (failed.length === list.length) process.exit(1);
}

// 직접 실행할 때만 돈다. 다른 모듈이 import 하면 함수만 가져간다.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch(e => { console.error(e); process.exit(1); });
