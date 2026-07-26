import { SHIFT_CATALOG, matchShiftByClockIn, matchShiftByActualEnd } from "./data/shifts.js";
import { calculatePay, isProductivityBonusEligible } from "./data/payRules.js";
import { fetchUserData, saveUserData, subscribeToUserData } from "./data/cloud.js";

const SESSION_KEY = "punchclock_session_v1"; // { employeeId, pin }

function defaultState(pin, employmentStartDate = "") {
  return {
    pin,
    seq: 0, // bumped on every local save so a late/out-of-order cloud snapshot can never clobber a newer local change
    settings: {
      employmentStartDate,
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
  if (!applyingRemoteUpdate) state.seq = (state.seq || 0) + 1;
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
const loginEmploymentStartDate = document.getElementById("login-employment-start-date");
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
    // A snapshot can arrive late/out-of-order relative to our own rapid local
    // writes (e.g. clock-in immediately followed by an edit); only accept it
    // if it isn't older than what we already have, so it can never clobber a
    // newer local change with stale data (from this device or another one).
    if ((data.seq || 0) < (state?.seq || 0)) return;

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
      // Employment start date only matters the first time an account is created —
      // existing accounts keep whatever they already have, ignoring this field.
      state = defaultState(pin, loginEmploymentStartDate.value);
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
  loginEmploymentStartDate.value = "";
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

// Shared by live clock-out and the manual "More" entry form: given real (or manually
// entered) clock-in/out times and the originally picked shift, auto-corrects the shift
// match against the actual end time and computes pay. Returns everything needed to
// save a punch record and report whether Luba points shifted up or down as a result.
function buildPunch(clockInDate, clockOutDate, pickedShift) {
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
    payBreakdown: pay,
    edited: false,
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

  const { punch, pay, pointsDelta } = buildPunch(clockInDate, clockOutDate, pickedShift);

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

// ---------- render: history (Monthly Attendance) ----------

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

  const tbody = document.getElementById("history-table-body");
  tbody.innerHTML = "";

  const sorted = [...state.punches].sort((a, b) => new Date(a.clockInISO) - new Date(b.clockInISO));

  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="list-empty">No shifts logged yet</td></tr>`;
    return;
  }

  let runningHours = 0;
  let runningPay = 0;
  for (const p of sorted) {
    runningHours += p.actualHours;
    runningPay += p.payILS;
    const tr = document.createElement("tr");
    if (p.edited) tr.classList.add("row-edited");
    tr.innerHTML = `
      <td>${formatDate(new Date(p.clockInISO))}</td>
      <td>${formatTime(new Date(p.clockInISO))}</td>
      <td>${formatTime(new Date(p.clockOutISO))}</td>
      <td>${p.actualHours}h</td>
      <td class="pay-cell" data-punch-id="${p.id}">${formatILS(p.payILS)}</td>
      <td>${p.mealPoints}</td>
      <td>${runningHours.toFixed(1)}h</td>
      <td>${formatILS(runningPay)}</td>
      <td><button class="edit-btn" type="button" data-punch-id="${p.id}">Edit</button></td>
    `;
    tbody.appendChild(tr);
  }
}

document.getElementById("history-table-body").addEventListener("click", (e) => {
  const punchId = e.target.dataset.punchId;
  if (!punchId) return;
  const punch = state.punches.find((p) => p.id === punchId);
  if (!punch) return;
  if (e.target.classList.contains("edit-btn")) openEditPunchModal(punch);
  if (e.target.classList.contains("pay-cell")) openPayBreakdownModal(punch);
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

function renderSettings() {
  document.getElementById("remind-points-toggle").checked = !!state.settings.remindPointsOnClockOut;
  document.getElementById("signed-in-as").textContent = session ? `Signed in as: ${session.employeeId}` : "";
}

document.getElementById("remind-points-toggle").addEventListener("change", (e) => {
  state.settings.remindPointsOnClockOut = e.target.checked;
  saveState();
});

document.getElementById("btn-logout").addEventListener("click", handleLogout);

// ---------- manual shift entry ("More" on Monthly Attendance) ----------

function toDatetimeLocalValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

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
    const shift = await resolveShiftForClockIn(clockInDate);
    if (!shift) return; // user cancelled the shift picker

    const { punch } = buildPunch(clockInDate, clockOutDate, shift);
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

document.getElementById("btn-open-more").addEventListener("click", openManualEntryModal);

// ---------- edit an existing punch ----------

function openEditPunchModal(punch) {
  openModal("Edit shift");

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
  saveBtn.addEventListener("click", () => {
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

    // Keep the shift's original start fixed (same eligibility rule as everywhere else);
    // only the actual end gets re-matched against the edited clock-out time.
    const [originalStart, originalEnd] = punch.shiftLabel.split("-");
    const pseudoShift = { start: originalStart, end: originalEnd, points: punch.mealPoints, vouchers: punch.voucherNote };
    const { punch: recalculated } = buildPunch(clockInDate, clockOutDate, pseudoShift);

    Object.assign(punch, recalculated, { id: punch.id, edited: true });
    saveState();
    closeModal();
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

  if (!pay) {
    modalBody.innerHTML = `<p class="field-hint">Breakdown not available for this entry.</p>`;
  } else {
    const h = pay.hoursByCategory;
    modalBody.innerHTML = `
      <p>Day: <strong>${h.day}h</strong> · Evening: <strong>${h.evening}h</strong> · Night: <strong>${h.night}h</strong> · Shabbat: <strong>${h.shabbat}h</strong></p>
      <p>Overtime hours: <strong>${pay.overtimeHours}h</strong>${pay.nightFlipTriggered ? " (night-rate shift)" : ""}</p>
      <p>Before bonus: <strong>${formatILS(pay.preBonusPayILS)}</strong></p>
      <p>+10% פריון bonus: <strong>${pay.productivityBonusApplied ? "Applied" : "Not applied"}</strong></p>
      <p>Final pay: <strong>${formatILS(pay.finalPayILS)}</strong></p>
    `;
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn-primary";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeModal);
  modalActions.appendChild(closeBtn);
}

// ---------- init ----------

boot();
