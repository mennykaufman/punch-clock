import { SHIFT_CATALOG, matchShiftByClockIn, matchShiftByActualEnd } from "./data/shifts.js";
import { calculatePay, isProductivityBonusEligible, BASE_WAGE_ILS } from "./data/payRules.js";
import {
  fetchUserData,
  saveUserData,
  subscribeToUserData,
  signInWithGoogle,
  onAuthChange,
  signOutUser,
  deleteUserAccount,
  logAnalyticsEvent,
} from "./data/cloud.js";

function defaultState(employmentStartDate = "", idfBonusPercent = 0) {
  return {
    seq: 0, // bumped on every local save so a late/out-of-order cloud snapshot can never clobber a newer local change
    settings: {
      employmentStartDate,
      idfBonusPercent, // 0 = not eligible, else 2 or 3
      productivityBonusOverride: null, // null = auto (3-month rule), true/false = manual override
      baseWageILS: BASE_WAGE_ILS,
      remindPointsOnClockOut: true,
      trackShiftType: false, // optional per-user: tag each shift with a station/role
      theme: "system", // "system" | "dark" | "light"
      monthlyHoursGoal: 0, // 0 = no goal set
      moreWidgets: { hours: true, shifts: true, pay: true, averages: true, luba: true, export: true },
    },
    currentPunch: null, // { clockInISO, shift: {start,end,vouchers,points} }
    punches: [], // completed punches
    cafeteriaSpending: [], // { id, timestampISO, pointsSpent, note }
  };
}

function localCacheKey(uidKey) {
  return `punchclock_state_${uidKey}`;
}

function loadLocalCache(uidKey) {
  const raw = localStorage.getItem(localCacheKey(uidKey));
  return raw ? JSON.parse(raw) : null;
}

function saveLocalCache(uidKey, data) {
  localStorage.setItem(localCacheKey(uidKey), JSON.stringify(data));
}

let currentUid = null; // the signed-in Google account's uid — the Firestore document key
let currentUserLabel = ""; // email/name, for display only
let state = null;
let unsubscribeCloud = null;
let applyingRemoteUpdate = false;

function saveState() {
  if (!currentUid) return;
  if (!applyingRemoteUpdate) state.seq = (state.seq || 0) + 1;
  saveLocalCache(currentUid, state);
  if (!applyingRemoteUpdate) {
    saveUserData(currentUid, state).catch((err) => {
      console.error("cloud save failed:", err);
      // Offline: Firestore's own local cache queues this write and retries
      // automatically once the connection comes back, so nothing else to do here.
    });
  }
}

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

// Guards against a Firestore call hanging forever (observed when logging back in shortly
// after logging out, mid-subscription-teardown) — without this, the login button would be
// stuck indefinitely with no way to recover short of reloading the page.
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

// ---------- auth / session ----------

const splashScreen = document.getElementById("splash-screen");
const loginScreen = document.getElementById("login-screen");
const appShell = document.getElementById("app-shell");
const loginError = document.getElementById("login-error");
const btnGoogleSignIn = document.getElementById("btn-google-signin");
const googleSignInCard = document.getElementById("google-signin-card");
const tosCheckbox = document.getElementById("tos-checkbox");
const btnViewTos = document.getElementById("btn-view-tos");
const welcomeCard = document.getElementById("welcome-card");
const welcomeEmploymentStartDate = document.getElementById("welcome-employment-start-date");
const welcomeIdfEligible = document.getElementById("welcome-idf-eligible");
const welcomeIdfPercent = document.getElementById("welcome-idf-percent");
const welcomeMigrateId = document.getElementById("welcome-migrate-id");
const welcomeMigratePin = document.getElementById("welcome-migrate-pin");
const welcomeError = document.getElementById("welcome-error");
const btnWelcomeContinue = document.getElementById("btn-welcome-continue");

function showLoginScreen() {
  splashScreen.hidden = true;
  loginScreen.hidden = false;
  appShell.hidden = true;
  googleSignInCard.hidden = false;
  welcomeCard.hidden = true;
}

function showWelcomeCard() {
  splashScreen.hidden = true;
  loginScreen.hidden = false;
  googleSignInCard.hidden = true;
  welcomeCard.hidden = false;
}

function showAppShell() {
  splashScreen.hidden = true;
  loginScreen.hidden = true;
  appShell.hidden = false;
}

// Subscribes to this account's cloud document so changes made on any other
// device show up here automatically too.
function startCloudSync(uidKey) {
  if (unsubscribeCloud) unsubscribeCloud();
  unsubscribeCloud = subscribeToUserData(uidKey, (data) => {
    // A snapshot can arrive late/out-of-order relative to our own rapid local
    // writes (e.g. clock-in immediately followed by an edit); only accept it
    // if it isn't older than what we already have, so it can never clobber a
    // newer local change with stale data (from this device or another one).
    if ((data.seq || 0) < (state?.seq || 0)) return;

    applyingRemoteUpdate = true;
    state = data;
    saveLocalCache(uidKey, state);
    renderHome();
    renderHistory();
    renderCafeteria();
    renderSettings();
    applyingRemoteUpdate = false;
  });
}

tosCheckbox.addEventListener("change", () => {
  btnGoogleSignIn.disabled = !tosCheckbox.checked;
});

btnViewTos.addEventListener("click", openTermsModal);

btnGoogleSignIn.addEventListener("click", async () => {
  loginError.textContent = "";
  btnGoogleSignIn.disabled = true;
  btnGoogleSignIn.textContent = "Signing in…";
  try {
    const user = await signInWithGoogle(); // opens a popup; resolves once the user picks an account
    await handleAuthenticatedUser(user);
  } catch (err) {
    console.error("google sign-in failed:", err);
    loginError.textContent = err?.code === "auth/popup-closed-by-user"
      ? "Sign-in was closed before finishing — try again."
      : "Couldn't sign in with Google. Try again.";
  } finally {
    btnGoogleSignIn.disabled = !tosCheckbox.checked;
    btnGoogleSignIn.textContent = "Sign in with Google";
  }
});

welcomeIdfEligible.addEventListener("change", () => {
  welcomeIdfPercent.hidden = !welcomeIdfEligible.checked;
});

btnWelcomeContinue.addEventListener("click", async () => {
  welcomeError.textContent = "";
  btnWelcomeContinue.disabled = true;
  btnWelcomeContinue.textContent = "Setting up…";
  try {
    const idfBonusPercent = welcomeIdfEligible.checked ? Number(welcomeIdfPercent.value) : 0;
    const newState = defaultState(welcomeEmploymentStartDate.value, idfBonusPercent);

    const migrateId = welcomeMigrateId.value.trim();
    const migratePin = welcomeMigratePin.value.trim();
    if (migrateId && migratePin) {
      const oldData = await withTimeout(fetchUserData(migrateId), 10000, "timed out fetching old account");
      if (!oldData || oldData.pin !== migratePin) {
        welcomeError.textContent = "Couldn't find that old Work ID + PIN — check them, or leave both blank to skip.";
        return;
      }
      // Bring over the real shift/spending history; keep the fresh settings just entered above.
      newState.punches = oldData.punches || [];
      newState.cafeteriaSpending = oldData.cafeteriaSpending || [];
      newState.currentPunch = oldData.currentPunch || null;
    }

    await withTimeout(saveUserData(currentUid, newState), 10000, "timed out creating account");
    state = newState;
    saveLocalCache(currentUid, state);
    startCloudSync(currentUid);
    showAppShell();
    renderHome();
    logAnalyticsEvent("sign_up", { method: "google" });
  } catch (err) {
    console.error("welcome setup failed:", err);
    welcomeError.textContent = "Couldn't reach the server — check your internet connection and try again.";
  } finally {
    btnWelcomeContinue.disabled = false;
    btnWelcomeContinue.textContent = "Continue";
  }
});

async function handleAuthenticatedUser(user) {
  currentUid = user.uid;
  currentUserLabel = user.email || user.displayName || user.uid;
  try {
    const existing = await withTimeout(fetchUserData(user.uid), 10000, "timed out fetching account");
    if (existing) {
      state = existing;
      saveLocalCache(currentUid, state);
      startCloudSync(currentUid);
      showAppShell();
      renderHome();
      logAnalyticsEvent("login", { method: "google" });
    } else {
      showWelcomeCard();
    }
  } catch (err) {
    console.error("post sign-in check failed:", err);
    // Offline (or the server just timed out) but this device has signed in before —
    // fall back to the last-synced local copy instead of blocking the user out
    // entirely. It'll pick back up with the cloud once startCloudSync gets a connection.
    const cached = loadLocalCache(user.uid);
    if (cached) {
      state = cached;
      startCloudSync(currentUid);
      showAppShell();
      renderHome();
    } else {
      loginError.textContent = "Couldn't reach the server — check your internet connection and try again.";
      showLoginScreen();
    }
  }
}

function handleLogout() {
  if (unsubscribeCloud) unsubscribeCloud();
  unsubscribeCloud = null;
  if (clockTimerInterval) {
    clearInterval(clockTimerInterval);
    clockTimerInterval = null;
  }
  currentUid = null;
  currentUserLabel = "";
  state = null;
  loginError.textContent = "";
  signOutUser().catch(() => {});
  showLoginScreen();
}

function boot() {
  onAuthChange((user) => {
    if (user) {
      handleAuthenticatedUser(user);
    } else if (!state) {
      showLoginScreen();
    }
  });
}

// ---------- formatting helpers ----------

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function formatDate(date) {
  return date.toLocaleDateString([], { day: "2-digit", month: "short" });
}
function formatILS(n) {
  return `₪${n.toFixed(2)}`;
}
function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const pad = (n) => String(n).padStart(2, "0");
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
function sameMonth(dateA, dateB) {
  return dateA.getFullYear() === dateB.getFullYear() && dateA.getMonth() === dateB.getMonth();
}
function sameDay(dateA, dateB) {
  return sameMonth(dateA, dateB) && dateA.getDate() === dateB.getDate();
}
function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

// ---------- navigation ----------

const SCREENS = ["home", "history", "cafeteria", "settings"];
const TITLES = { home: "TrackO'clock", history: "Monthly Attendance", cafeteria: "Luba", settings: "Settings" };

function showScreen(name) {
  for (const s of SCREENS) {
    document.getElementById(`screen-${s}`).hidden = s !== name;
  }
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.nav === name);
  });
  document.getElementById("topbar-title").textContent = TITLES[name];
  document.getElementById("topbar-subtitle").hidden = name !== "home";
  logAnalyticsEvent("screen_view", { firebase_screen: name });
  if (name === "history") renderHistory();
  if (name === "cafeteria") renderCafeteria();
  if (name === "settings") renderSettings();
}

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => showScreen(btn.dataset.nav));
});

// ---------- modal ----------

const modalBackdrop = document.getElementById("modal-backdrop");
const modalTitle = document.getElementById("modal-title");
const modalBody = document.getElementById("modal-body");
const modalActions = document.getElementById("modal-actions");

function closeModal() {
  modalBackdrop.hidden = true;
  modalBody.innerHTML = "";
  modalActions.innerHTML = "";
}

function openModal(title) {
  modalTitle.textContent = title;
  modalBody.innerHTML = "";
  modalActions.innerHTML = "";
  modalBackdrop.hidden = false;
}

modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop) closeModal();
});

function openTermsModal() {
  openModal("Terms of Service");
  modalBody.innerHTML = `
    <div dir="rtl" style="text-align: right;">
      <h2 style="font-size: 18px; margin: 0 0 4px;">📜 1. תנאי שימוש (Terms of Service)</h2>
      <p class="field-hint">עדכון אחרון: 28.07.2026</p>
      <p>ברוכים הבאים ל-TrackO'clock ("האפליקציה"). השימוש באפליקציה כפוף לתנאים המפורטים להלן. עצם הרישום או השימוש באפליקציה מהווה הסכמה לתנאים אלו.</p>

      <p><strong>1.1 מהות האפליקציה</strong><br/>
      TrackO'clock היא אפליקציה המיועדת לספק כלי עזר אישי, נוח ושקוף למעקב אחר משמרות, שעות עבודה, חישוב הערכת שכר וניהול נקודות לובה.</p>
      <p>הבהרה קריטית: האפליקציה אינה מערכת נוכחות רשמית של מעסיק, אינה מחליפה דיווח נוכחות כחוק במקום העבודה, ואינה מהווה תלוש שכר רשמי או יעוץ משפטי/חשבונאי.</p>

      <p><strong>1.2 חישובי שכר והסתלקות מאחריות</strong><br/>
      מנוע חישוב השכר באפליקציה מבוסס על אלגוריתמים המותאמים לחוקי העבודה בישראל ולנתונים שהוזנו על ידי המשתמש (תעריפים, תוספות, משמרות וכדומה).</p>
      <p>החישובים המוצגים באפליקציה מהווים הערכה וסימולציה בלבד. התשלום בפועל נקבע אך ורק לפי רישומי המעסיק ותלוש השכר הרשמי.</p>
      <p>מפתח האפליקציה אינו נושא באחריות לכל אי-התאמה, טעות, או נזק היפותטי שעלול להיגרם מהסתמכות על הנתונים המוצגים באפליקציה.</p>

      <p><strong>1.3 קניין רוחני</strong><br/>
      כל זכויות היוצרים, המותג, העיצוב, העבודות הגרפיות, הקוד והתוכן ב-TrackO'clock (כולל הסלוגנים והדמויות באפליקציה) שייכים בלעדית למפתח האפליקציה.</p>
      <p>אין להעתיק, לשכפל, להנדס לאחור (Reverse Engineer) או לעשות שימוש מסחרי באפליקציה ללא אישור מפורש בכתב.</p>

      <h2 style="font-size: 18px; margin: 20px 0 4px;">🔒 2. מדיניות פרטיות (Privacy Policy)</h2>
      <p class="field-hint">עדכון אחרון: 28.07.2026</p>
      <p>אנו ב-TrackO'clock מכבדים את הפרטיות שלך ומחויבים להגן על המידע האישי שלך.</p>

      <p><strong>2.1 המידע שאנו אוספים</strong><br/>
      כדי לספק לך את שירותי האפליקציה, אנו אוספים את המידע הבא בלבד:</p>
      <p>פרטי זיהוי בסיסיים: בעת התחברות באמצעות Google, אנו מקבלים את שמך וכתובת הדוא"ל שלך לצורך אימות מאובטח.</p>
      <p>נתוני משמרות ושכר: שעות כניסה/יציאה, תעריפי בסיס, סוגי משמרות, ותיוגים שהזנת באופן יזום.</p>
      <p>נתוני נקודות לובה: רישומי זיכוי, ניצול ואיפוס נקודות.</p>
      <p>נתוני שימוש אנונימיים: אנו אוספים נתוני שימוש כלליים (כגון מסכים שנצפו ופעולות בסיסיות כמו כניסה/יציאה למשמרת) באמצעות Google Analytics for Firebase, לצורך הבנת השימוש באפליקציה ושיפורה בלבד.</p>

      <p><strong>2.2 איך אנחנו משתמשים במידע שלך?</strong><br/>
      לצורך תפעול האפליקציה בלבד: הצגת הנתונים, ביצוע חישובי השכר האישיים, וסנכרון ענן מאובטח בין המכשירים השונים שלך.</p>
      <p>אפס מסחר במידע: אנו לא מוכרים, משכירים או מעבירים את המידע האישי שלך לשום גורם שלישי או לצורכי פרסום.</p>

      <p><strong>2.3 אבטחת מידע ואחסון</strong><br/>
      הנתונים שלך מאוחסנים בשרתי ענן מאובטחים המשתמשים פרוטוקולי הצפנה מתקדמים (בסטנדרט בתעשייה).</p>
      <p>האפליקציה תומכת גם בעבודה אופליין; נתונים שנרשמים ללא חיבור לרשת יישמרו מקומית ויסונכרנו בבטחה בעת התחברות מחדש.</p>

      <p><strong>2.4 זכויות המשתמש ומחיקת מידע</strong><br/>
      הנתונים שלך הם שלך בלבד.</p>
      <p>באפשרותך לערוך או למחוק רשומות משמרת בכל עת מתוך מסך הנוכחות החודשי.</p>
      <p>במידה ותרצה למחוק את חשבונך ואת כל הנתונים המקושרים אליו כליל מהשרתים שלנו, ניתן לעשות זאת ישירות דרך הגדרות החשבון באפליקציה.</p>
    </div>
  `;

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn-primary";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeModal);
  modalActions.appendChild(closeBtn);
}

// ---------- shift matching UI ----------

function shiftLabel(shift) {
  return `${shift.start}–${shift.end} (${shift.vouchers}, ${shift.points} pts)`;
}

// ---------- optional shift type (station/role) tagging ----------

const SHIFT_TYPES = ["דלפק", "באגי יציאות", "דייל קונקורס", "באגי כניסות", "פסיפס", `דייל של"ן`];

// Resolves to a chosen shift type string, or "" if skipped/cleared.
function promptShiftType(current = "") {
  return new Promise((resolve) => {
    openModal("Shift type");
    for (const type of SHIFT_TYPES) {
      const btn = document.createElement("button");
      btn.className = "modal-option";
      btn.textContent = type;
      if (type === current) btn.style.fontWeight = "800";
      btn.addEventListener("click", () => {
        closeModal();
        resolve(type);
      });
      modalBody.appendChild(btn);
    }
    const skipBtn = document.createElement("button");
    skipBtn.className = "btn-plain";
    skipBtn.textContent = "None / Skip";
    skipBtn.addEventListener("click", () => {
      closeModal();
      resolve("");
    });
    modalActions.appendChild(skipBtn);
  });
}

// Resolves to a chosen shift object, or null if the user cancels.
function resolveShiftForClockIn(clockInDate) {
  return new Promise((resolve) => {
    const match = matchShiftByClockIn(clockInDate);

    if (match.matched && match.candidates.length === 1) {
      resolve(match.candidates[0]);
      return;
    }

    if (match.matched && match.candidates.length > 1) {
      openModal("Which shift is this?");
      for (const shift of match.candidates) {
        const btn = document.createElement("button");
        btn.className = "modal-option";
        btn.textContent = shiftLabel(shift);
        btn.addEventListener("click", () => {
          closeModal();
          resolve(shift);
        });
        modalBody.appendChild(btn);
      }
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "btn-plain";
      cancelBtn.textContent = "None of these (search all shifts)";
      cancelBtn.addEventListener("click", () => {
        closeModal();
        resolveWithManualPicker(resolve);
      });
      modalActions.appendChild(cancelBtn);
      return;
    }

    // No reasonable auto-match: fall back to full searchable picker.
    resolveWithManualPicker(resolve);
  });
}

function resolveWithManualPicker(resolve) {
  openModal("Pick your shift");
  const search = document.createElement("input");
  search.className = "field-input";
  search.type = "text";
  search.placeholder = "Search e.g. 08:00";
  modalBody.appendChild(search);

  const list = document.createElement("div");
  modalBody.appendChild(list);

  function renderList(filter) {
    list.innerHTML = "";
    const f = filter.trim();
    const rows = SHIFT_CATALOG.filter((s) => `${s.start}-${s.end}`.includes(f));
    for (const shift of rows.slice(0, 40)) {
      const btn = document.createElement("button");
      btn.className = "modal-option";
      btn.textContent = shiftLabel(shift);
      btn.addEventListener("click", () => {
        closeModal();
        resolve(shift);
      });
      list.appendChild(btn);
    }
  }
  renderList("");
  search.addEventListener("input", () => renderList(search.value));
}

// ---------- clock in / out ----------

const clockBtn = document.getElementById("btn-clock");
const NO_POINTS_SHIFT_LABEL = "Shift without points eligibility";

clockBtn.addEventListener("click", async () => {
  if (state.currentPunch) {
    await handleClockOut();
  } else {
    await handleClockIn();
  }
});

async function handleClockIn() {
  const clockInDate = new Date();
  const shift = await resolveShiftForClockIn(clockInDate);
  if (!shift) return;
  let shiftType = "";
  if (state.settings.trackShiftType) {
    shiftType = await promptShiftType();
  }
  state.currentPunch = { clockInISO: clockInDate.toISOString(), shift, shiftType };
  saveState();
  renderHome();
  logAnalyticsEvent("clock_in", { shift_start: shift.start });
}

// Resolves the shift that actually applies given the real clock-out time:
//  1. If the actual end closely matches another catalog row (same start), use it silently.
//  2. Otherwise, ask which of that start's shifts this actually was (or "no points eligibility").
function resolveActualShift(pickedShift, clockOutDate) {
  return new Promise((resolve) => {
    const autoMatch = matchShiftByActualEnd(pickedShift.start, clockOutDate, 20);
    if (autoMatch) {
      resolve(autoMatch);
      return;
    }

    const candidates = SHIFT_CATALOG.filter((s) => s.start === pickedShift.start);
    openModal("Actual end time didn't match — which shift was this?");
    for (const shift of candidates) {
      const btn = document.createElement("button");
      btn.className = "modal-option";
      btn.textContent = shiftLabel(shift);
      btn.addEventListener("click", () => {
        closeModal();
        resolve(shift);
      });
      modalBody.appendChild(btn);
    }
    const noPointsBtn = document.createElement("button");
    noPointsBtn.className = "btn-plain";
    noPointsBtn.textContent = NO_POINTS_SHIFT_LABEL;
    noPointsBtn.addEventListener("click", () => {
      closeModal();
      resolve({ start: pickedShift.start, end: formatTime(clockOutDate), points: 0, vouchers: "-" });
    });
    modalActions.appendChild(noPointsBtn);
  });
}

// Shared by live clock-out, edits, and the manual "More" entry form: given the final
// (already-resolved) shift and real clock-in/out times, computes pay and returns
// everything needed to save a punch record, including whether Luba points moved.
// The manual override (if set) always wins over the 3-month auto-calculation —
// lets a user correct the system if their real eligibility differs for any reason.
function currentProductivityBonusEnabled(referenceDate = new Date()) {
  const override = state.settings.productivityBonusOverride;
  if (override === true || override === false) return override;
  return isProductivityBonusEligible(state.settings.employmentStartDate, referenceDate);
}

function buildPunch(clockInDate, clockOutDate, shift, pickedShift, shiftType = "") {
  const eligible = currentProductivityBonusEnabled(clockOutDate);
  const pay = calculatePay(clockInDate, clockOutDate, {
    productivityBonusEligible: eligible,
    idfBonusPercent: state.settings.idfBonusPercent || 0,
    baseWageILS: state.settings.baseWageILS || BASE_WAGE_ILS,
  });

  const punch = {
    id: uid(),
    date: clockInDate.toISOString().slice(0, 10),
    clockInISO: clockInDate.toISOString(),
    clockOutISO: clockOutDate.toISOString(),
    shiftLabel: `${shift.start}-${shift.end}`,
    shiftType,
    mealPoints: shift.points,
    voucherNote: shift.vouchers,
    actualHours: pay.totalHours,
    payILS: pay.finalPayILS,
    payBreakdown: pay,
    editedFields: [],
  };

  const pointsDelta = shift.points - pickedShift.points;
  return { punch, pay, pointsDelta };
}

async function handleClockOut() {
  const clockOutDate = new Date();
  const clockInDate = new Date(state.currentPunch.clockInISO);
  const pickedShift = state.currentPunch.shift;

  if (clockOutDate.getTime() - clockInDate.getTime() < 60000) {
    openModal("Too soon");
    const p = document.createElement("p");
    p.textContent = "You just clocked in — wait at least a minute before clocking out.";
    modalBody.appendChild(p);
    const okBtn = document.createElement("button");
    okBtn.className = "btn-primary";
    okBtn.textContent = "OK";
    okBtn.addEventListener("click", closeModal);
    modalActions.appendChild(okBtn);
    return;
  }

  const shift = await resolveActualShift(pickedShift, clockOutDate);
  const { punch, pay, pointsDelta } = buildPunch(clockInDate, clockOutDate, shift, pickedShift, state.currentPunch.shiftType);

  state.punches.push(punch);
  state.currentPunch = null;
  saveState();
  renderHome();
  logAnalyticsEvent("clock_out", { hours: punch.actualHours });

  showClockOutSummary(punch, pay, pointsDelta);
}

function showClockOutSummary(punch, pay, pointsDelta) {
  openModal("Shift complete");
  const body = document.createElement("div");

  let adjustmentNote = "";
  if (pointsDelta > 0) {
    adjustmentNote = `<p class="field-hint">⚠️ Shift ran later than planned — Luba points adjusted up by ${pointsDelta}.</p>`;
  } else if (pointsDelta < 0) {
    adjustmentNote = `<p class="field-hint">⚠️ Shift ended earlier than planned — Luba points adjusted down by ${Math.abs(pointsDelta)}.</p>`;
  }

  body.innerHTML = `
    <p><strong>${punch.actualHours}h</strong> worked (${punch.shiftLabel})</p>
    <p>Pay: <strong>${formatILS(punch.payILS)}</strong>${pay.productivityBonusApplied ? " (incl. +10% seniority bonus)" : ""}</p>
    <p>Luba points earned: <strong>${punch.mealPoints}</strong> (${punch.voucherNote})</p>
    ${adjustmentNote}
  `;
  modalBody.appendChild(body);

  const doneBtn = document.createElement("button");
  doneBtn.className = "btn-primary";
  doneBtn.textContent = "Done";
  doneBtn.addEventListener("click", () => {
    closeModal();
    if (state.settings.remindPointsOnClockOut) {
      promptLogPointsUsed();
    }
  });
  modalActions.appendChild(doneBtn);
}

function promptLogPointsUsed() {
  openModal("Log Luba points used?");
  const p = document.createElement("p");
  p.textContent = "Did you use Luba points this shift?";
  modalBody.appendChild(p);

  const logBtn = document.createElement("button");
  logBtn.className = "btn-primary";
  logBtn.textContent = "Log now";
  logBtn.addEventListener("click", () => {
    closeModal();
    openLogPointsModal();
  });

  const skipBtn = document.createElement("button");
  skipBtn.className = "btn-plain";
  skipBtn.textContent = "Skip";
  skipBtn.addEventListener("click", closeModal);

  modalActions.appendChild(skipBtn);
  modalActions.appendChild(logBtn);
}

// ---------- cafeteria spending ----------

function openLogPointsModal() {
  openModal("Log points used");

  const typeLabel = document.createElement("label");
  typeLabel.className = "field-label";
  typeLabel.textContent = "What was used?";
  const typeSelect = document.createElement("select");
  typeSelect.className = "field-input";
  typeSelect.innerHTML = `
    <option value="100">בשרי (100 נקודות)</option>
    <option value="50">חלבי (50 נקודות)</option>
    <option value="manual">Manual amount</option>
  `;

  const pointsInput = document.createElement("input");
  pointsInput.className = "field-input";
  pointsInput.type = "number";
  pointsInput.min = "0";
  pointsInput.placeholder = "Points spent";
  pointsInput.hidden = true;

  typeSelect.addEventListener("change", () => {
    pointsInput.hidden = typeSelect.value !== "manual";
  });

  const noteInput = document.createElement("input");
  noteInput.className = "field-input";
  noteInput.type = "text";
  noteInput.placeholder = "Note (optional)";

  modalBody.append(typeLabel, typeSelect, pointsInput, noteInput);

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn-primary";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", () => {
    const pointsSpent = typeSelect.value === "manual" ? parseInt(pointsInput.value, 10) : parseInt(typeSelect.value, 10);
    if (!pointsSpent || pointsSpent <= 0) return;
    const type = typeSelect.value === "100" ? "meat" : typeSelect.value === "50" ? "dairy" : "manual";
    const entry = {
      id: uid(),
      timestampISO: new Date().toISOString(),
      pointsSpent,
      type,
      note: noteInput.value.trim(),
    };
    state.cafeteriaSpending.push(entry);
    saveState();
    closeModal();
    renderHome();
    renderCafeteria();
    logAnalyticsEvent("luba_points_logged", { points: pointsSpent, type });
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-plain";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closeModal);

  modalActions.appendChild(cancelBtn);
  modalActions.appendChild(saveBtn);
}

document.getElementById("btn-log-points").addEventListener("click", openLogPointsModal);

// ---------- monthly balance ----------

function monthlyBalance(referenceDate = new Date()) {
  let earned = state.punches
    .filter((p) => sameMonth(new Date(p.clockInISO), referenceDate))
    .reduce((sum, p) => sum + p.mealPoints, 0);

  // Eligibility is decided by the shift picked at clock-in, so an in-progress
  // shift's points count toward the balance immediately, before clock-out.
  if (state.currentPunch && sameMonth(new Date(state.currentPunch.clockInISO), referenceDate)) {
    earned += state.currentPunch.shift.points;
  }

  const spent = state.cafeteriaSpending
    .filter((s) => sameMonth(new Date(s.timestampISO), referenceDate))
    .reduce((sum, s) => sum + s.pointsSpent, 0);
  return { earned, spent, balance: earned - spent };
}

// ---------- render: home ----------

let clockTimerInterval = null;

function updateStatusTimer() {
  if (!state || !state.currentPunch) return;
  const elapsed = Date.now() - new Date(state.currentPunch.clockInISO).getTime();
  document.getElementById("status-timer").textContent = formatElapsed(elapsed);
}

function renderHome() {
  applyTheme();
  const statusLabel = document.getElementById("status-label");
  const statusSub = document.getElementById("status-sub");
  const statusTimer = document.getElementById("status-timer");

  if (state.currentPunch) {
    const clockIn = new Date(state.currentPunch.clockInISO);
    statusLabel.innerHTML = `<span class="status-active-word">Clocked In</span> <span class="status-time-word">since ${formatTime(clockIn)}</span>`;
    statusSub.textContent = `Shift: ${state.currentPunch.shift.start}-${state.currentPunch.shift.end}`;
    clockBtn.textContent = "Clock Out";
    clockBtn.classList.add("is-clockedin");
    statusLabel.classList.remove("is-inactive");
    statusTimer.hidden = false;
    updateStatusTimer();
    if (!clockTimerInterval) clockTimerInterval = setInterval(updateStatusTimer, 1000);
  } else {
    statusLabel.textContent = "Not clocked in";
    statusSub.textContent = "";
    clockBtn.textContent = "Clock In";
    clockBtn.classList.remove("is-clockedin");
    statusLabel.classList.add("is-inactive");
    statusTimer.hidden = true;
    if (clockTimerInterval) {
      clearInterval(clockTimerInterval);
      clockTimerInterval = null;
    }
  }

  const { balance, earned, spent } = monthlyBalance();
  document.getElementById("home-points-balance").textContent = balance;
  document.getElementById("home-points-sub").textContent = `${earned} earned − ${spent} spent this month`;

  const monthStats = computeMoreStats(new Date());
  document.getElementById("home-pay-balance").textContent = formatILS(monthStats.monthPay);
}

document.getElementById("home-pay-card").addEventListener("click", () => {
  const monthStats = computeMoreStats(new Date());
  openMonthlyBreakdownModal(monthStats.monthPunches, new Date());
});

// ---------- render: history (Monthly Attendance) ----------

let historyViewedMonth = new Date();

function renderHistory() {
  const isCurrentMonth = sameMonth(historyViewedMonth, new Date());
  document.getElementById("history-month-label").textContent =
    historyViewedMonth.toLocaleDateString([], { year: "numeric", month: "long" });
  document.getElementById("history-next-month").disabled = isCurrentMonth;

  const showShiftType = !!state.settings.trackShiftType;
  document.getElementById("history-th-shifttype").hidden = !showShiftType;
  const colCount = showShiftType ? 5 : 4;

  const tbody = document.getElementById("history-table-body");
  tbody.innerHTML = "";

  const monthPunches = state.punches.filter((p) => sameMonth(new Date(p.clockInISO), historyViewedMonth));
  const sorted = [...monthPunches].sort((a, b) => new Date(a.clockInISO) - new Date(b.clockInISO));

  const totalHours = monthPunches.reduce((sum, p) => sum + p.actualHours, 0);
  document.getElementById("history-total-hours").textContent = `Total: ${totalHours.toFixed(1)} Hours`;

  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="list-empty">No shifts logged this month</td></tr>`;
    return;
  }

  for (const p of sorted) {
    const tr = document.createElement("tr");
    tr.dataset.punchId = p.id;
    const edited = p.editedFields || [];
    const inCellClass = edited.includes("clockIn") ? "cell-edited" : "";
    const outCellClass = edited.includes("clockOut") ? "cell-edited" : "";
    const clockInDate = new Date(p.clockInISO);
    const clockOutDate = new Date(p.clockOutISO);
    const outSuffix = sameDay(clockInDate, clockOutDate) ? "" : " (+1)";
    tr.innerHTML = `
      <td>${formatDate(clockInDate)}</td>
      ${showShiftType ? `<td>${p.shiftType || "—"}</td>` : ""}
      <td class="${inCellClass}">${formatTime(clockInDate)}</td>
      <td class="${outCellClass}">${formatTime(clockOutDate)}${outSuffix}</td>
      <td>${p.actualHours}h</td>
    `;
    tbody.appendChild(tr);
  }
}

document.getElementById("history-table-body").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-punch-id]");
  if (!tr) return;
  const punch = state.punches.find((p) => p.id === tr.dataset.punchId);
  if (punch) openEditPunchModal(punch);
});

document.getElementById("history-prev-month").addEventListener("click", () => {
  historyViewedMonth = new Date(historyViewedMonth.getFullYear(), historyViewedMonth.getMonth() - 1, 1);
  renderHistory();
});

document.getElementById("history-next-month").addEventListener("click", () => {
  if (sameMonth(historyViewedMonth, new Date())) return;
  historyViewedMonth = new Date(historyViewedMonth.getFullYear(), historyViewedMonth.getMonth() + 1, 1);
  renderHistory();
});

// ---------- render: cafeteria ----------

let cafeteriaViewedMonth = new Date();

// Builds one chronological feed mixing real spending log entries (editable) with
// read-only "earned" entries derived from each completed shift's Luba points —
// shifts aren't logged as cafeteria entries, so there's nothing to edit there;
// editing what a shift earned means editing the shift itself, in Attendance.
function buildCafeteriaFeed(referenceDate) {
  const earnedEntries = state.punches
    .filter((p) => p.mealPoints > 0 && sameMonth(new Date(p.clockOutISO), referenceDate))
    .map((p) => ({
      kind: "earned",
      timestampISO: p.clockOutISO,
      points: p.mealPoints,
      note: p.shiftLabel,
    }));

  const spentEntries = state.cafeteriaSpending
    .filter((s) => sameMonth(new Date(s.timestampISO), referenceDate))
    .map((s) => ({
      kind: "spent",
      timestampISO: s.timestampISO,
      points: s.pointsSpent,
      note: s.note,
      raw: s,
    }));

  return [...earnedEntries, ...spentEntries].sort((a, b) => new Date(b.timestampISO) - new Date(a.timestampISO));
}

function renderCafeteria() {
  const isCurrentMonth = sameMonth(cafeteriaViewedMonth, new Date());
  document.getElementById("cafeteria-month-label").textContent =
    cafeteriaViewedMonth.toLocaleDateString([], { year: "numeric", month: "long" });
  document.getElementById("cafeteria-next-month").disabled = isCurrentMonth;

  const { balance, earned, spent } = monthlyBalance(cafeteriaViewedMonth);
  document.getElementById("cafeteria-balance").textContent = balance;
  document.getElementById("cafeteria-balance-sub").textContent = `${earned} earned − ${spent} spent (resets next month)`;

  const list = document.getElementById("cafeteria-list");
  list.innerHTML = "";
  const feed = buildCafeteriaFeed(cafeteriaViewedMonth);

  if (!feed.length) {
    list.innerHTML = `<li class="list-empty">No Luba activity this month</li>`;
    return;
  }

  for (const entry of feed) {
    const li = document.createElement("li");
    li.className = "list-item";
    const d = new Date(entry.timestampISO);
    const sign = entry.kind === "earned" ? "+" : "-";
    const colorClass = entry.kind === "earned" ? "pts-earned" : "pts-spent";
    li.innerHTML = `
      <div class="list-item-row"><span>${formatDate(d)} ${formatTime(d)}</span><span class="${colorClass}">${entry.kind} ${sign}${entry.points} pts</span></div>
      ${entry.note ? `<p class="list-item-sub">${entry.note}</p>` : ""}
    `;
    if (entry.kind === "spent") {
      li.classList.add("is-clickable");
      li.addEventListener("click", () => openEditSpendingModal(entry.raw));
    }
    list.appendChild(li);
  }
}

document.getElementById("cafeteria-prev-month").addEventListener("click", () => {
  cafeteriaViewedMonth = new Date(cafeteriaViewedMonth.getFullYear(), cafeteriaViewedMonth.getMonth() - 1, 1);
  renderCafeteria();
});

document.getElementById("cafeteria-next-month").addEventListener("click", () => {
  if (sameMonth(cafeteriaViewedMonth, new Date())) return;
  cafeteriaViewedMonth = new Date(cafeteriaViewedMonth.getFullYear(), cafeteriaViewedMonth.getMonth() + 1, 1);
  renderCafeteria();
});

function openEditSpendingModal(entry) {
  openModal("Edit Luba points used");

  const typeLabel = document.createElement("label");
  typeLabel.className = "field-label";
  typeLabel.textContent = "What was used?";
  const typeSelect = document.createElement("select");
  typeSelect.className = "field-input";
  typeSelect.innerHTML = `
    <option value="100">בשרי (100 נקודות)</option>
    <option value="50">חלבי (50 נקודות)</option>
    <option value="manual">Manual amount</option>
  `;
  typeSelect.value = entry.type === "meat" ? "100" : entry.type === "dairy" ? "50" : "manual";

  const pointsInput = document.createElement("input");
  pointsInput.className = "field-input";
  pointsInput.type = "number";
  pointsInput.min = "0";
  pointsInput.placeholder = "Points spent";
  pointsInput.value = entry.pointsSpent;
  pointsInput.hidden = typeSelect.value !== "manual";

  typeSelect.addEventListener("change", () => {
    pointsInput.hidden = typeSelect.value !== "manual";
  });

  const noteInput = document.createElement("input");
  noteInput.className = "field-input";
  noteInput.type = "text";
  noteInput.placeholder = "Note (optional)";
  noteInput.value = entry.note || "";

  modalBody.append(typeLabel, typeSelect, pointsInput, noteInput);

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn-primary";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", () => {
    const pointsSpent = typeSelect.value === "manual" ? parseInt(pointsInput.value, 10) : parseInt(typeSelect.value, 10);
    if (!pointsSpent || pointsSpent <= 0) return;
    entry.pointsSpent = pointsSpent;
    entry.type = typeSelect.value === "100" ? "meat" : typeSelect.value === "50" ? "dairy" : "manual";
    entry.note = noteInput.value.trim();
    saveState();
    closeModal();
    renderHome();
    renderCafeteria();
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn-danger";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", () => {
    state.cafeteriaSpending = state.cafeteriaSpending.filter((s) => s.id !== entry.id);
    saveState();
    closeModal();
    renderHome();
    renderCafeteria();
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-plain";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closeModal);

  modalActions.append(deleteBtn, cancelBtn, saveBtn);
}

// ---------- render: settings ----------

function applyTheme() {
  const theme = state?.settings?.theme || "system";
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

function renderSettings() {
  document.getElementById("settings-base-wage").value = state.settings.baseWageILS || BASE_WAGE_ILS;
  document.getElementById("remind-points-toggle").checked = !!state.settings.remindPointsOnClockOut;
  document.getElementById("track-shift-type-toggle").checked = !!state.settings.trackShiftType;
  document.getElementById("theme-select").value = state.settings.theme || "system";
  document.getElementById("monthly-hours-goal").value = state.settings.monthlyHoursGoal || "";
  document.getElementById("signed-in-as").textContent = currentUid ? `Signed in as: ${currentUserLabel}` : "";

  document.getElementById("settings-employment-start-date").value = state.settings.employmentStartDate || "";

  const idfPercent = state.settings.idfBonusPercent || 0;
  document.querySelectorAll("#idf-bonus-segmented .segmented-option").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.value) === idfPercent);
  });

  const seniorityEnabled = currentProductivityBonusEnabled();
  document.getElementById("settings-seniority-toggle").checked = seniorityEnabled;

  const hint = document.getElementById("settings-bonus-hint");
  const isOverridden = state.settings.productivityBonusOverride === true || state.settings.productivityBonusOverride === false;
  if (isOverridden) {
    hint.textContent = `Manually ${seniorityEnabled ? "enabled" : "disabled"} (overriding the 3-month rule).`;
  } else if (!state.settings.employmentStartDate) {
    hint.textContent = "Set your start date to auto-apply the 10% seniority bonus after 3 months.";
  } else {
    hint.textContent = seniorityEnabled
      ? "Eligible for the 10% seniority bonus ✓"
      : "Not yet eligible — applies automatically 3 months after your start date.";
  }

  const widgets = state.settings.moreWidgets || {};
  for (const key of ["hours", "shifts", "pay", "averages", "luba", "export"]) {
    document.getElementById(`more-widget-${key}`).checked = widgets[key] !== false;
  }
}

for (const key of ["hours", "shifts", "pay", "averages", "luba", "export"]) {
  document.getElementById(`more-widget-${key}`).addEventListener("change", (e) => {
    if (!state.settings.moreWidgets) state.settings.moreWidgets = {};
    state.settings.moreWidgets[key] = e.target.checked;
    saveState();
  });
}

document.getElementById("settings-base-wage").addEventListener("change", (e) => {
  const value = Number(e.target.value);
  state.settings.baseWageILS = value > 0 ? value : BASE_WAGE_ILS;
  saveState();
  renderSettings();
});

document.getElementById("settings-employment-start-date").addEventListener("change", (e) => {
  state.settings.employmentStartDate = e.target.value;
  saveState();
  renderSettings();
});

document.querySelectorAll("#idf-bonus-segmented .segmented-option").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.settings.idfBonusPercent = Number(btn.dataset.value);
    saveState();
    renderSettings();
  });
});

document.getElementById("settings-seniority-toggle").addEventListener("change", (e) => {
  state.settings.productivityBonusOverride = e.target.checked;
  saveState();
  renderSettings();
});

document.getElementById("monthly-hours-goal").addEventListener("change", (e) => {
  state.settings.monthlyHoursGoal = Number(e.target.value) || 0;
  saveState();
});

document.getElementById("remind-points-toggle").addEventListener("change", (e) => {
  state.settings.remindPointsOnClockOut = e.target.checked;
  saveState();
});

document.getElementById("track-shift-type-toggle").addEventListener("change", (e) => {
  state.settings.trackShiftType = e.target.checked;
  saveState();
  renderHistory();
});

document.getElementById("theme-select").addEventListener("change", (e) => {
  state.settings.theme = e.target.value;
  saveState();
  applyTheme();
});

document.getElementById("btn-logout").addEventListener("click", handleLogout);

document.getElementById("btn-delete-account").addEventListener("click", openDeleteAccountModal);

function openDeleteAccountModal() {
  openModal("Delete your account?");
  const p = document.createElement("p");
  p.textContent = "This permanently deletes your account and all your data (shifts, Luba points, settings) from our servers. This can't be undone.";
  modalBody.appendChild(p);
  const errorP = document.createElement("p");
  errorP.className = "field-hint";
  modalBody.appendChild(errorP);

  const confirmBtn = document.createElement("button");
  confirmBtn.className = "btn-danger";
  confirmBtn.textContent = "Delete permanently";
  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Deleting…";
    try {
      const uidToDelete = currentUid;
      await deleteUserAccount(uidToDelete);
      localStorage.removeItem(localCacheKey(uidToDelete));
      if (unsubscribeCloud) unsubscribeCloud();
      unsubscribeCloud = null;
      if (clockTimerInterval) {
        clearInterval(clockTimerInterval);
        clockTimerInterval = null;
      }
      currentUid = null;
      currentUserLabel = "";
      state = null;
      closeModal();
      showLoginScreen();
    } catch (err) {
      console.error("account deletion failed:", err);
      errorP.textContent = err?.code === "auth/requires-recent-login"
        ? "For security, please log out and sign back in, then try deleting your account again."
        : "Couldn't delete your account — check your connection and try again.";
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Delete permanently";
    }
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-plain";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closeModal);

  modalActions.append(cancelBtn, confirmBtn);
}

// ---------- "More": monthly summary + manual shift entry ----------

function toDatetimeLocalValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function computeMoreStats(referenceDate = new Date()) {
  // Week stats are always relative to the real current week, regardless of which
  // month is being browsed — they're only ever shown alongside the current month anyway.
  const weekStart = startOfWeek(new Date());
  const weekPunches = state.punches.filter((p) => new Date(p.clockInISO) >= weekStart);
  const monthPunches = state.punches.filter((p) => sameMonth(new Date(p.clockInISO), referenceDate));
  const sum = (arr, key) => arr.reduce((s, p) => s + p[key], 0);

  const weekHours = sum(weekPunches, "actualHours");
  const weekPay = sum(weekPunches, "payILS");
  const monthHours = sum(monthPunches, "actualHours");
  const monthPay = sum(monthPunches, "payILS");
  const monthShiftCount = monthPunches.length;

  const monthSpending = state.cafeteriaSpending.filter((s) => sameMonth(new Date(s.timestampISO), referenceDate));
  const spentByType = { meat: 0, dairy: 0, manual: 0 };
  const countByType = { meat: 0, dairy: 0, manual: 0 };
  for (const s of monthSpending) {
    const t = s.type || "manual";
    spentByType[t] += s.pointsSpent;
    countByType[t] += 1;
  }
  const { earned, spent, balance } = monthlyBalance(referenceDate);

  return {
    weekHours, weekPay, monthHours, monthPay, monthShiftCount, monthPunches,
    avgHoursPerShift: monthShiftCount ? monthHours / monthShiftCount : 0,
    avgPayPerShift: monthShiftCount ? monthPay / monthShiftCount : 0,
    avgHourlyPay: monthHours ? monthPay / monthHours : 0,
    lubaEarned: earned, lubaSpent: spent, lubaBalance: balance,
    spentByType, countByType,
  };
}

// ---------- monthly attendance export (Excel / PDF) ----------

function monthExportRows(monthPunches) {
  const sorted = [...monthPunches].sort((a, b) => new Date(a.clockInISO) - new Date(b.clockInISO));
  return sorted.map((p) => ({
    Date: formatDate(new Date(p.clockInISO)),
    In: formatTime(new Date(p.clockInISO)),
    Out: `${formatDate(new Date(p.clockOutISO))} ${formatTime(new Date(p.clockOutISO))}`,
    Hours: p.actualHours,
    Pay: p.payILS,
    Points: p.mealPoints,
  }));
}

function exportMonthToXlsx(monthPunches, monthDate) {
  if (typeof XLSX === "undefined") {
    alert("Export library didn't load — check your internet connection and try again.");
    return;
  }
  const rows = monthExportRows(monthPunches);
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Attendance");
  const monthName = monthDate.toLocaleDateString([], { year: "numeric", month: "2-digit" });
  XLSX.writeFile(workbook, `attendance-${monthName}.xlsx`);
  logAnalyticsEvent("export_data", { format: "xlsx" });
}

function exportMonthToPdf(monthPunches, monthDate) {
  if (typeof window.jspdf === "undefined") {
    alert("Export library didn't load — check your internet connection and try again.");
    return;
  }
  const rows = monthExportRows(monthPunches);
  const doc = new window.jspdf.jsPDF();
  doc.text("Monthly Attendance", 14, 14);
  doc.autoTable({
    startY: 20,
    head: [["Date", "In", "Out", "Hours", "Pay", "Points"]],
    body: rows.map((r) => [r.Date, r.In, r.Out, r.Hours, formatILS(r.Pay), r.Points]),
  });
  const monthName = monthDate.toLocaleDateString([], { year: "numeric", month: "2-digit" });
  doc.save(`attendance-${monthName}.pdf`);
  logAnalyticsEvent("export_data", { format: "pdf" });
}

// The month shown here always matches whatever month is currently browsed on the
// Monthly Attendance screen (historyViewedMonth) — navigating months happens there,
// not in this modal, so the two never drift out of sync.
function openMoreModal() {
  openModal("More");

  const isCurrentMonth = sameMonth(historyViewedMonth, new Date());
  const s = computeMoreStats(historyViewedMonth);
  const goal = state.settings.monthlyHoursGoal || 0;
  const widgets = state.settings.moreWidgets || {};
  const monthLabel = historyViewedMonth.toLocaleDateString([], { year: "numeric", month: "long" });

  const monthHeading = document.createElement("p");
  monthHeading.className = "card-title";
  monthHeading.textContent = monthLabel;
  modalBody.appendChild(monthHeading);

  let html = "";
  if (widgets.hours !== false) {
    html += `<p class="card-title">Hours</p><p>${s.monthHours.toFixed(1)}h this month${isCurrentMonth ? ` · ${s.weekHours.toFixed(1)}h this week` : ""}</p>`;
    if (goal > 0 && isCurrentMonth) {
      const pct = Math.min(100, Math.round((s.monthHours / goal) * 100));
      html += `<p>Monthly hours goal: <strong>${pct}%</strong> of ${goal}h</p>`;
    }
  }
  if (widgets.shifts !== false) {
    html += `<p class="card-title">Shifts</p><p>${s.monthShiftCount} actual shifts this month</p>`;
  }
  if (widgets.pay !== false) {
    html += `<p class="card-title">Total pay</p><p><button class="breakdown-link" id="more-pay-breakdown" type="button">${formatILS(s.monthPay)}</button> this month${isCurrentMonth ? ` · ${formatILS(s.weekPay)} this week` : ""}</p>`;
  }
  if (widgets.averages !== false) {
    html += `<p class="card-title">Averages</p><p>${s.avgHoursPerShift.toFixed(1)}h/shift · ${formatILS(s.avgPayPerShift)}/shift · ${formatILS(s.avgHourlyPay)}/h effective</p>`;
  }
  if (widgets.luba !== false) {
    html += `<p class="card-title">Luba points</p><p>${s.lubaEarned} earned − ${s.lubaSpent} spent = ${s.lubaBalance} balance</p><p>Used: ${s.countByType.meat} בשרי (${s.spentByType.meat} pts) · ${s.countByType.dairy} חלבי (${s.spentByType.dairy} pts)${s.countByType.manual ? ` · ${s.countByType.manual} manual (${s.spentByType.manual} pts)` : ""}</p>`;
  }
  const summary = document.createElement("div");
  summary.innerHTML = html;
  modalBody.appendChild(summary);

  const payBreakdownBtn = summary.querySelector("#more-pay-breakdown");
  if (payBreakdownBtn) {
    payBreakdownBtn.addEventListener("click", () => {
      closeModal();
      openMonthlyBreakdownModal(s.monthPunches, historyViewedMonth);
    });
  }

  if (widgets.export !== false) {
    const exportRow = document.createElement("div");
    exportRow.style.display = "flex";
    exportRow.style.gap = "10px";
    const exportXlsxBtn = document.createElement("button");
    exportXlsxBtn.className = "secondary-button";
    exportXlsxBtn.textContent = "Export Excel";
    exportXlsxBtn.style.marginBottom = "0";
    exportXlsxBtn.addEventListener("click", () => exportMonthToXlsx(s.monthPunches, historyViewedMonth));
    const exportPdfBtn = document.createElement("button");
    exportPdfBtn.className = "secondary-button";
    exportPdfBtn.textContent = "Export PDF";
    exportPdfBtn.style.marginBottom = "0";
    exportPdfBtn.addEventListener("click", () => exportMonthToPdf(s.monthPunches, historyViewedMonth));
    exportRow.append(exportXlsxBtn, exportPdfBtn);
    modalBody.appendChild(exportRow);
  }

  const addBtn = document.createElement("button");
  addBtn.className = "btn-primary";
  addBtn.textContent = "+ Add shift manually";
  addBtn.addEventListener("click", () => {
    closeModal();
    openManualEntryModal();
  });

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn-plain";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeModal);

  modalActions.append(closeBtn, addBtn);
}

document.getElementById("btn-open-more").addEventListener("click", openMoreModal);

function openManualEntryModal() {
  openModal("Add shift manually");

  const inLabel = document.createElement("label");
  inLabel.className = "field-label";
  inLabel.textContent = "Clock in";
  const inInput = document.createElement("input");
  inInput.className = "field-input";
  inInput.type = "datetime-local";

  const outLabel = document.createElement("label");
  outLabel.className = "field-label";
  outLabel.textContent = "Clock out";
  const outInput = document.createElement("input");
  outInput.className = "field-input";
  outInput.type = "datetime-local";

  const errorP = document.createElement("p");
  errorP.className = "field-hint";

  modalBody.append(inLabel, inInput, outLabel, outInput, errorP);

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn-primary";
  saveBtn.textContent = "Continue";
  saveBtn.addEventListener("click", async () => {
    if (!inInput.value || !outInput.value) {
      errorP.textContent = "Enter both clock-in and clock-out.";
      return;
    }
    const clockInDate = new Date(inInput.value);
    const clockOutDate = new Date(outInput.value);
    if (clockOutDate <= clockInDate) {
      errorP.textContent = "Clock out must be after clock in.";
      return;
    }

    closeModal();
    const pickedShift = await resolveShiftForClockIn(clockInDate);
    if (!pickedShift) return; // user cancelled the shift picker

    const shift = await resolveActualShift(pickedShift, clockOutDate);
    const shiftType = state.settings.trackShiftType ? await promptShiftType() : "";
    const { punch } = buildPunch(clockInDate, clockOutDate, shift, pickedShift, shiftType);
    state.punches.push(punch);
    saveState();
    renderHistory();
    renderHome();
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-plain";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closeModal);

  modalActions.append(cancelBtn, saveBtn);
}

// ---------- edit an existing punch ----------

function openEditPunchModal(punch) {
  openModal("Edit shift");

  const summary = document.createElement("p");
  summary.innerHTML = `Luba points: <strong>${punch.mealPoints}</strong> (${punch.voucherNote}) &nbsp;·&nbsp; Pay: <strong>${formatILS(punch.payILS)}</strong> <button class="breakdown-link" type="button">breakdown</button>`;
  summary.querySelector(".breakdown-link").addEventListener("click", () => openPayBreakdownModal(punch));
  modalBody.appendChild(summary);

  const inLabel = document.createElement("label");
  inLabel.className = "field-label";
  inLabel.textContent = "Clock in";
  const inInput = document.createElement("input");
  inInput.className = "field-input";
  inInput.type = "datetime-local";
  inInput.value = toDatetimeLocalValue(new Date(punch.clockInISO));

  const outLabel = document.createElement("label");
  outLabel.className = "field-label";
  outLabel.textContent = "Clock out";
  const outInput = document.createElement("input");
  outInput.className = "field-input";
  outInput.type = "datetime-local";
  outInput.value = toDatetimeLocalValue(new Date(punch.clockOutISO));

  const errorP = document.createElement("p");
  errorP.className = "field-hint";

  modalBody.append(inLabel, inInput, outLabel, outInput, errorP);

  let editedShiftType = punch.shiftType || "";
  if (state.settings.trackShiftType) {
    // A plain inline <select> here (not a nested modal) — this app has a single shared
    // modal, so opening another one while this edit modal is still visible would wipe
    // out this whole form instead of stacking on top of it.
    const typeLabel = document.createElement("label");
    typeLabel.className = "field-label";
    typeLabel.textContent = "Shift type";
    const typeSelect = document.createElement("select");
    typeSelect.className = "field-input";
    typeSelect.innerHTML = `<option value="">None</option>` + SHIFT_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("");
    typeSelect.value = editedShiftType;
    typeSelect.addEventListener("change", () => {
      editedShiftType = typeSelect.value;
    });
    modalBody.append(typeLabel, typeSelect);
  }

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn-primary";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", async () => {
    if (!inInput.value || !outInput.value) {
      errorP.textContent = "Enter both clock-in and clock-out.";
      return;
    }
    const clockInDate = new Date(inInput.value);
    const clockOutDate = new Date(outInput.value);
    if (clockOutDate <= clockInDate) {
      errorP.textContent = "Clock out must be after clock in.";
      return;
    }

    const clockInChanged = clockInDate.getTime() !== new Date(punch.clockInISO).getTime();
    const changedFields = [];
    if (clockInChanged) changedFields.push("clockIn");
    if (clockOutDate.getTime() !== new Date(punch.clockOutISO).getTime()) changedFields.push("clockOut");

    closeModal();

    let shift, pickedShift;
    if (clockInChanged) {
      // The clock-in time moved, so the whole shift eligibility window (±30 min) has to be
      // re-evaluated from scratch — an old match (e.g. an 11:00 shift) must not survive a
      // move to 13:50, it needs to be re-decided against the new time.
      pickedShift = await resolveShiftForClockIn(clockInDate);
      if (!pickedShift) return; // user cancelled the shift picker — leave the punch unedited
    } else {
      // Only the clock-out moved: keep the shift's start fixed, re-match just the end.
      const [originalStart, originalEnd] = punch.shiftLabel.split("-");
      pickedShift = { start: originalStart, end: originalEnd, points: punch.mealPoints, vouchers: punch.voucherNote };
    }
    shift = await resolveActualShift(pickedShift, clockOutDate);
    const { punch: recalculated } = buildPunch(clockInDate, clockOutDate, shift, pickedShift, editedShiftType);

    const priorEditedFields = punch.editedFields || [];
    const editedFields = [...new Set([...priorEditedFields, ...changedFields])];
    Object.assign(punch, recalculated, { id: punch.id, editedFields });
    saveState();
    renderHistory();
    renderHome();
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn-danger";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", () => {
    closeModal();
    openModal("Delete this shift?");
    const p = document.createElement("p");
    p.textContent = `Delete the ${punch.shiftLabel} shift on ${formatDate(new Date(punch.clockInISO))}? This can't be undone.`;
    modalBody.appendChild(p);

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btn-danger";
    confirmBtn.textContent = "Delete";
    confirmBtn.addEventListener("click", () => {
      state.punches = state.punches.filter((p) => p.id !== punch.id);
      saveState();
      closeModal();
      renderHistory();
      renderHome();
    });

    const cancelDeleteBtn = document.createElement("button");
    cancelDeleteBtn.className = "btn-plain";
    cancelDeleteBtn.textContent = "Cancel";
    cancelDeleteBtn.addEventListener("click", closeModal);

    modalActions.append(cancelDeleteBtn, confirmBtn);
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-plain";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closeModal);

  modalActions.append(deleteBtn, cancelBtn, saveBtn);
}

// ---------- monthly pay breakdown ----------

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Aggregates every punch's stored per-shift breakdown into one month-wide summary:
// hours (and ILS) per exact rate percentage, plus how much of the total came from
// each bonus. Bonuses are unwound in the same order calculatePay applies them
// (base -> +10% פריון -> +IDF%) so each bonus's own ILS contribution is isolated.
function computeMonthlyPayBreakdown(monthPunches) {
  const rateBuckets = {}; // ratePercent -> { hours, amountILS } — amount uses each punch's OWN wage at
                           // the time it was worked, so a later wage change never distorts past months.
  let totalPreBonus = 0;
  let totalProductivityAmount = 0;
  let totalIdfAmount = 0;
  let totalFinal = 0;
  let anyProductivityBonus = false;
  const idfPercentsUsed = new Set();

  for (const p of monthPunches) {
    const pay = p.payBreakdown;
    if (!pay || !pay.hoursByRate) continue; // older entries predating this breakdown format

    const wage = pay.baseWageILS > 0 ? pay.baseWageILS : BASE_WAGE_ILS;
    for (const r of pay.hoursByRate) {
      if (!rateBuckets[r.ratePercent]) rateBuckets[r.ratePercent] = { hours: 0, amountILS: 0 };
      rateBuckets[r.ratePercent].hours += r.hours;
      rateBuckets[r.ratePercent].amountILS += r.hours * wage * (r.ratePercent / 100);
    }

    const base = pay.preBonusPayILS;
    const afterProductivity = pay.productivityBonusApplied ? base * 1.1 : base;
    const afterIdf = pay.idfBonusPercent ? afterProductivity * (1 + pay.idfBonusPercent / 100) : afterProductivity;

    totalPreBonus += base;
    totalProductivityAmount += afterProductivity - base;
    totalIdfAmount += afterIdf - afterProductivity;
    totalFinal += pay.finalPayILS;
    if (pay.productivityBonusApplied) anyProductivityBonus = true;
    if (pay.idfBonusPercent) idfPercentsUsed.add(pay.idfBonusPercent);
  }

  const hoursByRate = Object.entries(rateBuckets)
    .map(([rate, v]) => ({
      ratePercent: Number(rate),
      hours: round2(v.hours),
      amountILS: round2(v.amountILS),
    }))
    .sort((a, b) => a.ratePercent - b.ratePercent);

  return {
    hoursByRate,
    totalPreBonus: round2(totalPreBonus),
    totalProductivityAmount: round2(totalProductivityAmount),
    totalIdfAmount: round2(totalIdfAmount),
    totalFinal: round2(totalFinal),
    anyProductivityBonus,
    idfPercentsUsed,
  };
}

function openMonthlyBreakdownModal(monthPunches, monthDate) {
  const monthLabel = monthDate.toLocaleDateString([], { year: "numeric", month: "long" });
  openModal(`Pay breakdown — ${monthLabel}`);

  if (!monthPunches.length) {
    modalBody.innerHTML = `<p class="field-hint">No shifts this month.</p>`;
  } else {
    const b = computeMonthlyPayBreakdown(monthPunches);
    const rateRows = b.hoursByRate.map((r) => [`Hours at ${r.ratePercent}%`, `${r.hours}h — ${formatILS(r.amountILS)}`]);
    const idfLabel = b.idfPercentsUsed.size === 1
      ? `+${[...b.idfPercentsUsed][0]}% IDF bonus`
      : `IDF bonus`;
    const rows = [
      ...rateRows,
      ["Before bonuses", formatILS(b.totalPreBonus)],
      ["+10% seniority bonus", b.anyProductivityBonus ? formatILS(b.totalProductivityAmount) : "Not applied"],
      [idfLabel, b.idfPercentsUsed.size ? formatILS(b.totalIdfAmount) : "Not applied"],
      ["Total pay this month", formatILS(b.totalFinal)],
    ];
    modalBody.innerHTML = rows.map(([label, value]) => `<p>${label}: <strong>${value}</strong></p>`).join("");
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn-primary";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeModal);
  modalActions.appendChild(closeBtn);
}

// ---------- pay breakdown (single shift) ----------

function openPayBreakdownModal(punch) {
  openModal("Pay breakdown");
  const pay = punch.payBreakdown;

  if (!pay || !pay.hoursByRate) {
    modalBody.innerHTML = `<p class="field-hint">Breakdown not available for this entry.</p>`;
  } else {
    // Only rates that actually applied to this shift show up — nothing at 0 hours.
    const rateRows = pay.hoursByRate.map((r) => [`Hours at ${r.ratePercent}%`, `${r.hours}h`]);
    const rows = [
      ...rateRows,
      ["Before bonus", formatILS(pay.preBonusPayILS)],
      ["+10% seniority bonus", pay.productivityBonusApplied ? "Applied" : "Not applied"],
    ];
    if (pay.idfBonusPercent) {
      rows.push([`+${pay.idfBonusPercent}% IDF bonus`, "Applied"]);
    }
    rows.push(["Total pay for this shift", formatILS(pay.finalPayILS)]);
    modalBody.innerHTML = rows.map(([label, value]) => `<p>${label}: <strong>${value}</strong></p>`).join("");
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn-primary";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeModal);
  modalActions.appendChild(closeBtn);
}

// ---------- init ----------

boot();
