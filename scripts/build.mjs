// สร้างเว็บนิ่ง (static) จากข้อมูล: site/template.html + data/*.json → dist/index.html
// ข้อมูลถูกฝังเป็น JSON ในหน้าเดียว ไม่มีการเรียก API ภายนอกตอนเปิดเว็บ (ลดช่องโหว่และไม่เก็บข้อมูลผู้เข้าชม)
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const read = async (p, fallback) => (existsSync(p) ? JSON.parse(await readFile(p, 'utf8')) : fallback);

export function buildData({ promises, participation, history = [] }) {
  const P = participation;
  const parties = promises.parties.map((pp) => {
    const att = P?.parties.find((x) => x.name === pp.partyId) ?? null;
    return {
      name: pp.partyId,
      side: pp.side,
      ectDoc: pp.ectDoc,
      ectSummary: pp.ectSummary,
      seats: att?.sittingMps ?? null,
      pmVote: P?.pmVote?.stance?.[pp.partyId] ?? null,
      attendance: att && { rate: att.rate, voted: att.voted, eligible: att.eligible, absent: att.absent, novote: att.novote, excluded: att.excluded, walkoutEvents: att.walkoutEvents },
      promises: pp.promises.filter((x) => x.published !== false),
    };
  });
  // พรรคที่ไม่มีคำสัญญาในชุดแรก ยังแสดงอัตราการลงมติได้
  const others = (P?.parties ?? [])
    .filter((x) => x.name !== 'ไม่ทราบพรรค' && x.sittingMps > 0 && !parties.some((p) => p.name === x.name))
    .map((att) => ({
      name: att.name, side: null, seats: att.sittingMps, pmVote: P.pmVote?.stance?.[att.name] ?? null,
      attendance: { rate: att.rate, voted: att.voted, eligible: att.eligible, absent: att.absent, novote: att.novote, excluded: att.excluded, walkoutEvents: att.walkoutEvents },
      promises: [],
    }));
  const mps = (P?.mps ?? [])
    .filter((m) => !m.mpEnd && m.name)
    .map((m) => ({
      id: m.id, name: m.name, party: m.party, province: m.province, district: m.district, list: m.list,
      minister: m.ministerNow, presiding: m.presiding,
      att: { rate: m.rate, voted: m.voted, eligible: m.eligible, absent: m.absent, novote: m.novote, excluded: m.excluded },
      dissent: m.dissentBase ? { n: m.dissent, of: m.dissentBase } : null,
      monthly: Object.fromEntries((P.byMonth ?? []).filter((x) => x.mps[m.id] != null).map((x) => [x.period, x.mps[m.id]])),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'th'));
  const strip = (arr) => (arr ?? []).map((x) => ({
    period: x.period, eventCount: x.eventCount, houseRate: x.houseRate,
    parties: Object.fromEntries(Object.entries(x.parties).filter(([n]) => n !== 'ไม่ทราบพรรค').map(([n, v]) => [n, v.rate])),
  }));
  return {
    builtAt: new Date().toISOString(),
    source: P ? {
      name: 'Politigraph โดย WeVis', license: 'CC BY-NC 4.0', url: 'https://politigraph.wevis.info',
      fetchedAt: P.fetchedAt, scrapedAt: P.sourceScrapedAt, eventCount: P.eventCount, firstDate: P.firstDate, lastDate: P.lastDate,
      unmatchedVotes: P.unmatched?.votes ?? 0,
    } : null,
    house: P ? { rate: P.houseRate, medianMpRate: P.houseMedianMpRate, cabinet: P.cabinet, pmVote: P.pmVote && { date: P.pmVote.date, elected: P.pmVote.elected } } : null,
    statusLadder: promises.statusLadder,
    parties: [...parties, ...others].sort((a, b) => (b.seats ?? -1) - (a.seats ?? -1)),
    mps,
    byMonth: strip(P?.byMonth),
    byYear: strip(P?.byYear),
    history, // [{month, houseRate}] จากไฟล์ data/history ทุกเดือนที่เคยคำนวณ
    fixture: !!P?.fixture, // true = ข้อมูลทดสอบสมมติ ห้ามเผยแพร่
  };
}

// กันการปิด <script> ก่อนเวลา และอักขระที่ทำให้ HTML เพี้ยน
const safeJson = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

if (process.argv[1] && (await import('node:url')).fileURLToPath(import.meta.url) === (await import('node:path')).resolve(process.argv[1])) {
  const fixture = process.argv.includes('--fixture');
  const promises = await read('data/promises.json');
  const participation = await read(fixture ? 'data/fixture/participation.json' : 'data/participation.json', null);
  if (!fixture && participation?.fixture) throw new Error('data/participation.json เป็นข้อมูลทดสอบ ห้ามนำขึ้นเว็บจริง');
  const history = [];
  if (existsSync('data/history')) {
    for (const f of (await readdir('data/history')).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort()) {
      const h = JSON.parse(await readFile(`data/history/${f}`, 'utf8'));
      history.push({ month: f.slice(0, 7), houseRate: h.houseRate, eventCount: h.eventCount });
    }
  }
  const data = buildData({ promises, participation, history });
  const tpl = await readFile('site/template.html', 'utf8');
  if (!tpl.includes('/*__SAMUDPOK_DATA__*/null')) throw new Error('template ไม่มีจุดฝังข้อมูล /*__SAMUDPOK_DATA__*/null');
  const { rm } = await import('node:fs/promises');
  await rm('dist', { recursive: true, force: true });
  await mkdir('dist', { recursive: true });
  // แยกสคริปต์แอปออกเป็นไฟล์ เพื่อให้ CSP ห้ามสคริปต์ inline ได้ทั้งหมด (script-src 'self')
  const { createHash } = await import('node:crypto');
  const apps = [...tpl.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (apps.length !== 1) throw new Error(`template ต้องมีสคริปต์แอป 1 ก้อน แต่พบ ${apps.length}`);
  const js = apps[0][1];
  const jsName = `app.${createHash('sha256').update(js).digest('hex').slice(0, 12)}.js`;
  await writeFile(`dist/${jsName}`, js);
  let html = tpl.replace(apps[0][0], () => `<script src="/${jsName}" defer></script>`)
    .replace(/(<meta http-equiv="Content-Security-Policy" content="[^"]*?)script-src 'unsafe-inline'/, "$1script-src 'self'")
    .replace('/*__SAMUDPOK_DATA__*/null', () => safeJson(data));
  if (/script-src[^;"]*unsafe-inline/.test(html)) throw new Error('CSP ยังอนุญาตสคริปต์ inline');
  await writeFile('dist/index.html', html);
  if (existsSync('site/robots.txt')) await copyFile('site/robots.txt', 'dist/robots.txt');
  if (existsSync('site/security.txt')) { await mkdir('dist/.well-known', { recursive: true }); await copyFile('site/security.txt', 'dist/.well-known/security.txt'); }
  console.log(`dist/index.html · พรรค ${data.parties.length} · สส. ${data.mps.length} · ${fixture ? 'ข้อมูลทดสอบ (สมมติ)' : 'ข้อมูลจริง'}`);
}
