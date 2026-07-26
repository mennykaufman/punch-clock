import { SHIFT_CATALOG, matchShiftByClockIn, matchShiftByActualEnd } from "./data/shifts.js";
import { calculatePay, isProductivityBonusEligible } from "./data/payRules.js";
import {
  fetchUserData,
  saveUserData,
  subscribeToUserData,
  signInWithGoogle,
  onAuthChange,
  signOutUser,
} from "./data/cloud.js";

function defaultState(employmentStartDate = "", idfBonusPercent = 0) {
  return {
    seq: 0, // bumped on every local save so a late/out-of-order cloud snapshot can never clobber a newer local change
    settings: {
      employmentStartDate,
      idfBonusPercent, // 0 = not eligible, else 2 or 3
      remindPointsOnClockOut: true,
      theme: "system", // "system" | "dark" | "light"
      monthlyHoursGoal: 0, // 0 = no goal set
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

const loginScreen = document.getElementById("login-screen");
const appShell = document.getElementById("app-shell");
const loginError = document.getElementById("login-error");
const btnGoogleSignIn = document.getElementById("btn-google-signin");
const googleSignInCard = document.getElementById("google-signin-card");
const welcomeCard = document.getElementById("welcome-card");
const welcomeEmploymentStartDate = document.getElementById("welcome-employment-start-date");
const welcomeIdfEligible = document.getElementById("welcome-idf-eligible");
const welcomeIdfPercent = document.getElementById("welcome-idf-percent");
const welcomeMigrateId = document.getElementById("welcome-migrate-id");
const welcomeMigratePin = document.getElementById("welcome-migrate-pin");
const welcomeError = document.getElementById("welcome-error");
const btnWelcomeContinue = document.getElementById("btn-welcome-continue");

function showLoginScreen() {
  loginScreen.hidden = false;
  appShell.hidden = true;
  googleSignInCard.hidden = false;
  welcomeCard.hidden = true;
}

function showWelcomeCard() {
  googleSignInCard.hidden = true;
  welcomeCard.hidden = false;
}

function showAppShell() {
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
    btnGoogleSignIn.disabled = false;
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
    } else {
      showWelcomeCard();
    }
  } catch (err) {
    console.error("post sign-in check failed:", err);
    loginError.textContent = "Couldn't reach the server — check your internet connection and try again.";
    showLoginScreen();
  }
}

function handleLogout() {
  if (unsubscribeCloud) unsubscribeCloud();
  unsubscribeCloud = null;
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
function sameMonth(dateA, dateB) {
  return dateA.getFullYear() === dateB.getFullYear() && dateA.getMonth() === dateB.getMonth();
}
function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

// ---------- navigation ----------

const SCREENS = ["home", "history", "cafeteria", "settings"];
const TITLES = { home: "Home", history: "Monthly Attendance", cafeteria: "Luba", settings: "Settings" };

function showScreen(name) {
  for (const s of SCREENS) {
    document.getElementById(`screen-${s}`).hidden = s !== name;
  }
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.nav === name);
  });
  document.getElementById("topbar-title").textContent = TITLES[name];
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

// ---------- shift matching UI ----------

function shiftLabel(shift) {
  return `${shift.start}–${shift.end} (${shift.vouchers}, ${shift.points} pts)`;
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
  state.currentPunch = { clockInISO: clockInDate.toISOString(), shift };
  saveState();
  renderHome();
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
function buildPunch(clockInDate, clockOutDate, shift, pickedShift) {
  const eligible = isProductivityBonusEligible(state.settings.employmentStartDate, clockOutDate);
  const pay = calculatePay(clockInDate, clockOutDate, {
    productivityBonusEligible: eligible,
    idfBonusPercent: state.settings.idfBonusPercent || 0,
  });

  const punch = {
    id: uid(),
    date: clockInDate.toISOString().slice(0, 10),
    clockInISO: clockInDate.toISOString(),
    clockOutISO: clockOutDate.toISOString(),
    shiftLabel: `${shift.start}-${shift.end}`,
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
  const { punch, pay, pointsDelta } = buildPunch(clockInDate, clockOutDate, shift, pickedShift);

  state.punches.push(punch);
  state.currentPunch = null;
  saveState();
  renderHome();

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
    <p>Pay: <strong>${formatILS(punch.payILS)}</strong>${pay.productivityBonusApplied ? " (incl. +10% פריון)" : ""}</p>
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

function renderHome() {
  applyTheme();
  const statusLabel = document.getElementById("status-label");
  const statusSub = document.getElementById("status-sub");

  if (state.currentPunch) {
    const clockIn = new Date(state.currentPunch.clockInISO);
    statusLabel.textContent = `Clocked in since ${formatTime(clockIn)}`;
    statusSub.textContent = `Shift: ${state.currentPunch.shift.start}-${state.currentPunch.shift.end}`;
    clockBtn.textContent = "Clock Out";
    clockBtn.classList.add("is-clockedin");
  } else {
    statusLabel.textContent = "Not clocked in";
    statusSub.textContent = "";
    clockBtn.textContent = "Clock In";
    clockBtn.classList.remove("is-clockedin");
  }

  const { balance, earned, spent } = monthlyBalance();
  document.getElementById("home-points-balance").textContent = balance;
  document.getElementById("home-points-sub").textContent = `${earned} earned − ${spent} spent this month`;
}

// ---------- render: history (Monthly Attendance) ----------

function renderHistory() {
  const tbody = document.getElementById("history-table-body");
  tbody.innerHTML = "";

  const sorted = [...state.punches].sort((a, b) => new Date(a.clockInISO) - new Date(b.clockInISO));

  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="list-empty">No shifts logged yet</td></tr>`;
    return;
  }

  for (const p of sorted) {
    const tr = document.createElement("tr");
    tr.dataset.punchId = p.id;
    const edited = p.editedFields || [];
    const inCellClass = edited.includes("clockIn") ? "cell-edited" : "";
    const outCellClass = edited.includes("clockOut") ? "cell-edited" : "";
    tr.innerHTML = `
      <td class="${inCellClass}">${formatDate(new Date(p.clockInISO))} ${formatTime(new Date(p.clockInISO))}</td>
      <td class="${outCellClass}">${formatDate(new Date(p.clockOutISO))} ${formatTime(new Date(p.clockOutISO))}</td>
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

// ---------- render: cafeteria ----------

function renderCafeteria() {
  const { balance, earned, spent } = monthlyBalance();
  document.getElementById("cafeteria-balance").textContent = balance;
  document.getElementById("cafeteria-balance-sub").textContent = `${earned} earned − ${spent} spent (resets next month)`;

  const list = document.getElementById("cafeteria-list");
  list.innerHTML = "";
  const sorted = [...state.cafeteriaSpending].sort((a, b) => new Date(b.timestampISO) - new Date(a.timestampISO));

  if (!sorted.length) {
    list.innerHTML = `<li class="list-empty">No spending logged yet</li>`;
    return;
  }

  for (const s of sorted) {
    const li = document.createElement("li");
    li.className = "list-item";
    const d = new Date(s.timestampISO);
    li.innerHTML = `
      <div class="list-item-row"><span>${formatDate(d)} ${formatTime(d)}</span><span>-${s.pointsSpent} pts</span></div>
      ${s.note ? `<p class="list-item-sub">${s.note}</p>` : ""}
    `;
    list.appendChild(li);
  }
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
  document.getElementById("remind-points-toggle").checked = !!state.settings.remindPointsOnClockOut;
  document.getElementById("theme-select").value = state.settings.theme || "system";
  document.getElementById("monthly-hours-goal").value = state.settings.monthlyHoursGoal || "";
  document.getElementById("signed-in-as").textContent = currentUid ? `Signed in as: ${currentUserLabel}` : "";
}

document.getElementById("monthly-hours-goal").addEventListener("change", (e) => {
  state.settings.monthlyHoursGoal = Number(e.target.value) || 0;
  saveState();
});

document.getElementById("remind-points-toggle").addEventListener("change", (e) => {
  state.settings.remindPointsOnClockOut = e.target.checked;
  saveState();
});

document.getElementById("theme-select").addEventListener("change", (e) => {
  state.settings.theme = e.target.value;
  saveState();
  applyTheme();
});

document.getElementById("btn-logout").addEventListener("click", handleLogout);

// ---------- "More": monthly summary + manual shift entry ----------

function toDatetimeLocalValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function computeMoreStats(referenceDate = new Date()) {
  const weekStart = startOfWeek(referenceDate);
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

function exportMonthToXlsx(monthPunches) {
  if (typeof XLSX === "undefined") {
    alert("Export library didn't load — check your internet connection and try again.");
    return;
  }
  const rows = monthExportRows(monthPunches);
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Attendance");
  const monthName = new Date().toLocaleDateString([], { year: "numeric", month: "2-digit" });
  XLSX.writeFile(workbook, `attendance-${monthName}.xlsx`);
}

function exportMonthToPdf(monthPunches) {
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
  const monthName = new Date().toLocaleDateString([], { year: "numeric", month: "2-digit" });
  doc.save(`attendance-${monthName}.pdf`);
}

function openMoreModal() {
  openModal("More");
  const s = computeMoreStats();
  const goal = state.settings.monthlyHoursGoal || 0;

  const summary = document.createElement("div");
  let goalLine = "";
  if (goal > 0) {
    const pct = Math.min(100, Math.round((s.monthHours / goal) * 100));
    goalLine = `<p>Monthly hours goal: <strong>${pct}%</strong> of ${goal}h (${s.monthHours.toFixed(1)}h so far)</p>`;
  }
  summary.innerHTML = `
    <p class="card-title">This week</p>
    <p>${s.weekHours.toFixed(1)}h · ${formatILS(s.weekPay)}</p>
    <p class="card-title">This month</p>
    <p>${s.monthHours.toFixed(1)}h · ${formatILS(s.monthPay)} · ${s.monthShiftCount} actual shifts</p>
    ${goalLine}
    <p class="card-title">Averages this month</p>
    <p>${s.avgHoursPerShift.toFixed(1)}h/shift · ${formatILS(s.avgPayPerShift)}/shift · ${formatILS(s.avgHourlyPay)}/h effective</p>
    <p class="card-title">Luba points this month</p>
    <p>${s.lubaEarned} earned − ${s.lubaSpent} spent = ${s.lubaBalance} balance</p>
    <p>Used: ${s.countByType.meat} בשרי (${s.spentByType.meat} pts) · ${s.countByType.dairy} חלבי (${s.spentByType.dairy} pts)${s.countByType.manual ? ` · ${s.countByType.manual} manual (${s.spentByType.manual} pts)` : ""}</p>
  `;
  modalBody.appendChild(summary);

  const exportRow = document.createElement("div");
  exportRow.style.display = "flex";
  exportRow.style.gap = "10px";
  const exportXlsxBtn = document.createElement("button");
  exportXlsxBtn.className = "secondary-button";
  exportXlsxBtn.textContent = "Export Excel";
  exportXlsxBtn.style.marginBottom = "0";
  exportXlsxBtn.addEventListener("click", () => exportMonthToXlsx(s.monthPunches));
  const exportPdfBtn = document.createElement("button");
  exportPdfBtn.className = "secondary-button";
  exportPdfBtn.textContent = "Export PDF";
  exportPdfBtn.style.marginBottom = "0";
  exportPdfBtn.addEventListener("click", () => exportMonthToPdf(s.monthPunches));
  exportRow.append(exportXlsxBtn, exportPdfBtn);
  modalBody.appendChild(exportRow);

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
    const { punch } = buildPunch(clockInDate, clockOutDate, shift, pickedShift);
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

    const changedFields = [];
    if (clockInDate.getTime() !== new Date(punch.clockInISO).getTime()) changedFields.push("clockIn");
    if (clockOutDate.getTime() !== new Date(punch.clockOutISO).getTime()) changedFields.push("clockOut");

    // Keep the shift's original start fixed (same eligibility rule as everywhere else);
    // only the actual end gets re-matched (or re-asked) against the edited clock-out time.
    const [originalStart, originalEnd] = punch.shiftLabel.split("-");
    const pseudoShift = { start: originalStart, end: originalEnd, points: punch.mealPoints, vouchers: punch.voucherNote };
    closeModal();
    const shift = await resolveActualShift(pseudoShift, clockOutDate);
    const { punch: recalculated } = buildPunch(clockInDate, clockOutDate, shift, pseudoShift);

    const priorEditedFields = punch.editedFields || [];
    const editedFields = [...new Set([...priorEditedFields, ...changedFields])];
    Object.assign(punch, recalculated, { id: punch.id, editedFields });
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

// ---------- pay breakdown ----------

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
      ["+10% פריון bonus", pay.productivityBonusApplied ? "Applied" : "Not applied"],
    ];
    if (pay.idfBonusPercent) {
      rows.push([`+${pay.idfBonusPercent}% צה"ל bonus`, "Applied"]);
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
