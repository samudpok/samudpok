// ดึงข้อมูลการลงมติของสภาผู้แทนราษฎร ชุดที่ 27 จาก Politigraph (WeVis)
// ข้อมูลเปิดภายใต้ CC BY-NC 4.0 — ใช้แบบไม่แสวงหากำไรและให้เครดิต WeVis
// อ่านอย่างเดียว ไม่มีรหัสผ่านหรือกุญแจใด ๆ
// เคารพข้อจำกัด: ไม่เกิน 30 คำขอต่อ 10 วินาที, ไม่เกิน 1,000 รายการต่อคำขอ

export const ENDPOINT = 'https://politigraph.wevis.info/graphql';
export const HOUSE_ID = 'สภาผู้แทนราษฎร-27';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function gql(query, variables = {}, fetchImpl = fetch, endpoint = ENDPOINT) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429 || res.status >= 500) { await sleep(2000 * attempt); continue; }
    const json = await res.json();
    if (json.errors) throw new Error('Politigraph: ' + JSON.stringify(json.errors).slice(0, 500));
    return json.data;
  }
  throw new Error('Politigraph: ลองซ้ำครบแล้วยังไม่สำเร็จ');
}

export async function fetchRaw({ fetchImpl = fetch, endpoint = ENDPOINT, pauseMs = 400 } = {}) {
  const q = (query, variables) => gql(query, variables, fetchImpl, endpoint);

  const meta = await q(`{
    timestamps { lastVoteEventScrapedAt }
    organizations(where: { classification: { eq: POLITICAL_PARTY } }) { id }
    cabinets: organizations(where: { classification: { eq: CABINET } }, sort: [{ founding_date: DESC }], limit: 3) {
      id founding_date dissolution_date
    }
    voteEvents(where: { organizations: { some: { id: { eq: "${HOUSE_ID}" } } } }, sort: [{ start_date: ASC }], limit: 1000) {
      id title nickname start_date result msbis_id classification
    }
  }`);

  // คณะรัฐมนตรีชุดปัจจุบัน = ชุดล่าสุดที่ยังไม่สิ้นสุด (บางคนในชุดก่อนยังไม่ถูกปิดวันสิ้นสุดในข้อมูล)
  const cabinet = meta.cabinets.find((c) => !c.dissolution_date) ?? null;
  if (meta.voteEvents.length >= 1000) throw new Error('มติเกิน 1,000 รายการ ต้องแบ่งหน้า');
  const events = [];
  for (const e of meta.voteEvents) {
    const d = await q(`query($id: ID!) { voteEvents(where: { id: { eq: $id } }) {
      votes(limit: 1000) { option voter_party voter_name_raw voters { id } } } }`, { id: e.id });
    const votes = d.voteEvents[0].votes;
    if (votes.length >= 1000) throw new Error(`มติ ${e.id} มีผู้ลงคะแนนเกิน 1,000 ต้องแบ่งหน้า`);
    events.push({
      id: e.id, date: e.start_date, title: e.nickname || e.title, result: e.result, msbisId: e.msbis_id, kind: e.classification,
      votes: votes.map((v) => ({ personId: v.voters[0]?.id ?? null, nameRaw: v.voter_name_raw, party: v.voter_party, option: v.option })),
    });
    await sleep(pauseMs);
  }

  const ids = [...new Set(events.flatMap((e) => e.votes.map((v) => v.personId).filter(Boolean)))];
  const people = [];
  for (let i = 0; i < ids.length; i += 200) {
    const d = await q(`query($ids: [ID!]) { people(where: { id: { in: $ids } }, limit: 1000) {
      id prefix firstname lastname
      memberships { start_date end_date province district_number list_number
        posts { role organizations { id classification } } } } }`, { ids: ids.slice(i, i + 200) });
    people.push(...d.people.map((p) => toPerson(p, cabinet?.id)));
    await sleep(pauseMs);
  }

  return {
    fetchedAt: new Date().toISOString(),
    lastVoteEventScrapedAt: meta.timestamps.lastVoteEventScrapedAt,
    cabinet: cabinet && { id: cabinet.id, since: cabinet.founding_date },
    // id ของพรรคใน Politigraph ขึ้นต้นด้วย "พรรค" เสมอ เช่น "พรรคภูมิใจไทย"
    parties: meta.organizations.map((o) => o.id),
    people,
    events,
  };
}

function toPerson(p, cabinetId) {
  const inOrg = (m, pred) => m.posts.some((po) => po.organizations.some(pred));
  const seat = p.memberships.find((m) => inOrg(m, (o) => o.id === HOUSE_ID));
  const ministerNow = !!cabinetId && p.memberships.some((m) => !m.end_date &&
    m.posts.some((po) => po.organizations.some((o) => o.id === cabinetId)));
  // ประธาน/รองประธานสภาทำหน้าที่ควบคุมการประชุม ตามธรรมเนียมจะไม่ลงมติ → ไม่เทียบอัตราการลงมติ
  const presiding = p.memberships.some((m) => !m.end_date &&
    m.posts.some((po) => /ประธานสภาผู้แทนราษฎร/.test(po.role) && po.organizations.some((o) => o.id === HOUSE_ID)));
  return {
    id: p.id,
    name: [p.prefix, p.firstname, p.lastname].filter(Boolean).join(' ').trim(),
    province: seat?.province ?? null,
    district: seat?.district_number ?? null,
    list: seat?.list_number ?? null,
    mpStart: seat?.start_date ?? null,
    mpEnd: seat?.end_date ?? null,
    ministerNow,
    presiding,
  };
}

// เมื่อรันด้วย Node: node scripts/fetch.mjs → เขียน data/raw/latest.json และ data/participation.json
if (typeof process !== 'undefined' && process.argv[1] && (await import('node:url')).fileURLToPath(import.meta.url) === (await import('node:path')).resolve(process.argv[1])) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { compute } = await import('./compute.mjs');
  const raw = await fetchRaw();
  await mkdir('data/raw', { recursive: true });
  await writeFile('data/raw/latest.json', JSON.stringify(raw));
  const result = compute(raw);
  // ด่านตรวจก่อนเขียนทับ: ถ้าข้อมูลต้นทางผิดปกติ ให้หยุด ไม่เปิด PR (กันข้อมูลเสียหรือถูกแก้ไขต้นทาง)
  const { existsSync } = await import('node:fs');
  const { readFile } = await import('node:fs/promises');
  const prev = existsSync('data/participation.json') ? JSON.parse(await readFile('data/participation.json', 'utf8')) : null;
  const problems = [];
  if (prev && result.eventCount < prev.eventCount) problems.push(`จำนวนมติลดลง ${prev.eventCount} → ${result.eventCount}`);
  const sitting = result.mps.filter((m) => !m.mpEnd).length;
  if (sitting < 400 || sitting > 520) problems.push(`จำนวน สส. ที่ยังดำรงตำแหน่งผิดปกติ: ${sitting}`);
  const votes = raw.events.reduce((n, e) => n + e.votes.length, 0);
  if (result.unmatched.options > votes * 0.005) problems.push(`ตัวเลือกการลงมติที่อ่านไม่ออก ${result.unmatched.options} คะแนน เช่น ${result.unmatched.optionSamples.join(', ')}`);
  if (result.unmatched.party > votes * 0.02) problems.push(`จับคู่พรรคไม่ได้ ${result.unmatched.party} คะแนน (เกิน 2%)`);
  if (prev && prev.houseRate != null && Math.abs(result.houseRate - prev.houseRate) > 15) problems.push(`อัตราทั้งสภาเปลี่ยนแรงผิดปกติ ${prev.houseRate} → ${result.houseRate}`);
  if (problems.length) { console.error('หยุด: ' + problems.join(' · ')); process.exit(1); }
  await writeFile('data/participation.json', JSON.stringify(result, null, 1));
  const month = result.computedAt.slice(0, 7);
  await mkdir('data/history', { recursive: true });
  await writeFile(`data/history/${month}.json`, JSON.stringify(result));
  console.log(`มติ ${result.eventCount} ครั้ง (${result.firstDate} ถึง ${result.lastDate}) · สส. ${result.mps.length} คน · ทั้งสภา ${result.houseRate}%`);
  console.log('จับคู่ไม่ได้:', result.unmatched);
}
