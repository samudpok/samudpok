// ทดสอบสูตรด้วยข้อมูลสมมติ (ไม่ใช่บุคคลจริง) — รัน: node --test scripts/
import test from 'node:test';
import assert from 'node:assert/strict';
import { compute, normalizeParty } from './compute.mjs';

const parties = ['พรรคตัวอย่างหนึ่ง', 'พรรคตัวอย่างสอง', 'พรรคเพื่อไทย', 'พรรคพลังเพื่อไทย'];

test('normalizeParty: ตรงตัวก่อน แล้วค่อยเทียบความคล้าย', () => {
  assert.equal(normalizeParty('เพื่อไทย', parties), 'พรรคเพื่อไทย');
  assert.equal(normalizeParty('พรรคเพื่อไทย', parties), 'พรรคเพื่อไทย');
  assert.equal(normalizeParty('ตัวอย่างหนึ่ง ^ู', parties), 'พรรคตัวอย่างหนึ่ง');
  assert.equal(normalizeParty('ตัวอยางสอง', parties), 'พรรคตัวอย่างสอง'); // ตกไม้เอก
  assert.equal(normalizeParty('ไม่มีพรรคนี้เลยจริงๆ', parties), null);
  assert.equal(normalizeParty('', parties), null);
});

// สภาสมมติ: พรรคหนึ่ง 4 คน (p1-p4), พรรคสอง 3 คน (q1-q3)
const people = ['p1', 'p2', 'p3', 'p4', 'q1', 'q2', 'q3'].map((id) => ({ id, name: 'สมมติ ' + id }));
const ev = (id, date, opts) => ({
  id, date, title: id, result: '', msbisId: null,
  votes: Object.entries(opts).map(([pid, option]) => ({
    personId: pid, nameRaw: pid, party: pid.startsWith('p') ? 'ตัวอย่างหนึ่ง' : 'ตัวอย่างสอง', option,
  })),
});
const A = 'เห็นด้วย', D = 'ไม่เห็นด้วย', X = 'ลา / ขาดลงมติ', N = 'ไม่ลงคะแนนเสียง';
const raw = {
  fetchedAt: 'x', lastVoteEventScrapedAt: 'y', parties, people,
  events: [
    ev('e1', '2026-03-10', { p1: A, p2: A, p3: A, p4: X, q1: D, q2: D, q3: D }),
    // พรรคสองไม่แสดงตนพร้อมกัน (3/3) → ตัดออกจากตัวหาร ไม่นับเป็นขาด
    ev('e2', '2026-04-02', { p1: A, p2: D, p3: A, p4: A, q1: N, q2: X, q3: N }),
    ev('e3', '2027-01-15', { p1: A, p2: A, p3: X, p4: X, q1: D, q2: A, q3: D }),
  ],
};
// แถมคะแนนที่ไม่มีตัวบุคคล ต้องนับเป็น unmatched ไม่ใช่ตัวหาร
raw.events[0].votes.push({ personId: null, nameRaw: '???', party: 'ตัวอย่างหนึ่ง', option: A });

const r = compute(raw);
const mp = (id) => r.mps.find((m) => m.id === id);
const party = (n) => r.parties.find((p) => p.name === n);

test('อัตราการลงมติรายคน', () => {
  assert.deepEqual([mp('p1').voted, mp('p1').eligible, mp('p1').rate], [3, 3, 100]);
  assert.deepEqual([mp('p4').voted, mp('p4').eligible, mp('p4').absent], [1, 3, 2]);
  assert.equal(mp('p4').rate, 33.3);
});

test('ไม่แสดงตนพร้อมพรรค ถูกตัดออกจากตัวหาร', () => {
  assert.equal(mp('q1').excluded, 1);
  assert.equal(mp('q1').eligible, 2);
  assert.equal(mp('q1').rate, 100);
  assert.equal(party('พรรคตัวอย่างสอง').walkoutEvents, 1);
  assert.equal(party('พรรคตัวอย่างหนึ่ง').walkoutEvents, 0);
});

test('อัตรารายพรรคคิดรวมทุกคน (pooled)', () => {
  const p = party('พรรคตัวอย่างหนึ่ง');
  assert.deepEqual([p.voted, p.eligible, p.rate], [9, 12, 75]);
  assert.equal(party('พรรคตัวอย่างสอง').rate, 100);
  assert.equal(r.houseRate, Math.round((15 / 18) * 1000) / 10);
});

test('โหวตต่างจากเสียงข้างมากของพรรค', () => {
  assert.equal(mp('p2').dissent, 1);
  assert.equal(mp('q2').dissent, 1);
  assert.equal(mp('p1').dissent, 0);
});

test('คะแนนที่จับคู่บุคคลไม่ได้ ไม่ถูกนับ', () => {
  assert.equal(r.unmatched.votes, 1);
  assert.equal(r.unmatched.party, 0);
});

test('สรุปรายเดือนและรายปี', () => {
  assert.deepEqual(r.byMonth.map((m) => m.period), ['2026-03', '2026-04', '2027-01']);
  assert.deepEqual(r.byYear.map((y) => y.period), ['2026', '2027']);
  const apr = r.byMonth[1];
  assert.equal(apr.parties['พรรคตัวอย่างสอง'], undefined); // ถูกตัดทั้งพรรคเดือนนั้น
  assert.equal(apr.parties['พรรคตัวอย่างหนึ่ง'].rate, 100);
  assert.equal(r.byYear[0].mps.p4, 50);
  assert.equal(r.byYear[1].mps.p4, 0);
});

test('มติเลือกนายกฯ: ชื่อผู้ถูกเสนอชื่อนับเป็นการลงมติ', () => {
  const pmEv = ev('pm', '2026-03-18', { p1: 'นายสมมติ ก', p2: 'นายสมมติ ก', p3: 'นายสมมติ ข', p4: X, q1: 'นายสมมติ ข', q2: 'งดออกเสียง', q3: 'นายสมมติ ข' });
  pmEv.kind = 'PM_VOTE'; pmEv.result = 'นายสมมติ ก';
  const r2 = compute({ ...raw, events: [pmEv] });
  assert.equal(r2.pmVote.stance['พรรคตัวอย่างหนึ่ง'].stance, 'for');
  assert.equal(r2.pmVote.stance['พรรคตัวอย่างสอง'].stance, 'other');
  const m = (id) => r2.mps.find((x) => x.id === id);
  assert.equal(m('p3').voted, 1);
  assert.equal(m('p3').dissent, 1);
  assert.equal(m('p4').absent, 1);
  assert.equal(r2.houseRate, Math.round((6 / 7) * 1000) / 10);
});

test('ตัวเลือกที่อ่านไม่ออกในมติทั่วไป ไม่นับเป็นลงมติ', () => {
  const e = ev('odd', '2026-08-01', { p1: 'ลา', p2: 'เห็นด้วย ', p3: '-', p4: A, q1: D, q2: D, q3: D });
  const r3 = compute({ ...raw, events: [e] });
  assert.equal(r3.unmatched.options, 2);
  assert.equal(r3.mps.find((m) => m.id === 'p2').voted, 1); // ช่องว่างท้ายถูกตัดแล้วอ่านออก
  assert.equal(r3.mps.find((m) => m.id === 'p1'), undefined);
});

test('ย้ายพรรค: ใช้พรรคล่าสุด และเก็บประวัติ', () => {
  const e1 = ev('s1', '2026-03-01', { p1: A, p2: A, p3: A, p4: A, q1: A, q2: A, q3: A });
  const e2 = ev('s2', '2026-04-01', { p1: A, p2: A, p3: A, p4: A, q1: A, q2: A, q3: A });
  e2.votes.find((v) => v.personId === 'p4').party = 'ตัวอย่างสอง';
  const r3 = compute({ ...raw, events: [e1, e1, e2].map((x, i) => ({ ...x, id: 'k' + i })) });
  const p4 = r3.mps.find((m) => m.id === 'p4');
  assert.equal(p4.party, 'พรรคตัวอย่างสอง');
  assert.ok(p4.partyHistory);
});

test('ประธานสภาไม่ถูกรวมในอัตราของพรรคและทั้งสภา', () => {
  const ppl = people.map((p) => (p.id === 'p1' ? { ...p, presiding: true } : p));
  const e = ev('pr', '2026-03-01', { p1: X, p2: A, p3: A, p4: A, q1: A, q2: A, q3: A });
  const r3 = compute({ ...raw, people: ppl, events: [e] });
  assert.equal(r3.houseRate, 100);
  assert.equal(r3.parties.find((p) => p.name === 'พรรคตัวอย่างหนึ่ง').rate, 100);
  assert.equal(r3.mps.find((m) => m.id === 'p1').rate, 0);
});

test('เสียงพรรคเสมอกัน ไม่นับการลงมติต่างจากพรรค', () => {
  const e = ev('tie', '2026-03-01', { p1: A, p2: A, p3: D, p4: D, q1: A, q2: A, q3: A });
  const r3 = compute({ ...raw, events: [e] });
  assert.equal(r3.mps.find((m) => m.id === 'p1').dissentBase, 0);
});
