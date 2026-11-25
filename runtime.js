// שכבת חיבור ל-Firebase: מספקת לאתר את אותו ממשק (window.claude.use) שהיה לו בתוך Claude,
// כך ששאר הקוד לא תלוי בשירות שמאחוריו. התחברות: חשבון Google. נתונים: Firestore.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut }
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
    if(e && ['auth/popup-blocked','auth/operation-not-supported-in-environment','auth/cancelled-popup-request'].includes(e.code)) return signInWithRedirect(auth, p);
    if(e && e.code === 'auth/popup-closed-by-user') return;
    if(e && e.code === 'auth/unauthorized-domain') return RT.signinError('הכתובת של האתר לא אושרה ב-Firebase (Authentication ← Settings ← Authorized domains).');
    RT.signinError('ההתחברות נכשלה: ' + (e && e.code || e));
  }
}
getRedirectResult(auth).catch(e => console.warn(e));

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
});
