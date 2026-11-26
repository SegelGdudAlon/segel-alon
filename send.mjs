// שליחת התראות פוש על תג״ב של משימות (טבלת בו״ם / המשימות שלי).
// רץ פעם ביום מ-GitHub Actions (.github/workflows/notify.yml). לא צריך להריץ ידנית.
import admin from 'firebase-admin';
import { makeDeriv, weekdayIL } from './deriv.mjs';

const SA = process.env.FIREBASE_SERVICE_ACCOUNT;
if(!SA){ console.error('חסר הסוד FIREBASE_SERVICE_ACCOUNT ב-GitHub (Settings ← Secrets and variables ← Actions).'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(SA)) });
const db = admin.firestore();
const fcm = admin.messaging();

const SITE = (u => u ? u.replace(/\/?$/, '/') : '')((process.env.SITE_URL || '').trim());
const TEST_EMAIL = (process.env.TEST_EMAIL || '').trim().toLowerCase();
const DRY = process.env.DRY_RUN === '1';

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());   // YYYY-MM-DD
const dayNum = s => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
const fmt = s => { const [y, m, d] = String(s).slice(0, 10).split('-'); return `${+d}.${+m}`; };

// מתי שולחים: יומיים לפני, יום לפני, ביום עצמו, ופעם אחת אחרי שהתג״ב עבר (עד 3 ימים אחורה, למקרה שריצה התפספסה)
function kindOf(days){
  if(days === 2) return 'd2';
  if(days === 1) return 'd1';
  if(days === 0) return 'd0';
  if(days < 0 && days >= -3) return 'late';
  return null;
}
const TITLE1 = { d2:'תג״ב בעוד יומיים', d1:'תג״ב מחר', d0:'תג״ב היום', late:'התג״ב עבר — המשימה לא בוצעה' };
const WHEN = { d2:'בעוד יומיים', d1:'מחר', d0:'היום', late:'באיחור' };
const BAD_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);

async function tokensOf(field, value){
  const q = await db.collection('push').where(field, '==', value).get();
  return q.docs.map(d => d.id);
}
async function send(tokens, title, body, tag){
  if(!tokens.length) return 0;
  if(DRY){ console.log('[DRY]', tokens.length, 'מכשירים:', title, '|', body); return tokens.length; }
  const webpush = { notification: Object.assign({ dir: 'rtl', lang: 'he' }, tag ? { tag } : {}, SITE ? { icon: SITE + 'icon-192.png', badge: SITE + 'badge-96.png' } : {}) };
  if(SITE.startsWith('https://')) webpush.fcmOptions = { link: SITE + '#general' };
  const res = await fcm.sendEachForMulticast({ tokens, notification: { title, body }, webpush });
  const dead = [];
  res.responses.forEach((r, i) => { if(!r.success){ console.warn('נכשל:', r.error && r.error.code); if(r.error && BAD_TOKEN.has(r.error.code)) dead.push(tokens[i]); } });
  await Promise.all(dead.map(t => db.doc('push/' + t).delete().catch(() => {})));
  if(dead.length) console.log('נמחקו', dead.length, 'מכשירים שכבר לא רשומים');
  return res.successCount;
}

async function main(){
  if(TEST_EMAIL){
    const tokens = await tokensOf('email', TEST_EMAIL);
    console.log(`בדיקה ל-${TEST_EMAIL}: ${tokens.length} מכשירים`);
    const n = await send(tokens, 'סגל אלון — בדיקה מהשרת', 'אם קיבלת את זה, ההתראות על תג״ב עובדות ✓');
    console.log('נשלח בהצלחה ל-', n);
    // בנוסף: תצוגה מקדימה של התראת הנגזרות שלו (אם הוא מפק״ץ / מ״פ / מג״ד / סמג״ד)
    await derivNotifications(TEST_EMAIL);
    return;
  }

  const bom = await db.collection('bom').get();
  const perMember = new Map();   // member → [{ b, kind, logId }]
  for(const d of bom.docs){
    const b = d.data();
    if(!b.due || b.status === 'done' || !Array.isArray(b.assignees) || !b.assignees.length) continue;
    const kind = kindOf(dayNum(b.due) - dayNum(today));
    if(!kind) continue;
    const logId = `${d.id}_${kind}_${String(b.due).slice(0, 10)}`;
    if((await db.doc('notifLog/' + logId).get()).exists) continue;     // כבר נשלח
    for(const m of b.assignees){
      if(!perMember.has(m)) perMember.set(m, []);
      perMember.get(m).push({ b, kind, logId });
    }
  }

  let sent = 0;
  const logs = new Set();
  for(const [member, items] of perMember){
    const tokens = await tokensOf('member', member);
    items.forEach(x => logs.add(x.logId));          // נרשם כנשלח גם למי שאין לו מכשיר, כדי לא לחזור על זה
    if(!tokens.length) continue;
    const order = { late:0, d0:1, d1:2, d2:3 };
    items.sort((a, c) => order[a.kind] - order[c.kind]);
    let title, body;
    if(items.length === 1){
      const { b, kind } = items[0];
      title = TITLE1[kind];
      body = `${b.title} · תג״ב ${fmt(b.due)}`;
    } else {
      const late = items.filter(x => x.kind === 'late').length;
      title = late ? `${items.length} משימות עם תג״ב קרוב (${late} באיחור)` : `${items.length} משימות עם תג״ב קרוב`;
      body = items.slice(0, 4).map(x => `• ${x.b.title} — ${WHEN[x.kind]}`).join('\n') + (items.length > 4 ? `\n+ עוד ${items.length - 4}` : '');
    }
    sent += await send(tokens, title, body);
  }
  if(!DRY) await Promise.all([...logs].map(id => db.doc('notifLog/' + id).set({ at: Date.now(), day: today })));
  console.log(`${today}: ${perMember.size} אנשי סגל עם משימות לתזכורת, ${sent} התראות נשלחו.`);
}

// ---------- נגזרות הדרכה ----------
const short = (t, n = 38) => t.length > n ? t.slice(0, n - 1) + '…' : t;
async function derivNotifications(onlyEmail){
  if(!onlyEmail && weekdayIL() === 'Sat'){ console.log('שבת — בלי התראות נגזרות'); return; }
  const [src, coh, cfg, memQ, drvQ] = await Promise.all([db.doc('deriv/source').get(), db.doc('app/cohorts').get(), db.doc('app/config').get(), db.collection('members').get(), db.collection('drv').get()]);
  const weeks = src.exists ? (src.data().weeks || []) : [];
  if(!weeks.length){ console.log('אין נגזרות — מדלג'); return; }
  const members = {}; memQ.docs.forEach(d => { members[d.id] = d.data(); });
  const drv = {}; drvQ.docs.forEach(d => { drv[d.id] = d.data(); });
  const D = makeDeriv({ weeks, members, drv, cohorts: coh.exists ? coh.data() : null, today });
  if(!D.cur){ console.log('היום לא בתוך אף שבוע בקובץ הנגזרות — מדלג'); return; }
  const nm = id => (members[id] || {}).name || '';
  const comps = [...new Set([...(((cfg.exists && cfg.data().companies) || [])), ...Object.values(members).map(m => m.company).filter(Boolean)])];

  // סטטוס לכל פלוגה + השוואה לאתמול
  const [yy, mm, dd] = today.split('-').map(Number);
  const yday = new Date(Date.UTC(yy, mm - 1, dd) - 864e5).toISOString().slice(0, 10);
  const status = {};
  for(const c of comps){
    const st = D.companyStatus(c); if(!st || !(st.allT)) continue;
    const snapId = `drvsnap_${Buffer.from(c).toString('hex')}_`;
    const prev = await db.doc('notifLog/' + snapId + yday).get();
    st.delta = prev.exists && prev.data().week === st.week ? st.allD - (prev.data().allD || 0) : null;
    status[c] = st;
    if(!DRY && !onlyEmail) await db.doc('notifLog/' + snapId + today).set({ week: st.week, allD: st.allD, dueD: st.dueD, dueT: st.dueT, at: Date.now(), day: today });
  }

  let sent = 0;
  for(const [uid, m] of Object.entries(members)){
    if(onlyEmail && String(m.email || '').toLowerCase() !== onlyEmail) continue;
    let title = null, body = null, kind = null;
    if(m.position === 'מפק״ץ' && m.company){
      const o = D.openFor(uid); const n = o.today.length + o.late.length;
      if(!n) continue;
      kind = 'mf';
      title = `נגזרות הדרכה: ${n} פתוחות אצלך`;
      const lines = [];
      if(o.today.length) lines.push('היום: ' + o.today.slice(0, 3).map(x => short(x.title)).join(' · ') + (o.today.length > 3 ? ` +${o.today.length - 3}` : ''));
      if(o.late.length) lines.push(`באיחור (${o.late.length}): ` + o.late.slice(0, 3).map(x => short(x.title)).join(' · ') + (o.late.length > 3 ? ` +${o.late.length - 3}` : ''));
      body = lines.join('\n');
    } else if(m.position === 'מ״פ' && m.company && status[m.company]){
      const st = status[m.company]; kind = 'mp';
      title = `נגזרות — פלוגה ${m.company}: ${st.pct}% מה שנדרש עד היום`;
      const lines = [`${st.weekName}: ${st.dueD}/${st.dueT} בוצעו עד היום` + (st.late ? ` · ${st.late} באיחור` : '') + ` · כל השבוע ${st.allD}/${st.allT}`];
      if(st.delta) lines.push(`${st.delta > 0 ? '+' : ''}${st.delta} סומנו מאתמול`);
      if(st.laggards.length) lines.push('הכי הרבה פתוחים: ' + st.laggards.map(x => `${nm(x.id)} (${x.k})`).join(', '));
      body = lines.join('\n');
    } else if(['מג״ד','סמג״ד'].includes(m.position) && Object.keys(status).length){
      kind = 'bn';
      const cs = Object.entries(status);
      const tot = cs.reduce((a, [, s]) => (a.d += s.dueD, a.t += s.dueT, a), { d: 0, t: 0 });
      title = `נגזרות — גדוד: ${tot.t ? Math.round(tot.d * 100 / tot.t) : 100}% מה שנדרש עד היום`;
      body = cs.map(([c, s]) => `פלוגה ${c}: ${s.pct}%` + (s.late ? ` (${s.late} באיחור)` : '') + (s.delta ? ` ${s.delta > 0 ? '+' : ''}${s.delta}` : '')).join(' · ');
    } else continue;
    const logId = `drv${kind}_${uid}_${today}`;
    if(!onlyEmail && (await db.doc('notifLog/' + logId).get()).exists) continue;
    const tokens = await tokensOf('member', uid);
    if(!onlyEmail && !DRY) await db.doc('notifLog/' + logId).set({ at: Date.now(), day: today });
    if(!tokens.length) continue;
    sent += await send(tokens, title, body, 'segel-deriv-' + kind);
  }
  console.log(`נגזרות: ${sent} התראות נשלחו (שבוע ${D.cur.n}).`);
}

async function all(){
  await main();
  if(!TEST_EMAIL) await derivNotifications(null);
}
all().catch(e => { console.error(e); process.exit(1); });
