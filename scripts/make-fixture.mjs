// สร้างข้อมูลทดสอบ "สมมติทั้งหมด" สำหรับดูหน้าตาเว็บบนเครื่อง — ห้ามนำขึ้นเว็บจริง
// ใช้ชื่อพรรคและบุคคลสมมติเท่านั้น เพื่อไม่ให้มีตัวเลขปลอมผูกกับพรรคหรือคนจริง
import { writeFile, mkdir } from 'node:fs/promises';
import { compute } from './compute.mjs';

let seed = 27;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const parties = [['พรรคทดสอบหนึ่ง', 180, 0.95], ['พรรคทดสอบสอง', 130, 0.9], ['พรรคทดสอบสาม', 90, 0.85], ['พรรคทดสอบสี่', 60, 0.75], ['พรรคทดสอบห้า', 40, 0.8]];
const people = [];
const seatOf = {};
let n = 0;
for (const [party, seats] of parties) {
  for (let i = 0; i < seats; i++) {
    const id = 'fx-' + (++n);
    people.push({ id, name: `นายสมมติ ทดสอบ${n}`, province: 'จังหวัดสมมติ', district: (i % 10) + 1, list: null, mpStart: '2026-03-15', mpEnd: null, ministerNow: i < 3 && party === 'พรรคทดสอบหนึ่ง', presiding: n === 5 });
    seatOf[id] = party;
  }
}
const events = [];
const months = ['2026-03-19', '2026-05-12', '2026-05-20', '2026-06-04', '2026-06-18', '2026-07-09', '2026-09-03', '2026-09-17', '2026-09-24'];
months.forEach((date, k) => {
  const walk = k === 4 ? 'พรรคทดสอบสี่' : null;
  events.push({
    id: 'fx-ev-' + k, date, title: 'มติสมมติ ' + (k + 1), result: '', msbisId: null, kind: 'MP_1',
    votes: people.map((p) => {
      const party = seatOf[p.id];
      const base = parties.find((x) => x[0] === party)[2] - (p.ministerNow || p.presiding ? 0.7 : 0);
      const option = walk === party ? 'ลา / ขาดลงมติ' : rnd() < base ? (rnd() < 0.93 ? 'เห็นด้วย' : 'ไม่เห็นด้วย') : rnd() < 0.85 ? 'ลา / ขาดลงมติ' : 'ไม่ลงคะแนนเสียง';
      return { personId: p.id, nameRaw: p.name, party, option };
    }),
  });
});
const raw = { fetchedAt: new Date().toISOString(), lastVoteEventScrapedAt: null, parties: parties.map((p) => p[0]), people, events, cabinet: null };
await mkdir('data/fixture', { recursive: true });
const out = compute(raw);
out.fixture = true;
await writeFile('data/fixture/participation.json', JSON.stringify(out));
console.log('fixture: houseRate', out.houseRate, '· parties', out.parties.map((p) => `${p.name} ${p.rate}%`).join(', '));
