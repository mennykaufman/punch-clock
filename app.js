import { SHIFT_CATALOG, matchShiftByClockIn, matchShiftByActualEnd } from "./data/shifts.js";
import { calculatePay, isProductivityBonusEligible } from "./data/payRules.js";
import { fetchUserData, saveUserData, subscribeToUserData } from "./data/cloud.js";

const SESSION_KEY = "punchclock_session_v1"; // { employeeId, pin }

function defaultState(pin) {
  return {
    pin,
    settings: {
      employmentStartDate: "",
      remindPointsOnClockOut: true,
    },
    currentPunch: null, // { clockInISO, shift: {start,end,vouchers,points} }
    punches: [], // completed punches
    cafeteriaSpending: [], // { id, timestampISO, pointsSpent, note }
  };
}

function localCacheKey(employeeId) {
  return `punchclock_state_${employeeId}`;
}

function loadLocalCache(employeeId) {
  const raw = localStorage.getItem(localCacheKey(employeeId));
  return raw ? JSON.parse(raw) : null;
}

function saveLocalCache(employeeId, data) {
  localStorage.setItem(localCacheKey(employeeId), JSON.stringify(data));
}

function getSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
}

function setSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

let session = null; // { employeeId, pin }
let state = null;
let unsubscribeCloud = null;
let applyingRemoteUpdate = false;

function saveState() {
  if (!session) return;
  saveLocalCache(session.employeeId, state);
  if (!applyingRemoteUpdate) {
    saveUserData(session.employeeId, state).catch((err) => {
      console.error("cloud save failed:", err);
      // Offline: Firestore's own local cache queues this write and retries
      // automatically once the connection comes back, so nothing else to do here.
    });
  }
}

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

// ---------- auth / session ----------

const loginScreen = document.getElementById("login-screen");
const appShell = document.getElementById("app-shell");
const loginEmployeeId = document.getElementById("login-employee-id");
const loginPin = document.getElementById("login-pin");
const loginError = document.getElementById("login-error");
const btnLogin = document.getElementById("btn-login");

function showLoginScreen() {
  loginScreen.hidden = false;
  appShell.hidden = true;
}

function showAppShell() {
  loginScreen.hidden = true;
  appShell.hidden = false;
}

// Subscribes to this employee's cloud document so changes made on any other
// device show up here automatically too.
function startCloudSync(employeeId) {
  if (unsubscribeCloud) unsubscribeCloud();
  unsubscribeCloud = subscribeToUserData(employeeId, (data) => {
    applyingRemoteUpdate = true;
    state = data;
    saveLocalCache(employeeId, state);
    renderHome();
    renderHistory();
    renderCafeteria();
    renderSettings();
    applyingRemoteUpdate = false;
  });
}

async function handleLogin() {
  const employeeId = loginEmployeeId.value.trim();
  const pin = loginPin.value.trim();
  loginError.textContent = "";

  if (!employeeId || !pin) {
    loginError.textContent = "Enter both your Work ID and PIN.";
    return;
  }

  btnLogin.disabled = true;
  btnLogin.textContent = "Checking…";
  try {
    const existing = await fetchUserData(employeeId);

    if (existing) {
      if (existing.pin !== pin) {
        loginError.textContent = "Wrong PIN for this Work ID.";
        return;
      }
      state = existing;
    } else {
      state = defaultState(pin);
      await saveUserData(employeeId, state);
    }

    session = { employeeId, pin };
    setSession(session);
    saveLocalCache(employeeId, state);
    startCloudSync(employeeId);
    showAppShell();
    renderHome();
  } catch (err) {
    console.error("login failed:", err);
    loginError.textContent = "Couldn't reach the server — check your internet connection and try again.";
  } finally {
    btnLogin.disabled = false;
    btnLogin.textContent = "Continue";
  }
}

btnLogin.addEventListener("click", handleLogin);

function handleLogout() {
  if (unsubscribeCloud) unsubscribeCloud();
  unsubscribeCloud = null;
  clearSession();
  session = null;
  state = null;
  loginEmployeeId.value = "";
  loginPin.value = "";
  loginError.textContent = "";
  showLoginScreen();
}

function boot() {
  session = getSession();
  if (!session) {
    showLoginScreen();
    return;
  }
  const cached = loadLocalCache(session.employeeId);
  state = cached || defaultState(session.pin);
  showAppShell();
  renderHome();
  startCloudSync(session.employeeId);
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
const TITLES = { home: "Home", history: "History", cafeteria: "Luba", settings: "Settings" };

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
      openModal(`Shift starting ${match.start} — which end time?`);
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

async function handleClockOut() {
  const clockOutDate = new Date();
  const clockInDate = new Date(state.currentPunch.clockInISO);
  const pickedShift = state.currentPunch.shift;

  // The shift picked at clock-in fixes the start, but if the actual clock-out ran
  // longer or shorter than expected, switch to whichever catalog row (same start)
  // actually matches reality, so Luba points/vouchers reflect the real shift.
  const betterMatch = matchShiftByActualEnd(pickedShift.start, clockOutDate);
  const shift = betterMatch || pickedShift;

  const eligible = isProductivityBonusEligible(state.settings.employmentStartDate, clockOutDate);
  const pay = calculatePay(clockInDate, clockOutDate, { productivityBonusEligible: eligible });

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
  };

  state.punches.push(punch);
  state.currentPunch = null;
  saveState();
  renderHome();

  showClockOutSummary(punch, pay);
}

function showClockOutSummary(punch, pay) {
  openModal("Shift complete");
  const body = document.createElement("div");
  body.innerHTML = `
    <p><strong>${punch.actualHours}h</strong> worked (${punch.shiftLabel})</p>
    <p>Pay: <strong>${formatILS(punch.payILS)}</strong>${pay.productivityBonusApplied ? " (incl. +10% פריון)" : ""}</p>
    <p>Luba points earned: <strong>${punch.mealPoints}</strong> (${punch.voucherNote})</p>
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

  const pointsInput = document.createElement("input");
  pointsInput.className = "field-input";
  pointsInput.type = "number";
  pointsInput.min = "0";
  pointsInput.placeholder = "Points spent";
  modalBody.appendChild(pointsInput);

  const noteInput = document.createElement("input");
  noteInput.className = "field-input";
  noteInput.type = "text";
  noteInput.placeholder = "Note (optional)";
  modalBody.appendChild(noteInput);

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn-primary";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", async () => {
    const pointsSpent = parseInt(pointsInput.value, 10);
    if (!pointsSpent || pointsSpent <= 0) return;
    const entry = {
      id: uid(),
      timestampISO: new Date().toISOString(),
      pointsSpent,
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

// ---------- render: history ----------

function renderHistory() {
  const now = new Date();
  const weekStart = startOfWeek(now);
  const weekPunches = state.punches.filter((p) => new Date(p.clockInISO) >= weekStart);
  const monthPunches = state.punches.filter((p) => sameMonth(new Date(p.clockInISO), now));

  const sum = (arr, key) => arr.reduce((s, p) => s + p[key], 0);

  document.getElementById("week-hours").textContent = `${sum(weekPunches, "actualHours").toFixed(1)}h`;
  document.getElementById("week-pay").textContent = formatILS(sum(weekPunches, "payILS"));
  document.getElementById("month-hours").textContent = `${sum(monthPunches, "actualHours").toFixed(1)}h`;
  document.getElementById("month-pay").textContent = formatILS(sum(monthPunches, "payILS"));

  const list = document.getElementById("history-list");
  list.innerHTML = "";
  const sorted = [...state.punches].sort((a, b) => new Date(b.clockInISO) - new Date(a.clockInISO));

  if (!sorted.length) {
    list.innerHTML = `<li class="list-empty">No shifts logged yet</li>`;
    return;
  }

  for (const p of sorted) {
    const li = document.createElement("li");
    li.className = "list-item";
    li.innerHTML = `
      <p class="list-item-title">${formatDate(new Date(p.clockInISO))} · ${p.shiftLabel}</p>
      <div class="list-item-row"><span>${p.actualHours}h worked</span><span>${formatILS(p.payILS)}</span></div>
      <div class="list-item-row list-item-sub"><span>${p.voucherNote}</span><span>${p.mealPoints} pts</span></div>
    `;
    list.appendChild(li);
  }
}

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

function renderSettings() {
  document.getElementById("employment-start-date").value = state.settings.employmentStartDate || "";
  document.getElementById("remind-points-toggle").checked = !!state.settings.remindPointsOnClockOut;

  const hint = document.getElementById("bonus-eligibility-hint");
  if (!state.settings.employmentStartDate) {
    hint.textContent = "Set your start date to auto-apply the 10% פריון bonus after 3 months.";
  } else {
    const eligible = isProductivityBonusEligible(state.settings.employmentStartDate);
    hint.textContent = eligible
      ? "Eligible for the 10% פריון bonus ✓"
      : "Not yet eligible — applies automatically 3 months after your start date.";
  }

  document.getElementById("signed-in-as").textContent = session ? `Signed in as: ${session.employeeId}` : "";
}

document.getElementById("employment-start-date").addEventListener("change", (e) => {
  state.settings.employmentStartDate = e.target.value;
  saveState();
  renderSettings();
});

document.getElementById("remind-points-toggle").addEventListener("change", (e) => {
  state.settings.remindPointsOnClockOut = e.target.checked;
  saveState();
});

document.getElementById("btn-logout").addEventListener("click", handleLogout);

// ---------- init ----------

boot();
