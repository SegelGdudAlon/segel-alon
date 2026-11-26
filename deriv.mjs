// התראות על נגזרות הדרכה — מפק״צים (מה פתוח אצלם), מ״פים (סטטוס פלוגתי), מג״ד/סמג״ד (סטטוס גדודי).
//
// ⚠️ הלוגיקה כאן היא העתק של פונקציות הנגזרות ב-index.html (derivWeekItems, applyAssign, roleHolders,
//    drvState, weekDate ועוד). אם משנים שם את אופן חישוב המשימות / השיוך / מזהי המסמכים — לעדכן גם כאן.

// אותה רשימת נע״תים כמו NETS ב-index.html (צריך רק id ושם, לזיהוי "(מפק״צ <נע״ת>)" בקובץ)
const NETS = [
  ['ag','א״ג'], ['chinuch','חינוך'], ['yazamut','יזמות'], ['dat','דת'], ['logistics','לוגיסטיקה'],
  ['shetach','שטח ואימונים'], ['miktzoa','מקצוע צבאי'], ['nivutim','ניווטים'], ['hadracha','הדרכה'],
  ['simulations','סימולציות'], ['bchanim','בחנים'],
].map(([id, name]) => ({ id, name }));
const DERIV_SHARED_CATS = ['אירוע','מבחן/מטלה'];
const DAY_ORDER = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];

const normQ = s => String(s||'').replace(/[״”“]/g,'"').replace(/[׳’‘]/g,"'").replace(/''/g,'"').replace(/\s+/g,' ').trim();
function hkey(s){ let x = 5381; for(const ch of String(s)) x = ((x*33) ^ ch.charCodeAt(0)) >>> 0; return x.toString(36); }
const NET_BY_NORM = Object.fromEntries(NETS.map(n => [normQ(n.name), n]));
function parseBrackets(text){
  const role = [];
  for(const m of String(text).matchAll(/\(([^)]*)\)/g)){
    const b = normQ(m[1]);
    const mf = b.match(/^מפק"?[צץ]\s+(.+)$/);
    if(mf && NET_BY_NORM[normQ(mf[1])]) role.push({ type:'net', net:NET_BY_NORM[normQ(mf[1])].id, raw:m[0] });
    else if(/^מ"פ$/.test(b)) role.push({ type:'mp', raw:m[0] });
  }
  return { role: role[0] || null };
}
function baseItems(w){
  if(!w || !w.items) return [];
  return w.items.map(it => {
    const { role } = parseBrackets(it.text);
    const shared = DERIV_SHARED_CATS.includes(normQ(it.cat));
    const title = role ? it.text.replace(role.raw,'').replace(/\s{2,}/g,' ').trim() : it.text;
    const days = (it.days||[]).slice().sort((a,b)=>DAY_ORDER.indexOf(a)-DAY_ORDER.indexOf(b));
    return { key: hkey(`${w.n}|${it.cat}|${it.text}|${(it.days||[]).join(',')}`), cat:it.cat, title, role, days, company: shared || !!role };
  });
}

// מספר יום (UTC) מתאריך
const dnum = (y, m, d) => Date.UTC(y, m - 1, d) / 864e5;
export const todayIL = () => new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Jerusalem' }).format(new Date());
export const weekdayIL = () => new Intl.DateTimeFormat('en-US', { timeZone:'Asia/Jerusalem', weekday:'short' }).format(new Date());

export function makeDeriv({ weeks, members, drv, cohorts, today }){
  const [ty, tm, td] = today.split('-').map(Number);
  const T = dnum(ty, tm, td);
  const coh = cohorts || {};
  const prefix = (coh.current || 'alon6') === (coh.legacy || 'alon6') ? '' : 'k_' + coh.current + '_';
  const M = members;   // { id: member }
  const staff = comp => Object.keys(M).filter(id => comp && M[id].company === comp);
  const mafkatzim = comp => staff(comp).filter(id => M[id].position === 'מפק״ץ');
  const inNet = (id, net) => !!((M[id] || {}).nets || {})[net];
  const compDoc = (comp, n) => prefix + 'c_' + hkey(comp) + '_w' + n;
  const persDoc = (uid, n) => prefix + 'p_' + uid + '_w' + n;
  const asgDoc  = (comp, n) => prefix + 'a_' + hkey(comp) + '_w' + n;

  // תאריך (מספר יום) של יום בשבוע — השנה הקרובה ביותר להיום, כמו weekDate באתר
  function dayOf(w, day){
    const s = (w.dates || {})[day]; const m = String(s || '').match(/^(\d{1,2})\.(\d{1,2})$/); if(!m) return null;
    let best = null;
    for(const y of [ty - 1, ty, ty + 1]){ const v = dnum(y, +m[2], +m[1]); if(best === null || Math.abs(v - T) < Math.abs(best - T)) best = v; }
    return best;
  }
  function items(w, comp){
    const A = ((drv[asgDoc(comp, w.n)] || {}).items) || {};
    return baseItems(w).map(it => {
      const a = A[it.key]; if(!a || !a.mode) return it;
      const o = Object.assign({}, it);
      if(a.mode === 'all'){ o.company = true; o.role = null; }
      else if(a.mode === 'each'){ o.company = false; o.role = null; }
      else if(a.mode === 'one' && a.uid){ o.company = true; o.role = { type:'one', uid:a.uid }; }
      return o;
    });
  }
  function holders(it, comp){
    if(!it.role) return [];
    if(it.role.type === 'net') return mafkatzim(comp).filter(id => inNet(id, it.role.net));
    if(it.role.type === 'mp') return staff(comp).filter(id => M[id].position === 'מ״פ');
    if(it.role.type === 'one') return [it.role.uid];
    return [];
  }
  function done(it, n, comp, uid){
    const id = it.company ? compDoc(comp, n) : persDoc(uid, n);
    const x = ((drv[id] || {}).items || {})[it.key];
    return !!(x && x.done);
  }
  const dueOf = (w, it) => { const ds = it.days.map(d => dayOf(w, d)).filter(v => v !== null); return ds.length ? Math.max(...ds) : null; };
  const sorted = (weeks || []).slice().sort((a, b) => (a.n || 0) - (b.n || 0));
  // השבוע הנוכחי ושבוע קודם (איחורים מהשבוע שעבר עדיין רלוונטיים)
  const curIdx = sorted.findIndex(w => { const a = dayOf(w, 'ראשון'), b = dayOf(w, 'שבת'); return a !== null && b !== null && T >= a && T <= b; });
  const cur = curIdx >= 0 ? sorted[curIdx] : null;
  const recent = curIdx >= 0 ? sorted.slice(Math.max(0, curIdx - 1), curIdx + 1) : [];

  // משימות פתוחות ששייכות למפק״ץ: אישיות (כל מפק״ץ בנפרד), תפקיד שהוא מחזיק בו, או שויכו אליו ידנית
  function openFor(uid){
    const comp = (M[uid] || {}).company; if(!comp) return { today:[], late:[] };
    const out = { today:[], late:[] };
    recent.forEach(w => items(w, comp).forEach(it => {
      let mine;
      if(it.role && it.role.type === 'one') mine = it.role.uid === uid;
      else if(!it.company) mine = true;
      else if(it.role) mine = holders(it, comp).includes(uid);
      else mine = false;                                   // משימה משותפת לכל הסגל — מדווחת למ״פ
      if(!mine || done(it, w.n, comp, uid)) return;
      const due = dueOf(w, it); if(due === null) return;
      if(due === T) out.today.push(it); else if(due < T) out.late.push(it);
    }));
    return out;
  }
  // סטטוס פלוגתי לשבוע הנוכחי: מה שהיה אמור להיות בוצע עד היום, וכל השבוע
  function companyStatus(comp){
    if(!cur) return null;
    const its = items(cur, comp), mfs = mafkatzim(comp);
    let dueT = 0, dueD = 0, allT = 0, allD = 0; const lag = {};
    its.forEach(it => {
      const due = dueOf(cur, it), isDue = due !== null && due <= T;
      const units = it.company ? [null] : mfs;
      units.forEach(uid => {
        const d = done(it, cur.n, comp, uid);
        allT++; if(d) allD++;
        if(isDue){ dueT++; if(d) dueD++; else if(uid) lag[uid] = (lag[uid] || 0) + 1; }
      });
    });
    const laggards = Object.entries(lag).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, k]) => ({ id, k }));
    return { week: cur.n, weekName: cur.name || ('שבוע ' + cur.n), dueT, dueD, allT, allD, late: dueT - dueD, pct: dueT ? Math.round(dueD * 100 / dueT) : 100, laggards };
  }
  return { cur, openFor, companyStatus, staff, mafkatzim, items, done, holders };
}
