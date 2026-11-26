// שכבת חיבור ל-Firebase: מספקת לאתר את אותו ממשק (window.claude.use) שהיה לו בתוך Claude,
// כך ששאר הקוד לא תלוי בשירות שמאחוריו. התחברות: חשבון Google. נתונים: Firestore.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, getRedirectResult, onAuthStateChanged, signOut }
  from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { initializeFirestore, doc, collection, getDoc, getDocs, setDoc, deleteDoc, onSnapshot }
  from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const CFG = window.APP_CONFIG || {};
const RT = window.__rt;                       // הוגדר ב-index.html לפני הטעינה
const OWNERS = (CFG.ownerEmails || []).map(e => String(e).trim().toLowerCase());

if(!CFG.firebase || !CFG.firebase.apiKey || CFG.firebase.apiKey === 'PASTE_HERE'){
  RT.fail('האתר עדיין לא הוגדר: צריך למלא את פרטי Firebase בקובץ firebase-config.js.');
  throw new Error('not configured');
}

const app = initializeApp(CFG.firebase);
const auth = getAuth(app);
const fs = initializeFirestore(app, { ignoreUndefinedProperties: true });
const ME = { uid:null, appId:null, email:'', name:'', photo:'', owner:false };

/* ---------- שגיאות ---------- */
function errOf(e){
  if(e && e.code && !String(e.code).includes('-') && e.code !== 'unavailable') return e;   // כבר בפורמט שלנו
  const c = e && e.code;
  const code = c === 'permission-denied' ? 'invalid_argument'
    : c === 'resource-exhausted' ? 'resource_exhausted'
    : c === 'invalid-argument' ? 'invalid_argument' : 'unavailable';
  return { code, message: (e && e.message) || String(e), heb: e && e.heb };
}
const wrapDoc = s => ({ id:s.id, exists:s.exists(), data:() => s.exists() ? s.data() : undefined,
  metadata:{ fromCache:s.metadata.fromCache, hasPendingWrites:s.metadata.hasPendingWrites } });
const wrapQ = s => ({ docs:s.docs.map(wrapDoc), size:s.size, empty:s.empty,
  metadata:{ fromCache:s.metadata.fromCache, hasPendingWrites:s.metadata.hasPendingWrites },
  docChanges:() => s.docChanges().map(ch => ({ type:ch.type, doc:wrapDoc(ch.doc), oldIndex:ch.oldIndex, newIndex:ch.newIndex })) });

/* ---------- אינדקס מיילים: מקשר חשבון Google לכרטיס איש הסגל ---------- */
const normEmail = e => String(e || '').trim().toLowerCase();
async function syncEmailIndex(memberId, oldEmail, newEmail){
  oldEmail = normEmail(oldEmail); newEmail = normEmail(newEmail);
  if(oldEmail === newEmail) return;
  if(oldEmail){
    const o = await getDoc(doc(fs, 'emails', oldEmail));
    if(o.exists() && o.data().appId === memberId) await deleteDoc(doc(fs, 'emails', oldEmail));
  }
  if(newEmail) await setDoc(doc(fs, 'emails', newEmail), { appId: memberId });
}
async function checkEmailFree(memberId, email){
  email = normEmail(email); if(!email) return;
  const s = await getDoc(doc(fs, 'emails', email));
  if(s.exists() && s.data().appId !== memberId){
    const other = await getDoc(doc(fs, 'members', s.data().appId)).catch(() => null);
    if(other && other.exists()) throw { code:'taken', heb:'המייל הזה כבר משויך לאיש סגל אחר (' + (other.data().name || '') + ').' };
  }
}

/* ---------- מסד נתונים ---------- */
function mkDoc(path){
  const r = doc(fs, path);
  const isMember = /^members\/[^/]+$/.test(path);
  const run = async fn => { try { return await fn(); } catch(e){ console.warn(path, e); throw errOf(e); } };
  return { id:r.id, path,
    get: () => run(async () => wrapDoc(await getDoc(r))),
    set: data => run(async () => {
      let old = null;
      if(isMember){ await checkEmailFree(r.id, data.email); old = await getDoc(r); }
      await setDoc(r, data);
      if(isMember) await syncEmailIndex(r.id, old && old.exists() ? old.data().email : '', data.email);
    }),
    update: data => run(async () => {
      const s = await getDoc(r);
      if(!s.exists()) throw { code:'invalid_argument', message:'document does not exist' };
      if(isMember && 'email' in data) await checkEmailFree(r.id, data.email);
      await setDoc(r, data, { merge:true });
      if(isMember && 'email' in data) await syncEmailIndex(r.id, s.data().email, data.email);
    }),
    delete: () => run(async () => {
      if(isMember){ const s = await getDoc(r); if(s.exists()) await syncEmailIndex(r.id, s.data().email, ''); }
      await deleteDoc(r);
    }),
    onSnapshot: (next, err) => onSnapshot(r, s => next(wrapDoc(s)), e => { console.warn(path, e); err && err(errOf(e)); }),
    collection: p => mkCol(path + '/' + p),
  };
}
// מי שעדיין לא אושר כאיש סגל לא יכול לקרוא את כל הרשימה — מקבל רק את הכרטיס/הבקשה שלו
const OWN_ONLY_FALLBACK = ['members', 'requests'];
function mkCol(path){
  const c = collection(fs, path);
  return { path,
    doc: id => mkDoc(path + '/' + (id || doc(c).id)),
    add: async data => { const ref = mkDoc(path + '/' + doc(c).id); await ref.set(data); return ref; },
    get: async () => { try { return wrapQ(await getDocs(c)); } catch(e){ throw errOf(e); } },
    onSnapshot: (next, err) => {
      let unsub = onSnapshot(c, s => next(wrapQ(s)), e => {
        if(e && e.code === 'permission-denied' && OWN_ONLY_FALLBACK.includes(path) && ME.appId){
          unsub = onSnapshot(doc(fs, path, ME.appId), s => {
            const d = wrapDoc(s), docs = d.exists ? [d] : [];
            next({ docs, size:docs.length, empty:!docs.length, metadata:d.metadata, docChanges:() => [] });
          }, e2 => err && err(errOf(e2)));
        } else { console.warn(path, e); err && err(errOf(e)); }
      });
      return () => unsub();
    },
  };
}
const DB = { doc: mkDoc, collection: mkCol };

/* ---------- משתמש ---------- */
const USER = {
  me: async () => ({ id:ME.appId, name:ME.name, email:ME.email, isOwner:ME.owner, canEdit:ME.owner, avatarUrl:ME.photo, color:'#2c5f45' }),
  id: async () => ME.appId,
  isOwner: async () => ME.owner,
  canEdit: async () => ME.owner,
  can: async () => null,
  name: async () => ME.name,
  email: async () => ME.email,
  avatarUrl: async () => ME.photo || null,
  profiles: async ids => Object.fromEntries([].concat(ids || []).map(i => [i, { id:i, name:'', avatarUrl:'', color:'#888', email:null, isMe:i === ME.appId, guest:false }])),
  search: async () => [],
};

/* ---------- הורדת קבצים ---------- */
const DOWNLOADS = {
  save: async ({ filename, data }) => {
    const blob = data instanceof Blob ? data : new Blob([data], { type: /\.csv$/i.test(filename) ? 'text/csv;charset=utf-8' : 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return { status:'saved' };
  },
};

/* ---------- התחברות ---------- */
window.appSignOut = async () => { await signOut(auth); location.reload(); };
async function doSignIn(){
  const p = new GoogleAuthProvider(); p.setCustomParameters({ prompt:'select_account' });
  try { await signInWithPopup(auth, p); }
  catch(e){
    const c = e && e.code;
    if(c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request') return;
    if(c === 'auth/popup-blocked') return RT.signinError('הדפדפן חסם את חלון ההתחברות. לחצו שוב על הכפתור. אם זה חוזר — אפשרו חלונות קופצים לאתר, או פתחו אותו ב-Safari / Chrome.', true);
    if(c === 'auth/operation-not-supported-in-environment' || c === 'auth/web-storage-unsupported' || c === 'auth/internal-error')
      return RT.signinError('הדפדפן הזה לא תומך בכניסה עם Google. העתיקו את הקישור ופתחו אותו ב-Safari או ב-Chrome.', true);
    if(c === 'auth/unauthorized-domain') return RT.signinError('הכתובת של האתר לא אושרה ב-Firebase (Authentication ← Settings ← Authorized domains).');
    if(c === 'auth/network-request-failed') return RT.signinError('אין חיבור לאינטרנט. בדקו את החיבור ונסו שוב.');
    RT.signinError('ההתחברות נכשלה (' + (c || e) + '). נסו לפתוח את הקישור ב-Safari או ב-Chrome.', true);
  }
}
// כניסה ישנה בהפניה (redirect) — רק כדי לנקות מצב שנשאר מגרסה קודמת
getRedirectResult(auth).catch(() => {});

/* ---------- התראות פוש (Firebase Cloud Messaging) ---------- */
const MSG_URL = 'https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js';
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let msgMod = null, messaging = null;
async function msgReady(){
  if(messaging) return messaging;
  msgMod = msgMod || await import(MSG_URL);
  if(!(await msgMod.isSupported())) return null;
  messaging = msgMod.getMessaging(app);
  msgMod.onMessage(messaging, p => {            // הודעה שמגיעה כשהאתר פתוח
    const n = (p && p.notification) || {};
    if(window.toast) window.toast((n.title ? n.title + ' — ' : '') + (n.body || ''));
  });
  return messaging;
}
async function swReg(){
  return navigator.serviceWorker.register('./firebase-messaging-sw.js', { scope:'./' });
}
const PUSH_LS = 'segel-push-token';
async function saveToken(token){
  await setDoc(doc(fs, 'push', token), { member: ME.appId, email: ME.email, at: Date.now(),
    device: (isIOS ? 'iOS' : /Android/.test(navigator.userAgent) ? 'Android' : 'מחשב') + (isStandalone() ? ' · אפליקציה' : '') });
  try { localStorage.setItem(PUSH_LS, token); } catch(_){}
}
const PUSH = {
  configured: () => !!CFG.vapidKey,
  isIOS, isStandalone,
  async supported(){
    if(!('serviceWorker' in navigator) || !('Notification' in window) || !('PushManager' in window)) return false;
    try { return !!(await msgReady()); } catch(_){ return false; }
  },
  permission: () => ('Notification' in window) ? Notification.permission : 'unsupported',
  enabledHere(){ try { return !!localStorage.getItem(PUSH_LS) && PUSH.permission() === 'granted'; } catch(_){ return false; } },
  // חייב להיקרא מלחיצה של המשתמש
  async enable(){
    if(!CFG.vapidKey) throw { heb:'ההתראות עדיין לא הוגדרו באתר (חסר vapidKey בקובץ firebase-config.js).' };
    const perm = await Notification.requestPermission();
    if(perm !== 'granted') throw { heb: perm === 'denied' ? 'ההתראות חסומות לאתר הזה. צריך לאפשר אותן בהגדרות הדפדפן / הטלפון.' : 'לא אושרו התראות.' };
    const m = await msgReady(); if(!m) throw { heb:'הדפדפן הזה לא תומך בהתראות.' };
    const reg = await swReg();
    const token = await msgMod.getToken(m, { vapidKey: CFG.vapidKey, serviceWorkerRegistration: reg });
    if(!token) throw { heb:'לא התקבל אישור מהשרת של Google. נסו שוב.' };
    await saveToken(token);
    return true;
  },
  async disable(){
    let t = null; try { t = localStorage.getItem(PUSH_LS); localStorage.removeItem(PUSH_LS); } catch(_){}
    try { const m = await msgReady(); if(m) await msgMod.deleteToken(m); } catch(_){}
    if(t) try { await deleteDoc(doc(fs, 'push', t)); } catch(_){}
  },
  async test(){
    const reg = await swReg();
    await reg.showNotification('סגל אלון — בדיקה', { body:'ככה תיראה התראה על תג״ב שמתקרב.', icon:'icon-192.png', badge:'badge-96.png', lang:'he', dir:'rtl' });
  }
};
window.__push = PUSH;
// רענון שקט של הטוקן (גוגל מחליפה אותו מדי פעם)
async function refreshPush(){
  try {
    if(!CFG.vapidKey || !PUSH.enabledHere()) return;
    const m = await msgReady(); if(!m) return;
    const token = await msgMod.getToken(m, { vapidKey: CFG.vapidKey, serviceWorkerRegistration: await swReg() });
    const old = localStorage.getItem(PUSH_LS);
    if(token && token !== old){ if(old) deleteDoc(doc(fs, 'push', old)).catch(() => {}); }
    if(token) await saveToken(token);
  } catch(e){ console.warn('push refresh', e); }
}

let started = false;
onAuthStateChanged(auth, async u => {
  if(started){ if(!u || u.uid !== ME.uid) location.reload(); return; }
  if(!u){ RT.showSignIn(doSignIn); return; }
  started = true;
  ME.uid = u.uid; ME.email = normEmail(u.email); ME.name = u.displayName || ''; ME.photo = u.photoURL || '';
  ME.owner = OWNERS.includes(ME.email);
  ME.appId = u.uid;
  try { const m = await getDoc(doc(fs, 'emails', ME.email)); if(m.exists() && m.data().appId) ME.appId = m.data().appId; }
  catch(e){ console.warn('emails lookup', e); }
  RT.ready({ db:DB, user:USER, downloads:DOWNLOADS, assets:null, mcp:null });
  setTimeout(refreshPush, 3000);
});
