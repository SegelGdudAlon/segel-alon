// שליחת התראות פוש על תג״ב של משימות (טבלת בו״ם / המשימות שלי).
// רץ פעם ביום מ-GitHub Actions (.github/workflows/notify.yml). לא צריך להריץ ידנית.
import admin from 'firebase-admin';

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
async function send(tokens, title, body){
  if(!tokens.length) return 0;
  if(DRY){ console.log('[DRY]', tokens.length, 'מכשירים:', title, '|', body); return tokens.length; }
  const webpush = { notification: Object.assign({ dir: 'rtl', lang: 'he' }, SITE ? { icon: SITE + 'icon-192.png', badge: SITE + 'badge-96.png' } : {}) };
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

main().catch(e => { console.error(e); process.exit(1); });
