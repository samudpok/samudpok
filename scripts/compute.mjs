// คำนวณ "การทำหน้าที่ในสภา" จากข้อมูลการลงมติดิบ (raw) ของ Politigraph
// ใช้ได้ทั้งใน Node และเบราว์เซอร์: export function compute(raw)
// สูตรตามพิมพ์เขียว สมุดพก ส.ส.:
//   ลงมติ = เห็นด้วย / ไม่เห็นด้วย / งดออกเสียง
//   ไม่นับ (ตัดออกจากตัวหาร) = ไม่แสดงตนพร้อมพรรค (สส. ของพรรคเกินครึ่งไม่ลงมติในมติเดียวกัน)
//   ข้อจำกัดข้อมูล: แหล่งข้อมูลรวม "ลา" กับ "ขาดลงมติ" ไว้ด้วยกัน จึงยังแยกการลาตามระเบียบไม่ได้

export const OPTION = {
  'เห็นด้วย': 'A',
  'ไม่เห็นด้วย': 'D',
  'งดออกเสียง': 'B',
  'ไม่ลงคะแนนเสียง': 'N',
  'ลา / ขาดลงมติ': 'X',
};

const CAST = new Set(['A', 'D', 'B']);
// การลงมติเลือกนายกรัฐมนตรี ตัวเลือกคือชื่อผู้ถูกเสนอชื่อ → นับเป็น "ลงมติ" และใช้ชื่อเป็นรหัส
// ตัวเลือกที่ไม่รู้จักในมติทั่วไปถือว่า "อ่านไม่ออก" ไม่นับเป็นลงมติ (กันตัวเลขพองจากการสะกดเพี้ยน)
const codeOf = (option, kind) => {
  const o = (option ?? '').replace(/\s+/g, ' ').trim();
  if (!o) return null;
  if (OPTION[o]) return OPTION[o];
  return kind === 'PM_VOTE' ? 'C:' + o : '?';
};
const isCast = (code) => CAST.has(code) || code.startsWith('C:');

// ชื่อพรรคใน voter_party มาจากการอ่านเอกสารสแกน (OCR) จึงมีตัวอักษรเพี้ยน
// จับคู่กับรายชื่อพรรคที่รู้จักด้วยการเทียบความคล้าย
export function normalizeParty(raw, known) {
  if (!raw) return null;
  const clean = raw.replace(/^พรรค/, '').replace(/[^฀-๿]/g, '').replace(/[่-๋]/g, '');
  if (!clean) return null;
  // ตรงทุกตัวอักษรก่อน แล้วค่อยเทียบความคล้าย (กันกรณี "เพื่อไทย" ถูกจับเป็น "พลังเพื่อไทย")
  const exact = known.find((name) => name.replace(/^พรรค/, '').replace(/[่-๋]/g, '') === clean);
  if (exact) return exact;
  let best = null;
  let bestScore = 0;
  for (const name of known) {
    const k = name.replace(/^พรรค/, '').replace(/[่-๋]/g, '');
    const score = similarity(clean, k);
    if (score > bestScore) { bestScore = score; best = name; }
  }
  return bestScore >= 0.8 ? best : null;
}

function similarity(a, b) {
  if (a === b) return 1;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

/**
 * raw = {
 *   fetchedAt, lastVoteEventScrapedAt,
 *   parties: [ชื่อพรรคที่รู้จัก],
 *   people: [{ id, name, province, district, list, mpStart, mpEnd, ministerNow }],
 *   events: [{ id, date, title, result, msbisId, votes: [{ personId|null, nameRaw, party, option }] }]
 * }
 */
export function compute(raw) {
  const known = raw.parties;
  const people = new Map(raw.people.map((p) => [p.id, p]));
  const mp = new Map(); // personId -> สถิติ
  const partyAgg = new Map();
  for (const ev of raw.events) if (!ev.date) throw new Error(`มติ ${ev.id} ไม่มีวันที่`);
  const unmatched = { votes: 0, party: 0, options: 0, optionSamples: [] };
  let houseVoted = 0, houseEligible = 0;

  const ensureMp = (id) => {
    if (!mp.has(id)) mp.set(id, { eligible: 0, voted: 0, absent: 0, novote: 0, excluded: 0, dissent: 0, dissentBase: 0, partyCount: {} });
    return mp.get(id);
  };
  const ensureParty = (name) => {
    if (!partyAgg.has(name)) partyAgg.set(name, { voted: 0, eligible: 0, absent: 0, novote: 0, excluded: 0, walkoutEvents: 0 });
    return partyAgg.get(name);
  };
  // สรุปตามช่วงเวลา: period -> { house:{voted,eligible}, parties:{name:{voted,eligible}}, mps:{id:{voted,eligible}} }
  const periods = { month: new Map(), year: new Map() };
  const bump = (kind, key, party, id, cast, pooled) => {
    const p = periods[kind].get(key);
    if (pooled) {
      p.house.eligible++; if (cast) p.house.voted++;
      p.parties[party] ??= { voted: 0, eligible: 0 };
      p.parties[party].eligible++; if (cast) p.parties[party].voted++;
    }
    p.mps[id] ??= { voted: 0, eligible: 0 };
    p.mps[id].eligible++; if (cast) p.mps[id].voted++;
  };

  let pmVote = null; // ท่าทีของแต่ละพรรคในการโหวตเลือกนายกฯ ครั้งล่าสุด (ข้อเท็จจริงจากมติ ไม่ใช่การจัดฝ่ายเอง)
  for (const ev of raw.events) {
    // 1) จัดกลุ่มตามพรรค ณ เวลาที่ลงมติ
    const rows = [];
    for (const v of ev.votes) {
      const code = codeOf(v.option, ev.kind);
      if (!code) continue;
      if (code === '?') { unmatched.options++; if (unmatched.optionSamples.length < 10 && !unmatched.optionSamples.includes(v.option)) unmatched.optionSamples.push(v.option); continue; }
      if (!v.personId) { unmatched.votes++; continue; }
      const party = normalizeParty(v.party, known);
      if (!party) unmatched.party++;
      rows.push({ id: v.personId, code, party: party || 'ไม่ทราบพรรค' });
    }
    const byParty = new Map();
    for (const r of rows) {
      if (!byParty.has(r.party)) byParty.set(r.party, []);
      byParty.get(r.party).push(r);
    }
    // 2) ไม่แสดงตนพร้อมพรรค: พรรคที่มี สส. ตั้งแต่ 3 คน และเกินครึ่งไม่ลงมติ
    const walkout = new Set();
    const majority = new Map();
    for (const [party, list] of byParty) {
      const notCast = list.filter((r) => !isCast(r.code)).length;
      if (party !== 'ไม่ทราบพรรค' && list.length >= 3 && notCast / list.length > 0.5) walkout.add(party);
      const tally = {};
      for (const r of list) if (isCast(r.code)) tally[r.code] = (tally[r.code] || 0) + 1;
      const top = topOf(tally);
      if (top) majority.set(party, top[0]); // เสมอกัน = ไม่มีเสียงข้างมาก ไม่นับการลงมติต่างจากพรรค
    }
    for (const party of walkout) ensureParty(party).walkoutEvents++;
    if (ev.kind === 'PM_VOTE') {
      const stance = {};
      for (const [party, list] of byParty) {
        if (party === 'ไม่ทราบพรรค') continue;
        const tally = {};
        for (const r of list) tally[r.code] = (tally[r.code] || 0) + 1;
        const top = topOf(tally);
        if (!top) { stance[party] = { stance: 'split', choice: null, share: null, members: list.length }; continue; }
        const [code, n] = top;
        const elected = 'C:' + (ev.result || '').replace(/\s+/g, ' ').trim();
        const label = code === elected ? 'for' : code.startsWith('C:') ? 'other'
          : { B: 'abstain', N: 'novote', X: 'absent', A: 'approve', D: 'reject' }[code];
        stance[party] = { stance: label, choice: code.startsWith('C:') ? code.slice(2) : null, share: Math.round((n / list.length) * 100), members: list.length };
      }
      pmVote = { eventId: ev.id, date: ev.date, elected: ev.result, stance };
    }

    // 3) นับรายคน — ประธาน/รองประธานสภานับเฉพาะรายคน ไม่รวมในอัตราของพรรคและทั้งสภา
    const month = ev.date.slice(0, 7), year = ev.date.slice(0, 4);
    for (const k of ['month', 'year']) {
      const key = k === 'month' ? month : year;
      if (!periods[k].has(key)) periods[k].set(key, { events: new Set(), house: { voted: 0, eligible: 0 }, parties: {}, mps: {} });
      periods[k].get(key).events.add(ev.id);
    }
    for (const r of rows) {
      const s = ensureMp(r.id);
      s.partyCount[r.party] = (s.partyCount[r.party] || 0) + 1;
      if (r.party !== 'ไม่ทราบพรรค' || !s.lastParty) s.lastParty = r.party;
      const pooled = !people.get(r.id)?.presiding;
      const pa = pooled ? ensureParty(r.party) : { };
      if (walkout.has(r.party) && !isCast(r.code)) { s.excluded++; if (pooled) pa.excluded++; continue; }
      s.eligible++; if (pooled) { pa.eligible++; houseEligible++; }
      bump('month', month, r.party, r.id, isCast(r.code), pooled);
      bump('year', year, r.party, r.id, isCast(r.code), pooled);
      if (isCast(r.code)) {
        s.voted++; if (pooled) { pa.voted++; houseVoted++; }
        const maj = majority.get(r.party);
        if (maj && r.party !== 'ไม่ทราบพรรค') { s.dissentBase++; if (r.code !== maj) s.dissent++; }
      } else if (r.code === 'N') { s.novote++; if (pooled) pa.novote++; }
      else { s.absent++; if (pooled) pa.absent++; }
    }
  }

  const mps = [...mp.entries()].map(([id, s]) => {
    const p = people.get(id) || {};
    const party = s.lastParty ?? null; // พรรคล่าสุดที่ลงมติ (รองรับการย้ายพรรค)
    return {
      id, name: p.name ?? null, party, province: p.province ?? null, district: p.district ?? null,
      list: p.list ?? null, mpStart: p.mpStart ?? null, mpEnd: p.mpEnd ?? null, ministerNow: !!p.ministerNow, presiding: !!p.presiding,
      eligible: s.eligible, voted: s.voted, absent: s.absent, novote: s.novote, excluded: s.excluded,
      rate: pct(s.voted, s.eligible), dissent: s.dissent, dissentBase: s.dissentBase,
      partyHistory: Object.keys(s.partyCount).length > 1 ? s.partyCount : null,
    };
  });

  const seats = {};
  for (const m of mps) if (!m.mpEnd && m.party) seats[m.party] = (seats[m.party] || 0) + 1;

  const parties = [...partyAgg.entries()].map(([name, a]) => ({
    name, sittingMps: seats[name] || 0, ...a, rate: pct(a.voted, a.eligible),
  })).sort((x, y) => y.sittingMps - x.sittingMps);

  return {
    computedAt: new Date().toISOString(),
    fetchedAt: raw.fetchedAt,
    sourceScrapedAt: raw.lastVoteEventScrapedAt,
    house: 'สภาผู้แทนราษฎร ชุดที่ 27',
    eventCount: raw.events.length,
    firstDate: raw.events[0]?.date ?? null,
    lastDate: raw.events.at(-1)?.date ?? null,
    houseRate: pct(houseVoted, houseEligible),
    cabinet: raw.cabinet ?? null,
    pmVote,
    // มัธยฐานไม่รวมประธาน/รองประธานสภา (ไม่ลงมติตามธรรมเนียม)
    houseMedianMpRate: median(mps.filter((m) => m.eligible > 0 && !m.presiding && !m.mpEnd).map((m) => m.rate)),
    unmatched,
    parties,
    mps,
    byMonth: summarizePeriods(periods.month),
    byYear: summarizePeriods(periods.year),
  };
}

// ตัวเลือกที่ได้มากที่สุด ถ้าเสมอกันคืน null
function topOf(tally) {
  const e = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (!e.length || (e[1] && e[1][1] === e[0][1])) return null;
  return e[0];
}

function summarizePeriods(map) {
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, p]) => ({
    period,
    eventCount: p.events.size,
    houseRate: pct(p.house.voted, p.house.eligible),
    parties: Object.fromEntries(Object.entries(p.parties).map(([n, x]) => [n, { ...x, rate: pct(x.voted, x.eligible) }])),
    mps: Object.fromEntries(Object.entries(p.mps).map(([id, x]) => [id, pct(x.voted, x.eligible)])),
  }));
}

function median(xs) {
  const a = xs.filter((x) => x != null).sort((p, q) => p - q);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round(((a[mid - 1] + a[mid]) / 2) * 10) / 10;
}
