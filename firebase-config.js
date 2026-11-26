// ============================================================
//  הגדרות האתר — זה הקובץ היחיד שצריך לערוך בהתקנה
// ============================================================
window.APP_CONFIG = {
  // 1) מ-Firebase: Project settings ← General ← Your apps ← SDK setup and configuration ← Config
  firebase: {
    apiKey: "AIzaSyDJgExii2A-WZnHGKUVG0cn53_0gHeHyjY",
    authDomain: "segel-alon.firebaseapp.com",
    projectId: "segel-alon",
    storageBucket: "segel-alon.firebasestorage.app",
    messagingSenderId: "604320639422",
    appId: "1:604320639422:web:f98e3f43f2b95b6eb5b1ef"
  },

  // 2) מיילים של "בעלי האתר" — תמיד מנהלים, גם אם משהו השתבש בהרשאות.
  //    חייבים להיות זהים לרשימה בקובץ firestore.rules
  ownerEmails: ["romegido@gmail.com", "segelgdudalon@gmail.com"],

  // 3) (לא חובה) מפתח API לקריאת קובץ הנגזרות מ-Google Sheets — ראו מדריך שלב 7.
  //    בלי מפתח: מנהל מעלה את קובץ האקסל ידנית מתוך האתר.
  sheetsApiKey: "AIzaSyCzd7lu6SUylluG_cBemb43nQBhUPhEIRQ"

  vapidKey: "BOpPnqhd-DZtuR0FlcSwLEkcW_eRlpedf7AFGWu3okZ1qjU8Av1ObPhJFfXmUKnl9HuIg719i4pb56XG3jNaIwo"
};
